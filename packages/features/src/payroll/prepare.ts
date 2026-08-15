import {
  countPayrollInvoicesForPeriod,
  emitItemEvent,
  emitPayrollAlert,
  listPayRates,
  listUnpaidQuotas,
  parsePeriodLabel,
  PAYROLL_ANCHOR,
  periodContaining,
  ratesInEffectOn,
  filePayrollInvoice,
  studioToday,
  type Item,
  type Job,
  type JobContext,
  type PayPeriod,
  type PayRate,
  type UnpaidQuota,
} from "@ai-manager/core";

import {
  computePayroll,
  type QuotaInput,
  type RunBlocker,
  type TeacherPeriodInput,
} from "./compute.js";
import { checkFreshness, readPeriodTeachers, readQuotaHistory } from "./reads.js";
import { dispatchSyncAndWait } from "./sync.js";

/**
 * payroll.prepare (SEA-104): file one payroll_invoice approval item per
 * teacher for a closed fortnight, per docs/payroll-policy.md.
 *
 * The whole pipeline runs in preflight, deterministic code start to
 * finish: the sequence (period gate, on-demand sync, freshness gate,
 * seam reads, arithmetic, filing) has exactly one correct behavior, and
 * a model must never be in a position to invent a number that lands on
 * an invoice (every number traces to compute.ts, which traces to the
 * policy). The Job shape is still the right home: registration rides the
 * SEA-101 registerJobs path, the Sunday cron rides cronSchedulesFromJobs
 * with a tz pin, and manual fires ride the same queue name.
 *
 * Cadence (policy §6): fires 20:30 America/Los_Angeles every Sunday and
 * no-ops unless that Sunday is a period end (cron cannot say "every
 * other Sunday"). The payday-evening run works because the job first
 * dispatches the analytics sync over the period tail and verifies
 * freshness before computing anything; any failure blocks the run,
 * files nothing, and notifies. A late payroll is an annoyance; a payroll
 * missing Sunday classes is a payment error.
 */

/** Manual-fire payload: an explicit period label to (re-)prepare. */
export interface PayrollPreparePayload {
  period?: string;
}

interface PrepareOutcome {
  status: "skipped" | "blocked" | "filed";
  reason?: string;
  filed?: number;
  alreadyPrepared?: number;
}

function dollars(cents: number): string {
  return cents % 100 === 0
    ? `$${cents / 100}`
    : `$${(cents / 100).toFixed(2)}`;
}

/** Everything step 4's quota pass produces: the replay inputs for
 * computePayroll, plus any teacher whose quota data has a gap. */
export interface QuotaInputsResult {
  quotaInputs: Map<number, QuotaInput>;
  blockers: RunBlocker[];
}

/**
 * Collect the quota replay inputs, converting a quota data gap into a
 * run blocker (SEA-111 fix 2d). readQuotaHistory deliberately throws
 * when a class in the replay predates every rate window (a balance
 * derived from a guessed rate is a money bug); until this fix the throw
 * escaped as a raw exception that failed the job with no
 * emitPayrollAlert while every other blocking condition notified. Now
 * the gap becomes a quota_rate_gap blocker, so the run blocks loudly
 * and consistently through the policy §7 path: alert, nothing filed.
 * Exported (with an injectable reader) so the smoke can pin the
 * wrapping without the analytics seam.
 */
export async function collectQuotaInputs(input: {
  quotas: UnpaidQuota[];
  teachers: TeacherPeriodInput[];
  period: PayPeriod;
  rateHistory: PayRate[];
  readHistory?: typeof readQuotaHistory;
}): Promise<QuotaInputsResult> {
  const read = input.readHistory ?? readQuotaHistory;
  const quotaInputs = new Map<number, QuotaInput>();
  const blockers: RunBlocker[] = [];
  for (const quota of input.quotas) {
    if (quota.effective_from > input.period.end) continue;
    if (quota.effective_to !== null && quota.effective_to < input.period.start) {
      continue;
    }
    try {
      quotaInputs.set(quota.mb_staff_id, {
        quota,
        historyClasses: await read({
          mbStaffId: quota.mb_staff_id,
          effectiveFrom: quota.effective_from,
          periodEnd: input.period.end,
          rateHistory: input.rateHistory,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const teacherName =
        input.teachers.find((t) => t.mbStaffId === quota.mb_staff_id)?.name ??
        `staff ${quota.mb_staff_id}`;
      console.error(
        `[payroll.prepare] quota history read failed for staff ${quota.mb_staff_id}: ${message}; blocking the run`,
      );
      blockers.push({ teacherName, reason: "quota_rate_gap" });
    }
  }
  return { quotaInputs, blockers };
}

/** Days after a period end within which a zero-invoice ledger still
 * counts as a MISSED run rather than ancient history. */
export const MISSED_RUN_GRACE_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The most recently ENDED period, when `today` falls within `graceDays`
 * after its end; else null. Pure date math (no db, no clock) so the
 * smoke can pin every branch. Null when today IS a period end (the
 * normal run handles it), when the current period is the first automated
 * one (nothing before it to have missed), and when the last end is
 * beyond the grace window (a quiet ordinary tick, not a fresh miss).
 */
export function recentlyEndedPeriod(
  today: string,
  graceDays: number = MISSED_RUN_GRACE_DAYS,
): PayPeriod | null {
  const current = periodContaining(today);
  if (current.end === today) return null;
  if (current.start === PAYROLL_ANCHOR) return null;
  const previousEnd = new Date(
    Date.parse(`${current.start}T00:00:00Z`) - MS_PER_DAY,
  )
    .toISOString()
    .slice(0, 10);
  const previous = periodContaining(previousEnd);
  const daysSinceEnd = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${previous.end}T00:00:00Z`)) /
      MS_PER_DAY,
  );
  return daysSinceEnd >= 1 && daysSinceEnd <= graceDays ? previous : null;
}

/**
 * Missed-run detection (adversarial finding: a worker down over a
 * Sunday 20:30 tick resurfaced Monday as a quiet "skipped" and payday
 * silently did not happen). Returns the period that was MISSED: it
 * ended within the grace window and the ledger holds ZERO invoices for
 * it, meaning payroll.prepare never ran (a blocked run also files
 * nothing, but it alerted when it blocked; a missed tick alerted
 * nobody). The ledger counter is injectable so the decision smoke
 * needs no db.
 */
export async function checkMissedRun(input: {
  today: string;
  graceDays?: number;
  countForPeriod?: (label: string) => Promise<number>;
}): Promise<PayPeriod | null> {
  const candidate = recentlyEndedPeriod(input.today, input.graceDays);
  if (!candidate) return null;
  const count = await (input.countForPeriod ?? countPayrollInvoicesForPeriod)(
    candidate.label,
  );
  return count === 0 ? candidate : null;
}

async function runPrepare(ctx: JobContext): Promise<PrepareOutcome> {
  const today = studioToday();
  const payload = (ctx.payload ?? {}) as PayrollPreparePayload;

  // 1. Which period. Cron ticks carry no payload: the tick on a period-end
  // Sunday prepares that period; every other Sunday is a quiet skip.
  // Manual fires may name any period whose end date has been reached.
  let period: PayPeriod;
  if (typeof payload.period === "string" && payload.period.length > 0) {
    period = parsePeriodLabel(payload.period);
    if (period.end > today) {
      return {
        status: "skipped",
        reason: `period ${period.label} has not ended (today ${today}); a mid-flight run would count bookings as attendance (policy 5)`,
      };
    }
  } else {
    period = periodContaining(today);
    if (period.end !== today) {
      // Before skipping quietly, check for a MISSED run: a worker down
      // over the Sunday 20:30 tick used to resurface here as a silent
      // skip while payday never happened. A recently ended period with
      // zero ledger invoices is paged loudly; the operator fires
      // payroll.prepare manually for that period. Ordinary off-Sunday
      // ticks (no recently-ended unfiled period) stay quiet.
      const missed = await checkMissedRun({ today });
      if (missed) {
        await emitPayrollAlert({
          alertType: "missed_run",
          period: missed.label,
          detail: `Payroll for ${missed.label} appears to have been MISSED: the period ended ${missed.end} and the ledger has no invoices for it, so the Sunday 20:30 run never fired (for example the worker was down). Fire payroll.prepare manually with period ${missed.label} to run it now; filing is idempotent per invoice, so re-running is safe.`,
          teachers: [],
          at: new Date().toISOString(),
        });
        return {
          status: "skipped",
          reason: `${today} is not a period-end Sunday, and period ${missed.label} ended with no invoices filed; missed-run alert sent`,
        };
      }
      return {
        status: "skipped",
        reason: `${today} is not a period-end Sunday (current period ends ${period.end})`,
      };
    }
  }

  // 2. Make the data current (policy §6): dispatch the sync over the
  // period tail, wider than strictly needed. Skipped-without-token is
  // tolerated only when the mirror turns out fresh anyway (step 3).
  const syncWindowStart = new Date(
    Date.parse(`${period.end}T00:00:00Z`) - 3 * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const sync = await dispatchSyncAndWait({
    start: syncWindowStart,
    end: period.end,
  });
  if (sync.status === "failed" || sync.status === "timed_out") {
    await emitPayrollAlert({
      alertType: "run_blocked",
      period: period.label,
      detail: `Payroll for ${period.label} is blocked: the analytics sync did not complete (${sync.reason ?? sync.status}). Nothing was filed. Re-run after the sync recovers.`,
      teachers: [],
      at: new Date().toISOString(),
    });
    return { status: "blocked", reason: sync.reason ?? sync.status };
  }

  // 3. Freshness gate (policy §6 step 4): a stale read is
  // indistinguishable from a light teaching day, so this check is what
  // makes the payday-evening run safe. It demands attendance-shaped
  // evidence for the period's final Sunday (attended visits), not just
  // schedule rows: the mirror carries future-dated class_instances, so
  // schedule presence proves nothing about the sync having landed.
  const freshness = await checkFreshness(period);
  if (!freshness.fresh) {
    await emitPayrollAlert({
      alertType: "run_blocked",
      period: period.label,
      detail: `Payroll for ${period.label} is blocked: the analytics mirror does not show attendance for the period's final Sunday ${period.end} (max class date ${freshness.maxClassDate ?? "none"}, final Sunday classes ${freshness.finalSundayClasses}, attended Sunday visits ${freshness.finalSundayAttended}; sync dispatch ${sync.status}). Sunday evening data has not landed, so nothing was filed. To fix: set ANALYTICS_SYNC_GH_TOKEN on the worker so the run can dispatch the sync itself, or manually dispatch nightly-sync in sealevel-analytics over the period tail, then re-run payroll.prepare for ${period.label}. If the studio was genuinely closed that Sunday, a human clears this block.`,
      teachers: [],
      at: new Date().toISOString(),
    });
    return { status: "blocked", reason: "stale mirror" };
  }

  // 4. Reads: the period's classes per teacher, the rates in effect on
  // the period start (policy §9), and quota arrangements with their full
  // replay histories (policy §13).
  const [teachers, rates, rateHistory, quotas] = await Promise.all([
    readPeriodTeachers(period),
    ratesInEffectOn(period.start),
    listPayRates(),
    listUnpaidQuotas(),
  ]);
  // Quota data gaps become blockers here (SEA-111 fix 2d), never raw
  // exceptions: a run that dies without an alert is the failure mode
  // this system exists to prevent.
  const quotaCollection = await collectQuotaInputs({
    quotas,
    teachers,
    period,
    rateHistory,
  });

  // 5. The arithmetic (all of it lives in compute.ts).
  const result = computePayroll({
    period,
    teachers,
    rates,
    quotas: quotaCollection.quotaInputs,
  });

  // 6. Blockers fail the WHOLE run (policy §7): a blocked payroll is
  // noticed; one teacher silently missing is not. Quota data gaps (from
  // step 4 and from compute's history/period disagreement check) block
  // through the same path as unrated or unresolved teachers.
  const blockers = [...quotaCollection.blockers, ...result.blockers];
  if (blockers.length > 0) {
    const names = blockers.map(
      (b) => `${b.teacherName} (${b.reason.replace(/_/g, " ")})`,
    );
    await emitPayrollAlert({
      alertType: "run_blocked",
      period: period.label,
      detail: `Payroll for ${period.label} is blocked: ${names.join("; ")}. Fix the cause (set missing rates on the Teacher pay rates page, resolve the identity upstream, or close the quota data gap), then re-run. Nothing was filed.`,
      teachers: blockers.map((b) => b.teacherName),
      at: new Date().toISOString(),
    });
    return { status: "blocked", reason: names.join("; ") };
  }

  // 7. File one item + ledger row per invoice, ATOMICALLY (SEA-110): the
  // card and its ledger row are one transaction, so an approval card can
  // never exist without the ledger row that makes approving it act.
  // Re-runs are per-teacher no-ops; a conflict (row queued/pushed under
  // another card) files nothing for that teacher and alerts.
  let filed = 0;
  let alreadyPrepared = 0;
  const conflicts: string[] = [];
  let firstItem: Item | null = null;
  for (const invoice of result.invoices) {
    const outcome = await filePayrollInvoice({
      period: period.label,
      mbStaffId: invoice.mbStaffId,
      payload: {
        period: period.label,
        mb_staff_id: invoice.mbStaffId,
        teacher_name: invoice.name,
        rate_cents: invoice.rateCents,
        class_count: invoice.classCount,
        free_count: invoice.freeCount,
        paid_count: invoice.paidCount,
        total_cents: invoice.totalCents,
        summary: invoice.summary,
        // The underlying class rows so the approver can check the
        // arithmetic; attendance rides along as context, never as an
        // input (policy §4).
        lines: invoice.lines,
        ...(invoice.quota ? { quota: invoice.quota } : {}),
        generated_by: "payroll.prepare",
      },
    });
    switch (outcome.status) {
      case "filed":
      case "repaired":
      case "retargeted":
        filed += 1;
        firstItem ??= outcome.item;
        if (outcome.status !== "filed") {
          console.log(
            `[payroll.prepare] ${period.label} staff ${invoice.mbStaffId}: ${outcome.status}`,
          );
        }
        break;
      case "already_prepared":
        alreadyPrepared += 1;
        console.log(
          `[payroll.prepare] ${period.label} staff ${invoice.mbStaffId}: already prepared, no-op`,
        );
        break;
      case "conflict":
        conflicts.push(`${invoice.name}: ${outcome.detail ?? "ledger conflict"}`);
        console.warn(
          `[payroll.prepare] ${period.label} staff ${invoice.mbStaffId}: CONFLICT, nothing filed (${outcome.detail})`,
        );
        break;
    }
  }
  if (conflicts.length > 0) {
    await emitPayrollAlert({
      alertType: "run_blocked",
      period: period.label,
      detail: `Payroll for ${period.label}: ${conflicts.length} invoice(s) hit a ledger conflict and were not filed. ${conflicts.join("; ")}`,
      teachers: [],
      at: new Date().toISOString(),
    });
  }

  // One pending-approval event for the batch (18 separate pushes on a
  // Sunday night would be noise, not signal); the detail carries the
  // batch shape. Zero-total teachers are reported in the log only
  // (policy §12: visible on the rates page, never invoiced).
  if (firstItem && filed > 0) {
    const totalCents = result.invoices.reduce((s, i) => s + i.totalCents, 0);
    await emitItemEvent("item.pending_approval", firstItem, "payroll.prepare");
    console.log(
      `[payroll.prepare] ${period.label}: filed ${filed} invoices totaling ${dollars(totalCents)}${
        alreadyPrepared > 0 ? `, ${alreadyPrepared} already prepared` : ""
      }, zero-total: ${result.zeroTotals.length}`,
    );
  }
  return { status: "filed", filed, alreadyPrepared };
}

export const payrollPrepare: Job = {
  id: "payroll.prepare",
  enabled: true,
  triggers: [
    // Sunday 20:30 studio time (policy §6): after the 18:30 class's
    // roster has posted, before payday-evening approval. The tz pin
    // keeps the wall-clock commitment across DST.
    { kind: "cron", expr: "30 20 * * 0", tz: "America/Los_Angeles" },
    { kind: "manual" },
  ],
  // The preflight is the whole job (see module doc): deterministic money
  // math only, no model in the loop. Declared model/tools are dormant.
  tools: [],
  model: "claude-sonnet-5",
  preflight: async (ctx) => {
    // Catch-all (SEA-111 spirit): every ANTICIPATED failure inside
    // runPrepare blocks with an alert, but an unanticipated throw (a
    // transient MCP or Postgres outage, a crash mid-filing) used to
    // dead-letter via BullMQ with only the default log handler: no
    // alert, and the sweeper is structurally blind to it (nothing filed
    // means no queued/pushing rows to notice). Alert, then RETHROW so
    // BullMQ still retries; the worker's failed-handler additionally
    // pages on exhausted attempts in case this alert path itself failed.
    let outcome: PrepareOutcome;
    try {
      outcome = await runPrepare(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let periodLabel = "unknown";
      try {
        const payload = (ctx.payload ?? {}) as PayrollPreparePayload;
        periodLabel =
          typeof payload.period === "string" && payload.period.length > 0
            ? payload.period
            : periodContaining(studioToday()).label;
      } catch {
        // Even the period math failing must not lose the alert.
      }
      console.error(`[payroll.prepare] unexpected error: ${message}`);
      await emitPayrollAlert({
        alertType: "run_blocked",
        period: periodLabel,
        detail: `payroll.prepare hit an unexpected error: ${message}. The run filed nothing or filed partially. Fix the cause and re-fire payroll.prepare for the period; filing is idempotent per invoice (already filed teachers are no-ops), so a re-run is safe.`,
        teachers: [],
        at: new Date().toISOString(),
      });
      throw err;
    }
    console.log(
      `[payroll.prepare] ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}${
        outcome.filed !== undefined ? `, filed=${outcome.filed}` : ""
      }`,
    );
    return { handled: true };
  },
  instructions: () =>
    "payroll.prepare is fully handled by its preflight; this prompt is never reached.",
};
