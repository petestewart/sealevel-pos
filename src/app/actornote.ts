/**
 * The amber line a write answers with when it ran as the studio account
 * after the signed-in teacher's token was refused (T49). Shared by the
 * roster (row notes, the banner), the sale screen (the done block) and
 * the contract dialog, so the wording is one wording.
 */

export interface ActorFallback {
  name: string;
  reason: string;
}

export function actorFallbackLine(fb: ActorFallback): string {
  /* A refused TOKEN (the server has already ended the staff session on
   * it) is not a missing permission: the line says the sign-in ended
   * and to sign in again. */
  if (/token|expired|unauthori/i.test(fb.reason)) {
    return `Done as the studio account: ${fb.name}'s Mindbody sign-in ended (${fb.reason.replace(/\.$/, "")}). Sign in again.`;
  }
  /* Mindbody's refusals read "You do not have permission to perform
   * sales" (and, CLAUDE.md, the same words for a missing cart
   * permission); the line names what was lacking when the message says,
   * and quotes the message otherwise. */
  const m = /permission to ([^.]+)/i.exec(fb.reason);
  const lacks = m
    ? `permission to ${m[1]!.trim()}`
    : `what this needs (${fb.reason.replace(/\.$/, "")})`;
  return `Done as the studio account: ${fb.name}'s Mindbody login lacks ${lacks}.`;
}
