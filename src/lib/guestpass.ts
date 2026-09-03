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
