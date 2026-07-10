"use server";

import { revalidatePath } from "next/cache";
import {
  createRule,
  RULE_MAX_CHARS,
  setUserSettings,
  updateRule,
} from "@ai-manager/core";
import { requireSettingsManager } from "../../lib/requireDecider";

/**
 * Server actions for the settings page (GH-66). Every mutation re-checks
 * the session and the settings:manage permission server-side
 * (requireSettingsManager); the UI hiding the page for non-owners is
 * presentation, not the gate.
 */

export interface SettingsActionState {
  error: string | null;
  saved?: boolean;
}

function fieldString(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

export async function addRule(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const who = await requireSettingsManager();
  const text = fieldString(formData, "rule_text").trim();
  if (text.length === 0) return { error: "Rule text is required." };
  if (text.length > RULE_MAX_CHARS) {
    return { error: `Rules are limited to ${RULE_MAX_CHARS} characters.` };
  }
  const category = fieldString(formData, "category").trim() || null;
  await createRule(text, category, who.id);
  revalidatePath("/settings");
  return { error: null, saved: true };
}

export async function saveRule(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const who = await requireSettingsManager();
  const id = fieldString(formData, "id").trim();
  if (id.length === 0) return { error: "Missing rule id." };
  const text = fieldString(formData, "rule_text").trim();
  if (text.length === 0) return { error: "Rule text is required." };
  if (text.length > RULE_MAX_CHARS) {
    return { error: `Rules are limited to ${RULE_MAX_CHARS} characters.` };
  }
  const updated = await updateRule(id, { ruleText: text }, who.id);
  if (!updated) return { error: "Rule not found. It may have been removed." };
  revalidatePath("/settings");
  return { error: null, saved: true };
}

export async function setRuleActive(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const who = await requireSettingsManager();
  const id = fieldString(formData, "id").trim();
  if (id.length === 0) return { error: "Missing rule id." };
  const active = fieldString(formData, "active") === "true";
  const updated = await updateRule(id, { active }, who.id);
  if (!updated) return { error: "Rule not found. It may have been removed." };
  revalidatePath("/settings");
  return { error: null, saved: true };
}

export async function saveSignature(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const who = await requireSettingsManager();
  const signWithName = formData.get("sign_with_name") === "on";
  const name = fieldString(formData, "signature_name").trim();
  if (name.length > 80) {
    return { error: "Signature name is limited to 80 characters." };
  }
  await setUserSettings(who.id, {
    signWithName,
    signatureName: name || null,
  });
  revalidatePath("/settings");
  return { error: null, saved: true };
}
