/**
 * CLIENT-SAFE view model + display helpers for payroll_invoice items
 * (SEA-104). Deliberately imports nothing from @ai-manager/core so the
 * client card can use these without pulling the core barrel into a
 * client bundle (pg/bullmq Node built-ins break the console build). The
 * server-side builder that validates an item payload into this shape
 * lives in payrollInvoiceData.ts.
 */

export interface PayrollInvoiceLineView {
  date: string;
  timeNorm: string;
  classType: string;
  attendeeCount: number | null;
  rateCents: number;
  paidCents: number;
  free: boolean;
  creditedCents: number;
}

export interface PayrollInvoiceCardData {
  id: string;
  period: string;
  teacherName: string;
  rateCents: number;
  classCount: number;
  freeCount: number;
  paidCount: number;
  totalCents: number;
  summary: string;
  lines: PayrollInvoiceLineView[];
  quota: {
    creditedCents: number;
    remainingCentsAfter: number;
    paidOffOn: string | null;
  } | null;
}

/** Render cents as dollars, whole amounts without decimals. */
export function payrollDollars(cents: number): string {
  return cents % 100 === 0
    ? `$${cents / 100}`
    : `$${(cents / 100).toFixed(2)}`;
}
