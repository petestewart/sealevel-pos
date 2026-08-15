import type { Item } from "@ai-manager/core";
import type {
  PayrollInvoiceCardData,
  PayrollInvoiceLineView,
} from "./payrollInvoiceView";

/**
 * Server-side builder: validate a payroll_invoice item's payload into the
 * client-safe card shape (payrollInvoiceView.ts). Null = malformed; the
 * page renders a placeholder instead of a card that could misstate money.
 */
export function toPayrollInvoiceCardData(
  item: Item,
): PayrollInvoiceCardData | null {
  const p = item.payload as Record<string, unknown>;
  const period = typeof p["period"] === "string" ? p["period"] : null;
  const teacherName =
    typeof p["teacher_name"] === "string" ? p["teacher_name"] : null;
  const totalCents =
    typeof p["total_cents"] === "number" ? p["total_cents"] : null;
  const summary = typeof p["summary"] === "string" ? p["summary"] : null;
  if (!period || !teacherName || totalCents === null || !summary) return null;

  const rawLines = Array.isArray(p["lines"]) ? p["lines"] : [];
  const lines: PayrollInvoiceLineView[] = [];
  for (const raw of rawLines) {
    const line = raw as Record<string, unknown>;
    if (typeof line["date"] !== "string") return null;
    lines.push({
      date: line["date"],
      timeNorm: typeof line["timeNorm"] === "string" ? line["timeNorm"] : "",
      classType:
        typeof line["classType"] === "string" ? line["classType"] : "",
      attendeeCount:
        typeof line["attendeeCount"] === "number" ? line["attendeeCount"] : null,
      rateCents: typeof line["rateCents"] === "number" ? line["rateCents"] : 0,
      paidCents: typeof line["paidCents"] === "number" ? line["paidCents"] : 0,
      free: line["free"] === true,
      creditedCents:
        typeof line["creditedCents"] === "number" ? line["creditedCents"] : 0,
    });
  }
  // The lines must reproduce the total: a card whose visible arithmetic
  // disagrees with the amount that would land in QBO must never render
  // as approvable.
  const lineSum = lines.reduce((s, l) => s + l.paidCents, 0);
  if (lines.length === 0 || lineSum !== totalCents) return null;

  const quotaRaw = p["quota"] as Record<string, unknown> | undefined;
  return {
    id: String(item.id),
    period,
    teacherName,
    rateCents: typeof p["rate_cents"] === "number" ? p["rate_cents"] : 0,
    classCount: typeof p["class_count"] === "number" ? p["class_count"] : lines.length,
    freeCount: typeof p["free_count"] === "number" ? p["free_count"] : 0,
    paidCount: typeof p["paid_count"] === "number" ? p["paid_count"] : lines.length,
    totalCents,
    summary,
    lines,
    quota:
      quotaRaw && typeof quotaRaw["remainingCentsAfter"] === "number"
        ? {
            creditedCents:
              typeof quotaRaw["creditedCents"] === "number"
                ? quotaRaw["creditedCents"]
                : 0,
            remainingCentsAfter: quotaRaw["remainingCentsAfter"],
            paidOffOn:
              typeof quotaRaw["paidOffOn"] === "string"
                ? quotaRaw["paidOffOn"]
                : null,
          }
        : null,
  };
}
