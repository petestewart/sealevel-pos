/**
 * T59c: what makes a pass a guest pass, in one place for both sides of
 * the wire. The studio's pricing option is "Guest Pass (for auto-debit
 * members only)", a $0 one-session pass the auto-renew membership drops
 * onto the MEMBER's account each month (T47, T59); the name is the only
 * thing that marks it, and Mindbody carries no "guest" flag. The match
 * is on the words, case-insensitively, so a renamed option still reads
 * as one as long as it says "guest pass".
 *
 * Pure functions, no I/O: page.tsx (the picker, the row action) and the
 * guest route (the server's own re-check before it writes) share them.
 */

export interface GuestPassLike {
  id: number | null;
  name: string;
  remaining: number | null;
}

export function isGuestPass(name: string): boolean {
  return /guest\s*pass/i.test(name);
}

/** A guest pass with a session left and an id to write with, or null.
 *  A guest pass at zero is not offered: the pass list is ShowActiveOnly
 *  so it usually is not there at all (T57), and a null Remaining is
 *  treated as unknown rather than unlimited, because a guest pass is
 *  one session and a Mindbody that omitted the count is not evidence
 *  of a session to spend. */
/**
 * T62: whether the guest's visit really landed on the member's pass.
 * Pete's live probe (2026-09-04): Mindbody ACCEPTED `addclienttoclass`
 * with the member's Guest Pass id on the guest, paid the visit with the
 * guest's OWN pass, left the member's pass at 1 left, and said nothing;
 * the app reported success. So the write's answer is not the record,
 * the visit and the pass are, and both are read back:
 *
 *   - `visit` is what Mindbody says paid the visit (the booking answer's
 *     ServiceId, or a `/class/classvisits` re-read); null when neither
 *     could be read. A visit on a different pass, or on none, is the
 *     probe's case exactly.
 *   - `remaining` is the member's pass before and after; `after` null
 *     means the pass has left the ShowActiveOnly list (T57), which a
 *     spent one-session pass does. A count that did not move is the
 *     other half of the probe's evidence, and trips the judgement on
 *     its own: a visit Mindbody says is on the pass while the pass still
 *     shows the session is a Mindbody in two minds, and the safe answer
 *     is the one that writes nothing more.
 *
 * "unverified" is both reads failing: nothing is known either way, and
 * the caller says so rather than guessing. Pure, so it can be tested
 * without Mindbody.
 */
export type GuestPassVerdict = "landed" | "ignored" | "unverified";

export function judgeGuestPass(opts: {
  sent: number;
  visit: { clientServiceId: number | null } | null;
  remaining: { before: number; after: number | null } | null;
}): GuestPassVerdict {
  const { sent, visit, remaining } = opts;
  if (visit === null && remaining === null) return "unverified";
  if (visit !== null && visit.clientServiceId !== sent) return "ignored";
  if (remaining !== null && remaining.after !== null && remaining.after >= remaining.before) {
    return "ignored";
  }
  return "landed";
}

/** The sentence the sheet shows for an ignored pass id: what Mindbody
 *  did instead, and the one remedy that gives the session back. */
export function ignoredPassMessage(opts: {
  guestName: string;
  memberName: string;
  /** The pass Mindbody used instead; null when the visit carries none;
   *  undefined when the visit could not be read and only the member's
   *  unmoved count says the pass was not spent. */
  ownPass: string | null | undefined;
}): string {
  const instead =
    opts.ownPass === undefined
      ? `${opts.guestName} without spending`
      : opts.ownPass === null
        ? `${opts.guestName} with no pass instead of`
        : `${opts.guestName} on their own pass (${opts.ownPass}) instead of`;
  return (
    `Mindbody booked ${instead} ${opts.memberName}'s guest pass. ` +
    `Remove them from the class to give that session back.`
  );
}

export function usableGuestPass<P extends GuestPassLike>(
  passes: readonly P[] | null | undefined,
): (P & { id: number }) | null {
  for (const p of passes ?? []) {
    if (
      p.id !== null &&
      isGuestPass(p.name) &&
      p.remaining !== null &&
      p.remaining > 0
    ) {
      return p as P & { id: number };
    }
  }
  return null;
}
