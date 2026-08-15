import type { Item } from "@ai-manager/core";
import { payrollInvoiceForItem } from "@ai-manager/core";
import { payrollDollars } from "../lib/payrollInvoiceView";

/**
 * Decided view for a payroll_invoice item (SEA-104): the summary, who
 * decided, and the live push status from the payroll_invoices ledger
 * (prepared / queued / pushing / pushed with the QBO Bill reference /
 * failed). Server component; reads the ledger directly.
 */
export async function PayrollInvoiceDecidedDetail({ item }: { item: Item }) {
  const p = item.payload as Record<string, unknown>;
  const decision = p["decision"] as
    | { action?: string; by?: { name?: string }; at?: string }
    | undefined;
  const ledger = await payrollInvoiceForItem(String(item.id)).catch(() => null);
  const total =
    typeof p["total_cents"] === "number" ? p["total_cents"] : null;

  const pushLine = (() => {
    if (!ledger) return "No ledger row found for this invoice.";
    switch (ledger.status) {
      case "pushed":
        return `Pushed to QuickBooks (Bill ${ledger.qbo_ref ?? "?"}).`;
      case "pushing":
        return "Push to QuickBooks in progress.";
      case "queued":
        return "Queued for QuickBooks push.";
      case "failed":
        return "QuickBooks push failed. Reopen and approve again to retry.";
      default:
        return "Not pushed (invoice was not approved).";
    }
  })();

  return (
    <div className="payroll-card">
      <header className="payroll-card-head">
        <h2>
          {String(p["teacher_name"] ?? "(unknown teacher)")}{" "}
          <span className="settings-help">{String(p["period"] ?? "")}</span>
        </h2>
        <p className="payroll-summary">{String(p["summary"] ?? "")}</p>
      </header>
      {total !== null ? (
        <p className="settings-help">Total {payrollDollars(total)}.</p>
      ) : null}
      <p className="settings-help">
        {decision?.action === "rejected" ? "Rejected" : "Approved"}
        {decision?.by?.name ? ` by ${decision.by.name}` : ""}. {pushLine}
      </p>
    </div>
  );
}
