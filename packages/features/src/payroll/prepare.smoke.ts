/**
 * Smoke: the missed-run net in payroll.prepare's cron skip branch. A
 * worker down over the Sunday 20:30 tick used to resurface Monday as a
 * quiet "skipped" (periodContaining(today).end !== today) and payday
 * silently did not happen. The decision is a pure function
 * (recentlyEndedPeriod) plus an injectable ledger counter
 * (checkMissedRun), so every branch runs offline with no db.
 * Run: npm run smoke:payrollprepare (from packages/features).
 */
import assert from "node:assert/strict";

import {
  checkMissedRun,
  MISSED_RUN_GRACE_DAYS,
  recentlyEndedPeriod,
} from "./prepare.js";

// Anchor-aligned calendar (policy 6): 2026-08-03..2026-08-16, then
// 2026-08-17..2026-08-30. 2026-08-16 is the first period-end Sunday.

function testCandidateWindow(): void {
  // Monday through Wednesday after a missed Sunday end: candidate.
  for (const today of ["2026-08-17", "2026-08-18", "2026-08-19"]) {
    const candidate = recentlyEndedPeriod(today);
    assert.equal(candidate?.label, "2026-08-03..2026-08-16", today);
  }
  // Day 4 past the end: beyond the grace window, quiet.
  assert.equal(recentlyEndedPeriod("2026-08-20"), null);
  // A period-end Sunday itself: the normal run handles it, never a miss.
  assert.equal(recentlyEndedPeriod("2026-08-16"), null);
  assert.equal(recentlyEndedPeriod("2026-08-30"), null);
  // Ordinary mid-period days (including the off-Sunday tick a week
  // after the end): quiet.
  assert.equal(recentlyEndedPeriod("2026-08-23"), null);
  assert.equal(recentlyEndedPeriod("2026-08-27"), null);
  // Inside the FIRST automated period there is nothing before it to
  // have missed.
  assert.equal(recentlyEndedPeriod("2026-08-10"), null);
  // The straddling boundary from policy 6: Monday 2026-08-31 follows
  // the 2026-08-17..2026-08-30 end.
  assert.equal(
    recentlyEndedPeriod("2026-08-31")?.label,
    "2026-08-17..2026-08-30",
  );
  // Grace is configurable; the default is 3 days.
  assert.equal(MISSED_RUN_GRACE_DAYS, 3);
  assert.equal(recentlyEndedPeriod("2026-08-20", 4)?.label, "2026-08-03..2026-08-16");
  console.log("[smoke] prepare: missed-run candidate window is exact");
}

async function testMissedRunDecision(): Promise<void> {
  // Monday after a missed Sunday, ZERO ledger rows for the ended
  // period: MISSED, alert fires (the caller pages on non-null).
  const asked: string[] = [];
  const missed = await checkMissedRun({
    today: "2026-08-17",
    countForPeriod: async (label) => {
      asked.push(label);
      return 0;
    },
  });
  assert.equal(missed?.label, "2026-08-03..2026-08-16");
  assert.deepEqual(asked, ["2026-08-03..2026-08-16"]);

  // Same Monday but the ledger HAS invoices: the run happened (filed,
  // or blocked-then-refired); quiet.
  const filed = await checkMissedRun({
    today: "2026-08-17",
    countForPeriod: async () => 18,
  });
  assert.equal(filed, null);

  // No recently-ended period: the ledger is never even queried.
  let queried = 0;
  const ordinary = await checkMissedRun({
    today: "2026-08-23",
    countForPeriod: async () => {
      queried += 1;
      return 0;
    },
  });
  assert.equal(ordinary, null);
  assert.equal(queried, 0);

  // A failing ledger counter propagates: the caller's catch-all alerts
  // and rethrows; a db outage must never degrade into a quiet skip.
  await assert.rejects(
    () =>
      checkMissedRun({
        today: "2026-08-17",
        countForPeriod: async () => {
          throw new Error("db down");
        },
      }),
    /db down/,
  );
  console.log("[smoke] prepare: missed-run decision pages only a fresh unfiled period");
}

async function main(): Promise<void> {
  testCandidateWindow();
  await testMissedRunDecision();
  console.log("[smoke] prepare: all passed");
}

await main();
