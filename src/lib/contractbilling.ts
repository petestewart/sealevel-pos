/**
 * T300: how a membership that starts on a LATER day is billed.
 *
 * Pete (2026-11-24): "start date defaults to today but can be set in the
 * future. if set to the future, defaults to pro-rate from today
 * (membership starts now even tho contract date begins at the start
 * date) but that can be turned off (membership starts on contract
 * date)", and, asked whether the first payment of an unprorated start is
 * taken today or on the start day, "a choice in the dialog".
 *
 * - `prorate` (the default): the member is in from TODAY. Mindbody
 *   charges the stretch from today to the start day now, and the
 *   contract's own payments run from the start day. Sent as StartDate
 *   (the day), ProrateDate (today) and FirstPaymentOccurs "StartDate".
 *   ProrateDate must come BEFORE StartDate (T299: Mindbody refuses one
 *   "on or after StartDate").
 * - `startday`: nothing prorated, the membership starts on the start
 *   day and so does its first payment. StartDate and FirstPaymentOccurs
 *   "StartDate", no ProrateDate.
 * - `today`: nothing prorated, the membership starts on the start day
 *   and its first payment is taken today. StartDate and
 *   FirstPaymentOccurs "Instant", no ProrateDate.
 *
 * A membership starting today has none of these: it sends what T30 sent.
 * Every figure is the `Test: true` rehearsal's for the chosen shape, so
 * nothing here computes what any of them costs (sale.yml:1866).
 *
 * Pure: imported by the browser and the server alike.
 */
export type ContractBilling = "prorate" | "startday" | "today";

export const DEFAULT_CONTRACT_BILLING: ContractBilling = "prorate";

/** A request field, read. Absent is the default; anything else that is
 *  not one of the three is refused by the caller, in words. */
export function readContractBilling(
  raw: unknown,
): { ok: true; billing: ContractBilling } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, billing: DEFAULT_CONTRACT_BILLING };
  }
  if (raw === "prorate" || raw === "startday" || raw === "today") {
    return { ok: true, billing: raw };
  }
  return {
    ok: false,
    error: 'billing must be "prorate", "startday" or "today".',
  };
}
