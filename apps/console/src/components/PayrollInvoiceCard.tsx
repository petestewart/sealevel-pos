"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import {
  approvePayrollInvoiceAction,
  rejectPayrollInvoiceAction,
  type PayrollActionState,
} from "../app/approvals/payrollActions";
import {
  payrollDollars,
  type PayrollInvoiceCardData,
} from "../lib/payrollInvoiceView";

/**
 * Approval card for one payroll_invoice item (SEA-104). The card's whole
 * job is to make the arithmetic checkable (policy §13: an approver should
 * never have to work out why the total is not classes times rate):
 * summary line, per-class lines with free/paid status, attendance as
 * context only, and the training-payback balance when one applies.
 * Approving queues the QuickBooks Bill; nothing auto-sends.
 */

const IDLE: PayrollActionState = { error: null };

export function PayrollInvoiceCard({
  item,
  canDecide,
  advanceHref,
}: {
  item: PayrollInvoiceCardData;
  canDecide: boolean;
  advanceHref?: string;
}) {
  const router = useRouter();
  const afterDecide = (state: PayrollActionState): PayrollActionState => {
    if (state.error === null && advanceHref) router.push(advanceHref);
    return state;
  };
  const [approveState, approveAction, approving] = useActionState(
    async (prev: PayrollActionState, formData: FormData) =>
      afterDecide(await approvePayrollInvoiceAction(prev, formData)),
    IDLE,
  );
  const [rejectState, rejectAction, rejecting] = useActionState(
    async (prev: PayrollActionState, formData: FormData) =>
      afterDecide(await rejectPayrollInvoiceAction(prev, formData)),
    IDLE,
  );
  const pending = approving || rejecting;
  const state = approveState.error ? approveState : rejectState;

  return (
    <div className="payroll-card">
      <header className="payroll-card-head">
        <h2>
          {item.teacherName} <span className="settings-help">{item.period}</span>
        </h2>
        <p className="payroll-summary">{item.summary}</p>
      </header>

      <table className="payroll-lines">
        <thead>
          <tr>
            <th>Date</th>
            <th>Time</th>
            <th>Class</th>
            <th>Attendance</th>
            <th>Pay</th>
          </tr>
        </thead>
        <tbody>
          {item.lines.map((line, i) => (
            <tr key={`${line.date}-${line.timeNorm}-${i}`}>
              <td>{line.date}</td>
              <td>{line.timeNorm}</td>
              <td>{line.classType}</td>
              <td className="settings-help">
                {line.attendeeCount ?? ""}
              </td>
              <td>
                {line.free
                  ? line.paidCents > 0
                    ? `${payrollDollars(line.paidCents)} (partial, ${payrollDollars(line.creditedCents)} to training balance)`
                    : `$0 (training payback)`
                  : payrollDollars(line.paidCents)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4}>Total</td>
            <td>{payrollDollars(item.totalCents)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="settings-help">
        Attendance is shown for context only; pay is per class regardless
        of attendance.
      </p>

      {item.quota ? (
        <p className="settings-help">
          Training payback: {payrollDollars(item.quota.creditedCents)} worked
          off this period, {payrollDollars(item.quota.remainingCentsAfter)}{" "}
          remaining
          {item.quota.paidOffOn
            ? ` (paid off ${item.quota.paidOffOn})`
            : ""}
          .
        </p>
      ) : null}

      {canDecide ? (
        <div className="payroll-card-actions">
          <form action={approveAction}>
            <input type="hidden" name="id" value={item.id} />
            <button type="submit" className="btn btn--primary" disabled={pending}>
              {approving
                ? "Approving..."
                : "Approve and send to QuickBooks"}
            </button>
          </form>
          <form action={rejectAction}>
            <input type="hidden" name="id" value={item.id} />
            <button type="submit" className="btn" disabled={pending}>
              {rejecting ? "Rejecting..." : "Reject"}
            </button>
          </form>
        </div>
      ) : (
        <p className="settings-help">
          Your role can view this invoice but not decide it.
        </p>
      )}
      {state.error ? (
        <p className="settings-error" role="alert">
          {state.error}
          {state.stale ? (
            <button
              type="button"
              className="btn"
              onClick={() => router.refresh()}
            >
              Refresh
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
