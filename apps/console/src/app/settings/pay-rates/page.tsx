import { nextPeriodStart, periodContaining, studioToday } from "@ai-manager/core";
import { SetRateForm } from "../../../components/PayRateForms";
import { currentRole, hasPermission } from "../../../lib/rbac";
import { payRatesPageData } from "../../../lib/payRates";

/**
 * Teacher pay rates (SEA-106): the one place a rate is set, changed, or
 * looked up. Teachers arrive from Mindbody via the analytics pipeline —
 * there is deliberately no "add teacher" control here, and rates attach
 * to upstream identities keyed on mb_staff_id. Owner-gated
 * (settings:manage); the server actions re-check regardless.
 */

export const dynamic = "force-dynamic";

function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toFixed(whole ? 0 : 2)}`;
}

export default async function PayRatesPage() {
  const role = await currentRole();
  if (!hasPermission(role, "settings:manage")) {
    return (
      <div className="page page--settings">
        <header className="page-head">
          <h1>Teacher pay rates</h1>
        </header>
        <p className="settings-help">
          Your role can view the console but not manage settings. Ask an
          owner to make changes here.
        </p>
      </div>
    );
  }

  const today = studioToday();
  const openPeriod = periodContaining(today);
  const defaultEffectiveFrom = nextPeriodStart(today);
  const data = await payRatesPageData();

  return (
    <div className="page page--settings">
      <header className="page-head">
        <h1>Teacher pay rates</h1>
        <p>
          Per-class rates for payroll. The current period is{" "}
          {openPeriod.start} through {openPeriod.end}; rate changes take
          effect from the next period start ({defaultEffectiveFrom}), never
          mid-period.
        </p>
      </header>

      <section className="settings-section">
        <h2 className="section-label">Teachers (taught in the last 90 days)</h2>
        <p className="settings-help">
          Teachers come from Mindbody through the analytics pipeline; new
          ones appear here after their first class. A teacher without a
          rate blocks the payroll run for any period they taught in, so
          highlighted rows need a decision. A $0 rate is a decision too
          (a trade arrangement) and needs a note.
        </p>
        {data.analyticsNote ? (
          <p className="settings-help" role="status">
            {data.analyticsNote}
          </p>
        ) : null}
        {data.rows?.map((row) => {
          const key = row.teacher.mbStaffId ?? `name:${row.teacher.name}`;
          return (
            <div
              key={key}
              className={`payrate-row payrate-row--${row.state}`}
            >
              <div className="payrate-row-main">
                <strong>{row.teacher.name}</strong>{" "}
                <span className="settings-help">
                  {row.teacher.classes90d} class
                  {row.teacher.classes90d === 1 ? "" : "es"}, last taught{" "}
                  {row.teacher.lastTaught}
                </span>
                {row.state === "rated" ? (
                  <p className="settings-help">
                    {dollars(row.rate.rate_cents)} per class since{" "}
                    {row.rate.effective_from}
                    {row.rate.rate_cents === 0 ? " (unpaid by agreement)" : ""}
                    {row.rate.notes ? ` (${row.rate.notes})` : ""}
                  </p>
                ) : row.state === "no_rate" ? (
                  <p className="settings-error">
                    No rate set. Payroll will block until this is resolved.
                  </p>
                ) : (
                  <p className="settings-error">
                    Unpayable: this teacher has no Mindbody staff id. Fix
                    the identity upstream in sealevel-analytics; it cannot
                    be repaired from the console.
                  </p>
                )}
              </div>
              {row.teacher.mbStaffId !== null ? (
                <SetRateForm
                  mbStaffId={row.teacher.mbStaffId}
                  displayName={row.teacher.name}
                  currentRateCents={
                    row.state === "rated" ? row.rate.rate_cents : null
                  }
                  // A first rate may (and usually should) cover the open
                  // period, so the blocked run succeeds on re-run; a
                  // change never lands before the next period start.
                  defaultEffectiveFrom={
                    row.state === "rated" ? defaultEffectiveFrom : openPeriod.start
                  }
                  minEffectiveFrom={
                    row.state === "rated" ? defaultEffectiveFrom : undefined
                  }
                />
              ) : null}
            </div>
          );
        })}
      </section>

      {data.quotas.length > 0 ? (
        <section className="settings-section">
          <h2 className="section-label">Training payback</h2>
          <p className="settings-help">
            Teachers working off a training balance: their first free
            classes each calendar month are unpaid and credit the balance
            at their normal rate. The balance is derived from taught
            classes, never stored, so it is always consistent with what
            invoices showed.
          </p>
          {data.quotas.map((view) => (
            <div key={view.quota.id} className="payrate-row">
              <strong>{view.teacherName}</strong>{" "}
              <span className="settings-help">
                {view.quota.free_classes_per_month} unpaid class
                {view.quota.free_classes_per_month === 1 ? "" : "es"} per
                month against {dollars(view.quota.obligation_cents)} since{" "}
                {view.quota.effective_from}.
              </span>
              {view.remainingCents !== null ? (
                view.remainingCents > 0 ? (
                  <p className="settings-help">
                    {dollars(view.remainingCents)} remaining.
                  </p>
                ) : (
                  <p className="settings-help">
                    Paid off{view.paidOffOn ? ` on ${view.paidOffOn}` : ""}.
                    Classes are paid normally now.
                  </p>
                )
              ) : (
                <p className="settings-help">{view.note}</p>
              )}
            </div>
          ))}
        </section>
      ) : null}

      {data.history.length > 0 ? (
        <section className="settings-section">
          <h2 className="section-label">Rate history</h2>
          <p className="settings-help">
            Every rate window ever in effect. History is never edited in
            place, so re-running an old period reproduces the numbers that
            were approved at the time.
          </p>
          {data.history.map((rate) => (
            <p key={rate.id} className="settings-help">
              {rate.teacher_display_name ?? `staff ${rate.mb_staff_id}`}:{" "}
              {dollars(rate.rate_cents)} per class, {rate.effective_from}{" "}
              {rate.effective_to ? `to ${rate.effective_to}` : "onward"}
              {rate.notes ? ` (${rate.notes})` : ""}
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}
