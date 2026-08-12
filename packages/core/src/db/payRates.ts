import { getPool } from "./client.js";
import {
  isInOpenPeriod,
  PAYROLL_ANCHOR,
  periodContaining,
  studioToday,
} from "../payroll/period.js";

/**
 * Teacher pay rates + training-payback quotas, the data layer under the
 * console's "Teacher pay rates" settings page (SEA-106) and under
 * payroll.prepare's rate lookup (SEA-104). Tables from 0016_payroll and
 * 0017_teacher_unpaid_quotas; the policy behind every rule here is
 * docs/payroll-policy.md.
 *
 * Identity: everything keys on mb_staff_id, the stable Mindbody staff id.
 * Teachers are never created here — they arrive from Mindbody via the
 * analytics pipeline, and this module only attaches rates to those
 * upstream identities (automation plan §2.11).
 */

/** One teacher_pay_rates row as the console reads it. */
export interface PayRate {
  id: string;
  mb_staff_id: number;
  teacher_display_name: string | null;
  rate_cents: number;
  rate_basis: "per_class" | "per_head";
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

const PAY_RATE_COLUMNS = `id::text, mb_staff_id, teacher_display_name,
  rate_cents, rate_basis, effective_from::text, effective_to::text,
  notes, created_by, created_at::text`;

/** Every rate row, newest window first per teacher (the page's history). */
export async function listPayRates(): Promise<PayRate[]> {
  const { rows } = await getPool().query<PayRate>(
    `SELECT ${PAY_RATE_COLUMNS} FROM teacher_pay_rates
     ORDER BY mb_staff_id, effective_from DESC`,
  );
  return rows;
}

/**
 * The rate in effect on `date` (YYYY-MM-DD) per teacher, as a map keyed
 * by mb_staff_id. Payroll's period query passes the period START date
 * (policy §9); the settings page passes studio-today to show current
 * rates. The EXCLUDE constraint guarantees at most one row matches per
 * teacher.
 */
export async function ratesInEffectOn(
  date: string,
): Promise<Map<number, PayRate>> {
  const { rows } = await getPool().query<PayRate>(
    `SELECT ${PAY_RATE_COLUMNS} FROM teacher_pay_rates
     WHERE effective_from <= $1
       AND (effective_to IS NULL OR effective_to >= $1)`,
    [date],
  );
  return new Map(rows.map((r) => [r.mb_staff_id, r]));
}

/** Why a rate change was refused; surfaced inline in the form. */
export class PayRateChangeError extends Error {}

/**
 * Set a teacher's rate: insert the new window and close the prior one in
 * one transaction, never updating a rate in place (policy §11 — history
 * is retained so a re-run of an old period reproduces exactly the numbers
 * approved at the time).
 *
 * For a rate CHANGE, the effective date must not fall inside the
 * currently open period or in the past (policy §9, enforced structurally
 * here rather than by form default): the rate multiplying a period's
 * classes is the one in effect on the period's start date, so a
 * mid-period change would retroactively alter the period in progress.
 * Callers default the date to nextPeriodStart.
 *
 * A teacher's FIRST rate is exempt from both date guards: policy §11's
 * new-teacher flow (teach, appear unrated, block the run, set a rate,
 * re-run) only works if the first rate can take effect from the blocked
 * period's start, and with no prior rate there is nothing a back-dated
 * window could retroactively alter. Seeding the initial roster rides the
 * same exemption (rates effective from the very first period's start,
 * set mid-period on 2026-08-11).
 *
 * The prior open-ended row (if any) is closed at effectiveFrom minus one
 * day. A prior row starting ON or after effectiveFrom cannot be closed
 * that way and is refused: correcting a not-yet-effective rate is a
 * deliberate delete-and-redo, not a silent overwrite.
 */
export async function changePayRate(input: {
  mbStaffId: number;
  displayName: string | null;
  rateCents: number;
  effectiveFrom: string;
  notes: string | null;
  createdBy: string;
}): Promise<PayRate> {
  const { mbStaffId, displayName, rateCents, effectiveFrom, notes, createdBy } =
    input;
  if (!Number.isInteger(rateCents) || rateCents < 0) {
    throw new PayRateChangeError("Rate must be zero or a positive amount.");
  }
  if (rateCents === 0 && (!notes || notes.trim().length === 0)) {
    // A zero rate means decided-unpaid (policy §12); the reason is the
    // record that makes it a decision rather than an accident.
    throw new PayRateChangeError(
      "A zero rate needs a note explaining the arrangement.",
    );
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query<{
      id: string;
      effective_from: string;
      open: boolean;
    }>(
      `SELECT id::text, effective_from::text, (effective_to IS NULL) AS open
       FROM teacher_pay_rates
       WHERE mb_staff_id = $1
       ORDER BY effective_from DESC
       FOR UPDATE`,
      [mbStaffId],
    );

    if (existing.length > 0) {
      // A CHANGE: the date guards apply (a first rate is exempt, see the
      // doc comment above).
      const today = studioToday();
      if (isInOpenPeriod(effectiveFrom, today)) {
        throw new PayRateChangeError(
          "The effective date falls inside the period in progress. Rate changes take effect from the next period start.",
        );
      }
      if (effectiveFrom < today) {
        // Anything earlier than today that is not inside the open period
        // is in a closed one: back-dating would rewrite periods that may
        // already be invoiced.
        throw new PayRateChangeError(
          "The effective date is in a past period. Rates cannot be back-dated.",
        );
      }
      // Policy §9: the rate multiplying a period's classes is the one in
      // effect on the period's START date, so a change effective mid-way
      // through a future period would silently do nothing until a period
      // later than the operator chose. Require a period-start date.
      if (
        effectiveFrom < PAYROLL_ANCHOR ||
        periodContaining(effectiveFrom).start !== effectiveFrom
      ) {
        throw new PayRateChangeError(
          `Rate changes must take effect on a period start (a Monday every two weeks from ${PAYROLL_ANCHOR}). A mid-period date would not apply until the following period.`,
        );
      }
    }

    const prior = existing.find((r) => r.open);
    if (prior) {
      if (prior.effective_from >= effectiveFrom) {
        // There is deliberately no delete path from the console (history
        // is the audit trail), so be honest about the way out.
        throw new PayRateChangeError(
          `A rate already starts ${prior.effective_from}, on or after the chosen date. Pick a later effective date, or correct the stored row directly if it was entered in error.`,
        );
      }
      await client.query(
        `UPDATE teacher_pay_rates
         SET effective_to = ($2::date - INTERVAL '1 day')::date
         WHERE id = $1::bigint`,
        [prior.id, effectiveFrom],
      );
    }
    const { rows } = await client.query<PayRate>(
      `INSERT INTO teacher_pay_rates
         (mb_staff_id, teacher_display_name, rate_cents, effective_from, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PAY_RATE_COLUMNS}`,
      [mbStaffId, displayName, rateCents, effectiveFrom, notes, createdBy],
    );
    await client.query("COMMIT");
    const inserted = rows[0];
    if (!inserted) throw new Error("changePayRate: insert returned no row");
    return inserted;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // The EXCLUDE constraint is the structural backstop; when it fires
    // (e.g. a CLOSED prior window whose effective_to still covers the new
    // date, which the open-row check above cannot see), surface it as the
    // same inline-message error the form knows how to render instead of a
    // raw Postgres error page.
    if (
      err instanceof Error &&
      (err as { code?: string }).code === "23P01"
    ) {
      throw new PayRateChangeError(
        "The new rate window overlaps an existing one for this teacher. Pick an effective date after every stored window ends.",
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/** One teacher_unpaid_quotas row (SEA-108). */
export interface UnpaidQuota {
  id: string;
  mb_staff_id: number;
  kind: string;
  free_classes_per_month: number;
  obligation_cents: number;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
}

/** Every quota arrangement, for the rates page's payback section. */
export async function listUnpaidQuotas(): Promise<UnpaidQuota[]> {
  const { rows } = await getPool().query<UnpaidQuota>(
    `SELECT id::text, mb_staff_id, kind, free_classes_per_month,
            obligation_cents, effective_from::text, effective_to::text, notes
     FROM teacher_unpaid_quotas
     ORDER BY mb_staff_id, effective_from DESC`,
  );
  return rows;
}
