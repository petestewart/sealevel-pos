import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { search } from "@/lib/clients";
import { pendingSignups } from "@/lib/display";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const limit = Number(params.get("limit") ?? 12);
  /* T42: the page offset for the scroll-loaded list. One metered call per
   * page; a bad value reads as the first page rather than a 400, since
   * the only caller is our own modal. */
  const offset = Number(params.get("offset") ?? 0);
  try {
    const answer = await search(
      q,
      Number.isFinite(limit) ? limit : 12,
      Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
    );
    /* T204: somebody who signed themselves up on the customer screen
     * and has not been created yet is not in Mindbody, so Mindbody's
     * own search cannot find them -- and "I just signed up" is exactly
     * what the student says while the teacher types their name. They
     * ride ABOVE the results, on the FIRST page only (a scroll for page
     * two is a scroll through Mindbody's list), matched case-insensitively
     * on either name as a prefix, and carry a request id and a name and
     * nothing else: never the email, the phone or the signature. */
    const pending = await pendingSignupHits(q, offset);
    return NextResponse.json(
      pending.length === 0 ? answer : { ...answer, pendingSignups: pending },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

/** The waiting sign-ups whose first or last name starts with the query.
 *  Three letters, like the search itself: the walk-in box does not call
 *  Mindbody below that and this must not put a name on screen under a
 *  query that is still being typed. */
async function pendingSignupHits(
  q: string,
  offset: number,
): Promise<
  {
    pendingSignup: true;
    requestId: string;
    firstName: string;
    lastName: string;
    completedAt: string | null;
  }[]
> {
  const needle = q.trim().toLowerCase();
  if (needle.length < 3 || (Number.isFinite(offset) && offset > 0)) return [];
  const waiting = await pendingSignups();
  return waiting
    .filter(
      (s) =>
        s.firstName.toLowerCase().startsWith(needle) ||
        s.lastName.toLowerCase().startsWith(needle),
    )
    .map((s) => ({
      pendingSignup: true as const,
      requestId: s.requestId,
      firstName: s.firstName,
      lastName: s.lastName,
      completedAt: s.completedAt,
    }));
}
