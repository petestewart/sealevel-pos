/**
 * Smoke: the payroll arithmetic (SEA-104), pure logic against policy
 * docs/payroll-policy.md. Run: npm run smoke:payrollcompute (from
 * packages/features).
 */
import assert from "node:assert/strict";

import { periodContaining, type PayRate } from "@ai-manager/core";
import { computePayroll, type TeacherPeriodInput } from "./compute.js";
import { collectQuotaInputs } from "./prepare.js";

const PERIOD = periodContaining("2026-08-03");

function rate(mbStaffId: number, rateCents: number): [number, PayRate] {
  return [
    mbStaffId,
    {
      id: String(mbStaffId),
      mb_staff_id: mbStaffId,
      teacher_display_name: null,
      rate_cents: rateCents,
      rate_basis: "per_class",
      effective_from: "2026-08-03",
      effective_to: null,
      notes: null,
      created_by: null,
      created_at: "",
    },
  ];
}

function classes(dates: string[]): TeacherPeriodInput["classes"] {
  return dates.map((date) => ({
    date,
    timeNorm: "17:00",
    classType: "Hot 26",
    attendeeCount: 12,
  }));
}

function testPlainInvoice(): void {
  const result = computePayroll({
    period: PERIOD,
    teachers: [
      { mbStaffId: 100000080, name: "Beth Gongaware", role: "staff",
        classes: classes(["2026-08-04", "2026-08-06", "2026-08-11"]) },
    ],
    rates: new Map([rate(100000080, 7500)]),
    quotas: new Map(),
  });
  assert.equal(result.blockers.length, 0);
  const inv = result.invoices[0];
  assert.equal(inv?.totalCents, 22_500);
  assert.equal(inv?.summary, "3 classes taught, paid at $75, total $225");
  console.log("[smoke] compute: plain per-class invoice (policy 1)");
}

function testBlockers(): void {
  const result = computePayroll({
    period: PERIOD,
    teachers: [
      { mbStaffId: null, name: "Sharon", role: "staff", classes: classes(["2026-08-04"]) },
      { mbStaffId: 100000999, name: "TBA", role: "tba", classes: classes(["2026-08-05"]) },
      { mbStaffId: 100000138, name: "Naomi Clark", role: "staff", classes: classes(["2026-08-11"]) },
      // No classes this period: never a blocker even without a rate.
      { mbStaffId: 100000555, name: "Idle Teacher", role: "staff", classes: [] },
    ],
    rates: new Map(),
    quotas: new Map(),
  });
  assert.deepEqual(
    result.blockers.map((b) => b.reason).sort(),
    ["no_rate", "null_mb_staff_id", "tba_identity"],
  );
  assert.equal(result.invoices.length, 0);
  console.log("[smoke] compute: policy 7 blockers (null id, TBA, no rate)");
}

function testZeroRateFilesNothing(): void {
  const result = computePayroll({
    period: PERIOD,
    teachers: [
      { mbStaffId: 100000138, name: "Naomi Clark", role: "staff",
        classes: classes(["2026-08-11"]) },
    ],
    rates: new Map([rate(100000138, 0)]),
    quotas: new Map(),
  });
  assert.equal(result.invoices.length, 0);
  assert.equal(result.zeroTotals[0]?.reason, "zero rate (unpaid by agreement)");
  console.log("[smoke] compute: zero rate reports, never invoices (policy 12)");
}

function testQuotaInvoice(): void {
  // Kate: 6 classes in the period, quota 3/month, obligation far from done.
  const dates = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-10", "2026-08-11", "2026-08-12"];
  const result = computePayroll({
    period: PERIOD,
    teachers: [
      { mbStaffId: 100000011, name: "Kate Jarvis", role: "staff", classes: classes(dates) },
    ],
    rates: new Map([rate(100000011, 7500)]),
    quotas: new Map([[100000011, {
      quota: {
        free_classes_per_month: 3,
        obligation_cents: 60_000,
        effective_from: "2026-08-01",
        effective_to: null,
      },
      historyClasses: dates.map((date) => ({ date, rateCents: 7500 })),
    }]]),
  });
  const inv = result.invoices[0];
  assert.equal(inv?.totalCents, 22_500);
  assert.equal(inv?.freeCount, 3);
  assert.equal(
    inv?.summary,
    "6 classes taught, 3 unpaid (training payback), 3 paid at $75, total $225",
  );
  assert.equal(inv?.quota?.creditedCents, 22_500);
  assert.equal(inv?.quota?.remainingCentsAfter, 60_000 - 22_500);
  console.log("[smoke] compute: quota invoice shows its arithmetic (policy 13)");
}

function testQuotaHistoryMismatchBlocks(): void {
  // The replay history disagreeing with the period read must fail the
  // run loudly, never produce a number from either. Since SEA-111 fix
  // 2d it is a BLOCKER (alert + nothing filed, the policy 7 path), not
  // a raw exception that pages nobody.
  const result = computePayroll({
    period: PERIOD,
    teachers: [
      { mbStaffId: 100000011, name: "Kate Jarvis", role: "staff",
        classes: classes(["2026-08-04", "2026-08-05"]) },
    ],
    rates: new Map([rate(100000011, 7500)]),
    quotas: new Map([[100000011, {
      quota: { free_classes_per_month: 3, obligation_cents: 60_000,
        effective_from: "2026-08-01", effective_to: null },
      historyClasses: [{ date: "2026-08-04", rateCents: 7500 }],
    }]]),
  });
  assert.equal(result.invoices.length, 0);
  assert.deepEqual(result.blockers, [
    { teacherName: "Kate Jarvis", reason: "quota_history_mismatch" },
  ]);
  console.log(
    "[smoke] compute: quota/period read disagreement blocks the run (SEA-111 2d)",
  );
}

async function testQuotaRateGapBlocks(): Promise<void> {
  // readQuotaHistory throws on a class no rate window covers; the
  // prepare-side wrap (collectQuotaInputs) must convert that throw into
  // a quota_rate_gap blocker so the run blocks with an alert instead of
  // dying as a raw exception (SEA-111 fix 2d).
  const teachers: TeacherPeriodInput[] = [
    { mbStaffId: 100000011, name: "Kate Jarvis", role: "staff",
      classes: classes(["2026-08-04"]) },
  ];
  const quota = {
    id: "1",
    mb_staff_id: 100000011,
    kind: "training_payback",
    free_classes_per_month: 3,
    obligation_cents: 60_000,
    effective_from: "2026-08-01",
    effective_to: null,
    notes: null,
  };
  const throwingRead = async (): Promise<never> => {
    throw new Error(
      "payroll: no rate covers 2026-08-01 for staff 100000011; extend the rate history to the arrangement start",
    );
  };
  const gapped = await collectQuotaInputs({
    quotas: [quota],
    teachers,
    period: PERIOD,
    rateHistory: [],
    readHistory: throwingRead,
  });
  assert.equal(gapped.quotaInputs.size, 0);
  assert.deepEqual(gapped.blockers, [
    { teacherName: "Kate Jarvis", reason: "quota_rate_gap" },
  ]);
  // A quota for a teacher with no classes this period still blocks
  // under the staff id (the replay is still untrustworthy).
  const unnamed = await collectQuotaInputs({
    quotas: [quota],
    teachers: [],
    period: PERIOD,
    rateHistory: [],
    readHistory: throwingRead,
  });
  assert.deepEqual(unnamed.blockers, [
    { teacherName: "staff 100000011", reason: "quota_rate_gap" },
  ]);
  // And the happy path stays intact: a working reader files no blocker.
  const clean = await collectQuotaInputs({
    quotas: [quota],
    teachers,
    period: PERIOD,
    rateHistory: [],
    readHistory: async () => [{ date: "2026-08-04", rateCents: 7500 }],
  });
  assert.equal(clean.blockers.length, 0);
  assert.equal(clean.quotaInputs.get(100000011)?.historyClasses.length, 1);
  console.log(
    "[smoke] compute: quota rate gap becomes a run blocker, not a raw throw (SEA-111 2d)",
  );
}

function testFullyConsumedPeriod(): void {
  // Quota covers every class: zero total, no item (policy 12 + 13).
  const result = computePayroll({
    period: PERIOD,
    teachers: [
      { mbStaffId: 100000011, name: "Kate Jarvis", role: "staff",
        classes: classes(["2026-08-04", "2026-08-05"]) },
    ],
    rates: new Map([rate(100000011, 7500)]),
    quotas: new Map([[100000011, {
      quota: { free_classes_per_month: 3, obligation_cents: 60_000,
        effective_from: "2026-08-01", effective_to: null },
      historyClasses: [
        { date: "2026-08-04", rateCents: 7500 },
        { date: "2026-08-05", rateCents: 7500 },
      ],
    }]]),
  });
  assert.equal(result.invoices.length, 0);
  assert.equal(result.zeroTotals[0]?.reason, "period fully covered by training payback");
  console.log("[smoke] compute: fully consumed period files nothing");
}

async function main(): Promise<void> {
  testPlainInvoice();
  testBlockers();
  testZeroRateFilesNothing();
  testQuotaInvoice();
  testQuotaHistoryMismatchBlocks();
  await testQuotaRateGapBlocks();
  testFullyConsumedPeriod();
  console.log("[smoke] compute: all passed");
}

await main();
