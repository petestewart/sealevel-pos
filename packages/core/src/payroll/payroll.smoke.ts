/**
 * Smoke: pay-period math (policy §6) and the training-payback quota replay
 * (policy §13). Pure logic, no environment needed.
 * Run: npm run smoke:payroll (from packages/core)
 */
import assert from "node:assert/strict";

import {
  isInOpenPeriod,
  isPeriodClosed,
  nextPeriodStart,
  parsePeriodLabel,
  PAYROLL_ANCHOR,
  periodContaining,
} from "./period.js";
import { replayQuota, type QuotaClass } from "./quota.js";

function testPeriodMath(): void {
  // The anchor opens the first automated period.
  const first = periodContaining(PAYROLL_ANCHOR);
  assert.equal(first.label, "2026-08-03..2026-08-16");
  // Inclusive Sunday end; the next Monday rolls over.
  assert.equal(periodContaining("2026-08-16").label, "2026-08-03..2026-08-16");
  assert.equal(periodContaining("2026-08-17").label, "2026-08-17..2026-08-30");
  // The straddling period from policy §6.
  assert.equal(periodContaining("2026-09-01").label, "2026-08-31..2026-09-13");
  assert.equal(periodContaining("2026-08-31").label, "2026-08-31..2026-09-13");
  // Pre-anchor dates have no period.
  assert.throws(() => periodContaining("2026-08-02"), /predates the anchor/);
  console.log("[smoke] payroll: fortnightly periods align to the anchor");
}

function testPeriodLabels(): void {
  const period = parsePeriodLabel("2026-08-17..2026-08-30");
  assert.equal(period.start, "2026-08-17");
  assert.equal(period.end, "2026-08-30");
  // A label that is not anchor-aligned must fail loudly, never silently
  // define a new period.
  assert.throws(
    () => parsePeriodLabel("2026-08-04..2026-08-17"),
    /not an anchor-aligned period/,
  );
  assert.throws(() => parsePeriodLabel("2026-W32"), /malformed|not a YYYY/);
  console.log("[smoke] payroll: labels parse and misaligned ones are rejected");
}

function testEffectiveDateRules(): void {
  // Mid-period on 2026-08-11: the open period is 08-03..08-16, so the
  // default rate-change effective date is the next period start.
  assert.equal(nextPeriodStart("2026-08-11"), "2026-08-17");
  assert.equal(nextPeriodStart("2026-08-16"), "2026-08-17");
  assert.equal(nextPeriodStart("2026-08-17"), "2026-08-31");
  assert.equal(nextPeriodStart("2026-07-01"), PAYROLL_ANCHOR);
  // The form refuses effective dates inside the open period (policy §9).
  assert.equal(isInOpenPeriod("2026-08-12", "2026-08-11"), true);
  assert.equal(isInOpenPeriod("2026-08-17", "2026-08-11"), false);
  // A period is closed only once every day of it is past.
  const open = periodContaining("2026-08-03");
  assert.equal(isPeriodClosed(open, "2026-08-16"), false);
  assert.equal(isPeriodClosed(open, "2026-08-17"), true);
  console.log("[smoke] payroll: rate effective dates respect the open period");
}

const KATE = {
  freeClassesPerMonth: 3,
  obligationCents: 60_000,
  effectiveFrom: "2026-08-01",
};

function augustClasses(count: number, rate = 7500): QuotaClass[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-08-${String(4 + i).padStart(2, "0")}`,
    rateCents: rate,
  }));
}

function testQuotaBasics(): void {
  // Six classes in one month, quota three: first three chronologically are
  // free, the rest paid at full rate. The invoice arithmetic from §13:
  // 6 taught, 3 unpaid, 3 paid @ $75, total $225.
  const result = replayQuota(KATE, augustClasses(6));
  assert.deepEqual(
    result.classes.map((c) => c.free),
    [true, true, true, false, false, false],
  );
  const totalPaid = result.classes.reduce((sum, c) => sum + c.paidCents, 0);
  assert.equal(totalPaid, 22_500);
  assert.equal(result.remainingCents, 60_000 - 22_500);
  assert.equal(result.paidOffOn, null);
  console.log("[smoke] payroll: quota frees the first N classes per month");
}

function testQuotaNoRollover(): void {
  // Two classes in August (one unused free class vanishes), then September
  // gets a fresh quota of three.
  const classes = [
    ...augustClasses(2),
    { date: "2026-09-01", rateCents: 7500 },
    { date: "2026-09-02", rateCents: 7500 },
    { date: "2026-09-03", rateCents: 7500 },
    { date: "2026-09-04", rateCents: 7500 },
  ];
  const result = replayQuota(KATE, classes);
  assert.deepEqual(
    result.classes.map((c) => c.free),
    [true, true, true, true, true, false],
  );
  console.log("[smoke] payroll: no rollover across calendar months");
}

function testQuotaTail(): void {
  // Two credits remain, quota three: only two classes free, third paid
  // (the both-conditions rule from §13).
  const twoLeft = { ...KATE, obligationCents: 15_000 };
  const exact = replayQuota(twoLeft, augustClasses(3));
  assert.deepEqual(
    exact.classes.map((c) => c.free),
    [true, true, false],
  );
  assert.equal(exact.remainingCents, 0);
  assert.equal(exact.paidOffOn, "2026-08-05");

  // Partial tail: $40 remains, the class credits $40 and pays the $35 rest.
  const partial = replayQuota(
    { ...KATE, obligationCents: 4000 },
    augustClasses(2),
  );
  assert.equal(partial.classes[0]?.creditedCents, 4000);
  assert.equal(partial.classes[0]?.paidCents, 3500);
  assert.equal(partial.classes[0]?.free, true);
  assert.equal(partial.classes[1]?.paidCents, 7500);
  assert.equal(partial.remainingCents, 0);
  console.log("[smoke] payroll: quota tail credits partially, never rounds");
}

function testQuotaGuards(): void {
  // Pre-arrangement classes must never enter the replay: the starting
  // balance already accounts for them (policy §13 open question).
  assert.throws(
    () =>
      replayQuota(KATE, [{ date: "2026-07-31", rateCents: 7500 }]),
    /predates effective_from/,
  );
  // Rate changes move the class count, not the dollar balance: at $80 a
  // $60,000 obligation is worked off in fewer classes.
  const raised = replayQuota(
    { ...KATE, obligationCents: 16_000 },
    augustClasses(3, 8000),
  );
  assert.deepEqual(
    raised.classes.map((c) => c.free),
    [true, true, false],
  );
  console.log("[smoke] payroll: replay guards and dollar denomination hold");
}

function main(): void {
  testPeriodMath();
  testPeriodLabels();
  testEffectiveDateRules();
  testQuotaBasics();
  testQuotaNoRollover();
  testQuotaTail();
  testQuotaGuards();
  console.log("[smoke] payroll: all passed");
}

main();
