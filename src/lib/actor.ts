import { NextResponse } from "next/server";

import { isActorRefusal, isActorTokenDead, type Actor } from "./mindbody";
import {
  actorOf,
  endStaffSession,
  staffSessionFrom,
  type StaffSession,
} from "./staffsession";

/**
 * Running a write as the signed-in teacher, with the one fallback (T49).
 *
 * The rule: a write runs under the signed-in teacher's token (T50: a
 * sign-in is required, see requireActor; there is no signed-out write
 * any more), and if Mindbody refuses THE TEACHER (401/403, or its "You
 * do not have permission" wording, see isActorRefusal) it is retried
 * ONCE as the service account, which then succeeds or fails on its own
 * merits. The answer carries `actorFallback: {name, reason}` so the UI
 * can say, in amber, "Done as the studio account: Kim Farrell's Mindbody
 * login lacks ..." and the server logs `[actor] fallback ...`. The
 * counter keeps working; the permission gap is loud, not silent, and
 * not fatal.
 *
 * Why a retry is safe on a money write: a refusal is a 4xx, which is the
 * request being refused at the gate, before anything processed (the
 * same reasoning /api/checkout already applies to "nothing was
 * charged"). isActorRefusal never matches a 5xx or a dead transport, so
 * an ambiguous first attempt is never followed by a second.
 *
 * A 401 under the teacher's token reads as the token itself being dead
 * (isActorTokenDead): the staff session ends, the fallback still runs,
 * and the answer adds `staffSessionEnded: true` so the browser drops the
 * teacher and shows the sign-in gate again (T50).
 *
 * `fallback: false` is the comp's posture: a comp under a teacher's
 * token that Mindbody refuses is REFUSED, with the message, never
 * quietly done as somebody else. The session still ends on a dead
 * token.
 */

export interface ActorFallback {
  name: string;
  reason: string;
}

export interface ActorOutcome<T> {
  result: T;
  /** Set when the write ran as the service account after the teacher's
   *  token was refused; null when it ran as intended (either way). */
  actorFallback: ActorFallback | null;
  /** True when the teacher's token was refused as no longer valid and
   *  the staff session has been ended. */
  staffSessionEnded: boolean;
}

/**
 * T50: the sign-in is required. Pete, after the T49 live test: "seems
 * like it's optional to login. that shouldn't be the case." Every write
 * route calls this first (after the device session) and answers the 401
 * as-is when nobody is signed in, so no write ever runs as the service
 * account for want of a teacher. The wording is the browser's cue: the
 * fetch wrapper reads `reason: "staff"` as "show the sign-in gate", not
 * as the device lock (a bare 401) or the comp PIN (`reason: "teacher"`).
 *
 * Reads stay open and stay on the service account: the roster, search,
 * the catalog and a profile carry nobody's name in Mindbody.
 *
 * The fallback in runAsActor is untouched by this: it is what happens
 * when a SIGNED-IN teacher's token is refused, and that can only start
 * from a session this helper found.
 */
export function requireActor(
  request: Request,
):
  | { denied: NextResponse; session: null }
  | { denied: null; session: StaffSession; actor: Actor } {
  const session = staffSessionFrom(request);
  if (session === null) {
    return {
      denied: NextResponse.json(
        { error: "Sign in to Mindbody first.", reason: "staff" },
        { status: 401 },
      ),
      session: null,
    };
  }
  return { denied: null, session, actor: actorOf(session) };
}

export async function runAsActor<T>(
  session: StaffSession | null,
  route: string,
  run: (actor: Actor | null) => Promise<T>,
  opts: { fallback?: boolean } = {},
): Promise<ActorOutcome<T>> {
  if (session === null) {
    return {
      result: await run(null),
      actorFallback: null,
      staffSessionEnded: false,
    };
  }
  const actor = actorOf(session);
  try {
    return {
      result: await run(actor),
      actorFallback: null,
      staffSessionEnded: false,
    };
  } catch (err) {
    if (!isActorRefusal(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    let staffSessionEnded = false;
    if (isActorTokenDead(err)) {
      staffSessionEnded = true;
      console.warn(
        `[actor] token refused staff=${session.staffId} route=${route}; ending the staff session`,
      );
      await endStaffSession(session.id);
    }
    if (opts.fallback === false) {
      /* A comp: refused is refused. The error keeps its message; the
       * route answers it as it always did. The session state above is
       * the one thing that changed. */
      (err as Error & { staffSessionEnded?: boolean }).staffSessionEnded =
        staffSessionEnded;
      throw err;
    }
    console.warn(
      `[actor] fallback staff=${session.staffId} route=${route} reason=${JSON.stringify(reason)}`,
    );
    return {
      result: await run(null),
      actorFallback: { name: session.name, reason },
      staffSessionEnded,
    };
  }
}

/** The response fields a write route adds for the UI: only what is
 *  true, so an unaffected answer is byte-for-byte what it was. */
export function actorFields(outcome: {
  actorFallback: ActorFallback | null;
  staffSessionEnded: boolean;
}): Record<string, unknown> {
  return {
    ...(outcome.actorFallback ? { actorFallback: outcome.actorFallback } : {}),
    ...(outcome.staffSessionEnded ? { staffSessionEnded: true } : {}),
  };
}

/** Whether an error thrown by runAsActor with fallback off ended the
 *  staff session, for the route's answer. */
export function endedStaffSession(err: unknown): boolean {
  return (
    (err as { staffSessionEnded?: unknown } | null)?.staffSessionEnded === true
  );
}
