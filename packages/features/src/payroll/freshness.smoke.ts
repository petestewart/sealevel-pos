/**
 * Smoke: SEA-112 — the freshness gate (policy §6 step 4), the only guard
 * against permanently shorting Sunday classes. checkFreshness runs one
 * SQL aggregate through the analytics seam; here the seam is a local fake
 * injected as checkFreshness's pageSelectImpl parameter, so every branch
 * runs offline (no MCP server touched). A stale mirror is
 * indistinguishable from a light teaching day, so BOTH must block, and
 * because the mirror carries future-dated schedule rows, the gate must
 * demand ATTENDANCE-shaped evidence (attended Sunday visits), never mere
 * schedule presence.
 * Run: npm run smoke:payrollfreshness (from packages/features).
 */
import assert from "node:assert/strict";

import { pageSelect, periodContaining } from "@ai-manager/core";
import { checkFreshness } from "./reads.js";

/** The first automated period: 2026-08-03 .. 2026-08-16 (end is a Sunday). */
const PERIOD = periodContaining("2026-08-03");

/** Fake analytics seam: records the SQL it was handed and yields the
 * scripted rows as a single page, like a bare aggregate would return. */
function fakeSeam(rows: Array<Record<string, unknown>>): {
  impl: typeof pageSelect;
  queries: string[];
} {
  const queries: string[] = [];
  const impl = async function* (select: string) {
    queries.push(select);
    if (rows.length > 0) yield rows;
  } as typeof pageSelect;
  return { impl, queries };
}

async function testFresh(): Promise<void> {
  // Attendance-landed mirror: sees past the period end, the final Sunday's
  // classes are present, AND attended visits exist for them (the
  // post-classes sync landed). This is the only shape that passes.
  const seam = fakeSeam([
    { max_date: "2026-08-18", sunday_classes: 4, sunday_attended: 37 },
  ]);
  const result = await checkFreshness(PERIOD, seam.impl);
  assert.equal(result.fresh, true);
  assert.equal(result.maxClassDate, "2026-08-18");
  assert.equal(result.finalSundayClasses, 4);
  assert.equal(result.finalSundayAttended, 37);
  // The query must be counting the PERIOD's final Sunday, and must read
  // the visits table (the attendance evidence, not just the schedule).
  assert.equal(seam.queries.length, 1);
  assert.ok(seam.queries[0]?.includes(`'${PERIOD.end}'`));
  assert.ok(/FROM visits/i.test(seam.queries[0] ?? ""));
  assert.ok(/attended/i.test(seam.queries[0] ?? ""));
  console.log("[smoke] freshness: attendance-landed mirror is fresh");
}

async function testBookingShapedMirrorBlocks(): Promise<void> {
  // THE Finding-1 case: booking-shaped morning data. The forward-window
  // sync already wrote tonight's classes as class_instances rows, so
  // max_date is past the period end and the Sunday's classes are
  // "present" — but ZERO attended visits exist for them, because no
  // post-classes sync has landed (e.g. ANALYTICS_SYNC_GH_TOKEN unset and
  // the run is reading the 2:30am nightly's data). MUST block: invoicing
  // this data misses afternoon cancellations and sub swaps.
  const seam = fakeSeam([
    { max_date: "2026-08-20", sunday_classes: 5, sunday_attended: 0 },
  ]);
  const result = await checkFreshness(PERIOD, seam.impl);
  assert.equal(result.fresh, false);
  assert.equal(result.maxClassDate, "2026-08-20");
  assert.equal(result.finalSundayClasses, 5);
  assert.equal(result.finalSundayAttended, 0);
  console.log(
    "[smoke] freshness: booking-shaped mirror (future rows, Sunday scheduled, zero attended) blocks",
  );
}

async function testStaleMirrorBlocks(): Promise<void> {
  // max_date short of the period end: the sync has not landed. Blocks.
  const seam = fakeSeam([
    { max_date: "2026-08-15", sunday_classes: 0, sunday_attended: 0 },
  ]);
  const result = await checkFreshness(PERIOD, seam.impl);
  assert.equal(result.fresh, false);
  // Diagnostics feed the blocker message; they must be the real values.
  assert.equal(result.maxClassDate, "2026-08-15");
  assert.equal(result.finalSundayClasses, 0);
  assert.equal(result.finalSundayAttended, 0);
  console.log("[smoke] freshness: stale mirror blocks");
}

async function testSundayMissingBlocks(): Promise<void> {
  // Mirror looks current (forward-window rows past the end) but the final
  // Sunday has ZERO classes: indistinguishable from a stale sync, blocks.
  const seam = fakeSeam([
    { max_date: "2026-08-20", sunday_classes: 0, sunday_attended: 0 },
  ]);
  const result = await checkFreshness(PERIOD, seam.impl);
  assert.equal(result.fresh, false);
  assert.equal(result.maxClassDate, "2026-08-20");
  assert.equal(result.finalSundayClasses, 0);
  console.log("[smoke] freshness: current-looking mirror with no Sunday classes blocks");
}

async function testAttendedWithoutScheduleBlocks(): Promise<void> {
  // Belt and braces: attended visits reported but zero Sunday classes is
  // an inconsistent mirror; every check must hold, so it still blocks.
  const seam = fakeSeam([
    { max_date: "2026-08-16", sunday_classes: 0, sunday_attended: 12 },
  ]);
  const result = await checkFreshness(PERIOD, seam.impl);
  assert.equal(result.fresh, false);
  console.log("[smoke] freshness: attended visits without Sunday classes still blocks");
}

async function testEmptyMirrorBlocks(): Promise<void> {
  // A bare aggregate over an empty table returns one all-NULL row.
  const nullRow = await checkFreshness(
    PERIOD,
    fakeSeam([{ max_date: null, sunday_classes: null, sunday_attended: null }])
      .impl,
  );
  assert.equal(nullRow.fresh, false);
  assert.equal(nullRow.maxClassDate, null);
  assert.equal(nullRow.finalSundayClasses, 0);
  assert.equal(nullRow.finalSundayAttended, 0);
  // And belt-and-braces: a seam yielding no rows at all must also block.
  const noRows = await checkFreshness(PERIOD, fakeSeam([]).impl);
  assert.equal(noRows.fresh, false);
  assert.equal(noRows.maxClassDate, null);
  assert.equal(noRows.finalSundayClasses, 0);
  assert.equal(noRows.finalSundayAttended, 0);
  console.log("[smoke] freshness: empty/NULL mirror blocks with null diagnostics");
}

async function testExactBoundaryIsFresh(): Promise<void> {
  // max_date exactly the period end (Sunday) with classes present and
  // attendance landed: fresh.
  const seam = fakeSeam([
    { max_date: PERIOD.end, sunday_classes: 5, sunday_attended: 41 },
  ]);
  const result = await checkFreshness(PERIOD, seam.impl);
  assert.equal(result.fresh, true);
  assert.equal(result.maxClassDate, PERIOD.end);
  assert.equal(result.finalSundayClasses, 5);
  assert.equal(result.finalSundayAttended, 41);
  console.log("[smoke] freshness: max_date exactly at period end is fresh");
}

async function main(): Promise<void> {
  assert.equal(PERIOD.end, "2026-08-16");
  await testFresh();
  await testBookingShapedMirrorBlocks();
  await testStaleMirrorBlocks();
  await testSundayMissingBlocks();
  await testAttendedWithoutScheduleBlocks();
  await testEmptyMirrorBlocks();
  await testExactBoundaryIsFresh();
  console.log("[smoke] freshness: all passed");
}

await main();
