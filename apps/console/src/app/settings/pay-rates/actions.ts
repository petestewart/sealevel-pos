"use server";

import { revalidatePath } from "next/cache";
import {
  changePayRate,
  clearVendorLink,
  PayRateChangeError,
  setVendorLink,
  VendorLinkError,
} from "@ai-manager/core";
import { requireSettingsManager } from "../../../lib/requireDecider";

/**
 * Server actions for the Teacher pay rates page (SEA-106). Owner-only
 * (settings:manage), re-checked server-side on every call like the rest
 * of settings. All the policy enforcement (no in-place edits, no
 * effective dates inside the open period, no back-dating, zero rates
 * need a note) lives in core changePayRate; this layer only parses the
 * form and translates refusals into inline messages.
 */

export interface PayRateActionState {
  error: string | null;
  saved?: boolean;
}

function fieldString(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

export async function setPayRateAction(
  _prev: PayRateActionState,
  formData: FormData,
): Promise<PayRateActionState> {
  const who = await requireSettingsManager();

  const mbStaffId = Number(fieldString(formData, "mb_staff_id"));
  if (!Number.isInteger(mbStaffId) || mbStaffId <= 0) {
    return { error: "Missing teacher identity." };
  }
  const displayName = fieldString(formData, "display_name").trim() || null;

  // Amount arrives in dollars (e.g. "75" or "75.50"); stored in cents.
  const amountRaw = fieldString(formData, "amount").trim();
  if (amountRaw.length === 0) return { error: "Enter a per-class amount." };
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "The amount must be zero or a positive number." };
  }
  const rateCents = Math.round(amount * 100);
  if (Math.abs(rateCents - amount * 100) > 1e-6) {
    return { error: "Amounts are dollars and cents; nothing smaller than a cent." };
  }

  const effectiveFrom = fieldString(formData, "effective_from").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return { error: "Pick an effective date." };
  }
  const notes = fieldString(formData, "notes").trim() || null;

  try {
    await changePayRate({
      mbStaffId,
      displayName,
      rateCents,
      effectiveFrom,
      notes,
      createdBy: who.id,
    });
  } catch (err) {
    if (err instanceof PayRateChangeError) return { error: err.message };
    throw err;
  }
  revalidatePath("/settings/pay-rates");
  return { error: null, saved: true };
}

/**
 * Link a teacher to a QuickBooks vendor (SEA-119). The push job pays the
 * linked vendor id, never a name match; validation and the two-teachers-
 * one-vendor refusal live in core setVendorLink.
 */
export async function setVendorLinkAction(
  _prev: PayRateActionState,
  formData: FormData,
): Promise<PayRateActionState> {
  const who = await requireSettingsManager();

  const mbStaffId = Number(fieldString(formData, "mb_staff_id"));
  if (!Number.isInteger(mbStaffId) || mbStaffId <= 0) {
    return { error: "Missing teacher identity." };
  }
  const vendorId = fieldString(formData, "vendor_id");
  const vendorName = fieldString(formData, "vendor_name").trim() || null;

  try {
    await setVendorLink({
      mbStaffId,
      vendorId,
      vendorName,
      updatedBy: who.id,
    });
  } catch (err) {
    if (err instanceof VendorLinkError) return { error: err.message };
    throw err;
  }
  revalidatePath("/settings/pay-rates");
  return { error: null, saved: true };
}

/** Remove a teacher's vendor link; pushes fail honestly until relinked. */
export async function clearVendorLinkAction(
  _prev: PayRateActionState,
  formData: FormData,
): Promise<PayRateActionState> {
  await requireSettingsManager();

  const mbStaffId = Number(fieldString(formData, "mb_staff_id"));
  if (!Number.isInteger(mbStaffId) || mbStaffId <= 0) {
    return { error: "Missing teacher identity." };
  }
  await clearVendorLink(mbStaffId);
  revalidatePath("/settings/pay-rates");
  return { error: null, saved: true };
}
