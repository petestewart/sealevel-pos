/**
 * T211: the teacher's way past the waiver gate, and the words that go
 * with it.
 *
 * Pete, 2026-09-21: "currently a teacher cannot sign a student up for
 * class if they have no waiver. that is the normal flow but a teacher
 * should be able to override with their PIN and must give a reason. make
 * sure this is doable if there is an error, that would probably be the
 * main reason to do so."
 *
 * So the T18/T19 gate keeps every rule it has -- the real text, scrolled
 * to the end, the student's own agreement, the customer screen's
 * signature -- and gains a THIRD way through that is nobody's default: a
 * teacher's own PIN (T48) minted for the new `waiver` purpose, plus a
 * reason in their own words, both recorded on the client's profile the
 * way T45/T62 file a comp's reason.
 *
 * The override does NOT mark the waiver signed. Nothing here writes
 * `LiabilityRelease`, nothing touches `waiver_receipts`, and the next
 * tap on that student opens the same dialog again. It authorizes ONE
 * write to go ahead without one, which is exactly what Pete asked for
 * and no more: a student with no waiver on file still has no waiver on
 * file.
 *
 * No hex, no React, no server imports: this module runs in the browser's
 * dialog and in the routes, so the bounds the pad enforces and the
 * bounds the server refuses on cannot drift. Same reasoning as comp.ts.
 */

/** The comp-token purpose a teacher's PIN mints to go past the waiver
 *  gate. Its own value, never one of the other five: a PIN typed to
 *  discount a sale, to overdraw an account, to override a pass, to
 *  approve a sale or to sell a membership unsigned must not also let a
 *  student into a class with no waiver (T94 review's rule). */
export const WAIVER_PURPOSE = "waiver" as const;

/** The reason's bounds, trimmed. The same pair the discount note uses
 *  (T43/T67), because it is the same kind of thing: a sentence a human
 *  will read off a profile months later. */
export const WAIVER_REASON_MIN = 3;
export const WAIVER_REASON_MAX = 200;

/**
 * Which gated flow the override is for. The four the T18/T19 dialog
 * opens over: a roster row's check-in, a walk-in add, a promotion off
 * the waiting list, and a member's guest.
 */
export type WaiverFlow = "checkin" | "walkin" | "promote" | "guest";

/** The control's words in the dialog, by flow. The verb is the one the
 *  tap that opened the dialog was going to do, so a teacher reads what
 *  the override actually does rather than a generic "Continue". */
export function waiverOverrideLabel(flow: WaiverFlow): string {
  switch (flow) {
    case "walkin":
      return "Add without a waiver";
    case "promote":
      return "Promote without a waiver";
    case "guest":
      return "Continue without a waiver";
    default:
      return "Check in without a waiver";
  }
}

/** The PIN pad's title, naming the same act. */
export function waiverOverrideTitle(flow: WaiverFlow): string {
  switch (flow) {
    case "walkin":
      return "Add them without a waiver";
    case "promote":
      return "Promote them without a waiver";
    case "guest":
      return "Continue without a waiver";
    default:
      return "Check them in without a waiver";
  }
}

/**
 * THE record's wording, the one place it lives: the Notes entry (or the
 * Formula Note on a site that has them) and the server log line both
 * print this.
 *
 *   Checked in without a signed waiver by Dana Rivers at the counter: the waiver page would not load.
 *
 * The teacher's name comes from the token the server verified, never
 * from the browser.
 */
export function waiverOverrideLine(
  flow: WaiverFlow,
  teacherName: string,
  reason: string,
  /** T208: the add the teacher asked for can land on the WAITING LIST
   *  instead, either because they chose it or because /api/book's own
   *  capacity read said the class was full. The record must not say
   *  somebody is in a class they are queued for. */
  queued = false,
): string {
  const act =
    flow === "walkin"
      ? queued
        ? "Added to the waiting list without a signed waiver"
        : "Added to class without a signed waiver"
      : flow === "promote"
        ? "Promoted into class without a signed waiver"
        : flow === "guest"
          ? "Checked in as a guest without a signed waiver"
          : "Checked in without a signed waiver";
  const by = teacherName.trim();
  return `${act} by ${by || "a teacher"} at the counter: ${reason.trim()}`;
}

/** Whether a typed reason is complete: the pad's confirm and the
 *  routes' refusal read this one rule. */
export function waiverReasonValid(reason: string): boolean {
  const trimmed = reason.trim();
  return (
    trimmed.length >= WAIVER_REASON_MIN && trimmed.length <= WAIVER_REASON_MAX
  );
}

/** What the browser sends and the routes read. */
export interface WaiverOverrideAsk {
  token: string;
  reason: string;
}

/**
 * Shape-check an untrusted `waiverOverride` field. A string return is
 * the 400 reason; null means the field was absent, which is every
 * ordinary write and changes nothing. Whether the TOKEN is any good is
 * verifyCompToken's business, in src/lib/waiverguard.ts, and it runs
 * after this.
 */
export function parseWaiverOverride(
  raw: unknown,
): WaiverOverrideAsk | string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") {
    return "waiverOverride must be an object with token and reason";
  }
  const token = (raw as { token?: unknown }).token;
  const reason = (raw as { reason?: unknown }).reason;
  if (typeof token !== "string" || token.length === 0) {
    return "waiverOverride.token is required";
  }
  if (typeof reason !== "string") {
    return "waiverOverride.reason is required";
  }
  const trimmed = reason.trim();
  if (trimmed.length < WAIVER_REASON_MIN) {
    return `a reason of at least ${WAIVER_REASON_MIN} characters is required to go past the waiver`;
  }
  if (trimmed.length > WAIVER_REASON_MAX) {
    return `the reason must be at most ${WAIVER_REASON_MAX} characters`;
  }
  return { token, reason: trimmed };
}
