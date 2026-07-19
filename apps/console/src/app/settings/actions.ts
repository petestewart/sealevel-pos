"use server";

import { revalidatePath } from "next/cache";
import {
  addStudioInfoEntry,
  createRule,
  deleteRule as deleteRuleRow,
  deleteStudioInfoEntry,
  enqueueLearningMine,
  RULE_MAX_CHARS,
  saveStudioInfoEntry,
  setStageApprovals,
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

export async function removeRule(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const who = await requireSettingsManager();
  const id = fieldString(formData, "id").trim();
  if (id.length === 0) return { error: "Missing rule id." };
  const deleted = await deleteRuleRow(id, who.id);
  if (!deleted) {
    return { error: "Rule not found. It may already have been deleted." };
  }
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

/**
 * Review-queue mode toggle (GH-106): whether THIS user's approvals stage
 * into the Approved queue instead of queueing delivery immediately. A
 * per-user setting like the signature preference; it only changes what
 * happens when YOU approve. The Approved queue itself is global.
 */
export async function saveStageApprovals(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const who = await requireSettingsManager();
  const staged = formData.get("stage_approvals") === "on";
  await setStageApprovals(who.id, staged);
  revalidatePath("/settings");
  return { error: null, saved: true };
}

/**
 * "Mine lessons now" (learning loop, GH-127): the manual leg of the
 * hybrid trigger. Enqueues one learning.mine run on the worker, which
 * reads the operator corrections decided since the last mine and files
 * 0-3 pending rule proposals for review. Timestamped jobId, so the button
 * always fires (unlike the deduped threshold trigger); the miner's own
 * minimum-signals gate makes a premature click a harmless logged skip.
 * Nothing is learned from this action itself: proposals still require an
 * approval in the pending queue.
 */
export async function mineLessonsNow(
  _prev: SettingsActionState,
  _formData: FormData,
): Promise<SettingsActionState> {
  await requireSettingsManager();
  try {
    await enqueueLearningMine(`manual-${Date.now()}`);
  } catch (err) {
    console.error(
      `[settings] failed to enqueue learning.mine: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      error: "Could not start mining. Check that the worker is running and try again.",
    };
  }
  revalidatePath("/settings");
  return { error: null, saved: true };
}

export async function addStudioInfo(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const who = await requireSettingsManager();
  const error = await addStudioInfoEntry(
    fieldString(formData, "entry_key"),
    fieldString(formData, "entry_value"),
    who.id,
  );
  if (error) return { error };
  revalidatePath("/settings");
  return { error: null, saved: true };
}

export async function saveStudioInfoValue(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const who = await requireSettingsManager();
  const key = fieldString(formData, "entry_key");
  if (key.length === 0) return { error: "Missing entry key." };
  const error = await saveStudioInfoEntry(
    key,
    fieldString(formData, "entry_value"),
    who.id,
  );
  if (error) return { error };
  revalidatePath("/settings");
  return { error: null, saved: true };
}

export async function removeStudioInfo(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  await requireSettingsManager();
  const key = fieldString(formData, "entry_key");
  if (key.length === 0) return { error: "Missing entry key." };
  await deleteStudioInfoEntry(key);
  revalidatePath("/settings");
  return { error: null, saved: true };
}
