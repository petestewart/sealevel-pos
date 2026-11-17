import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import {
  cancelRequest,
  isQuietScene,
  resetQuestion,
} from "@/lib/display";

export const dynamic = "force-dynamic";

/** The teacher takes the scene back down (T200). Same auth as present,
 *  and the same rule: no Mindbody call anywhere in it. Cancelling
 *  something that is not there still answers 200 and still pushes the
 *  display to idle, because the server's picture is the one that wins.
 *
 *  T244 adds two scopes, decided HERE rather than in the browser, so a
 *  tab that has forgotten what it put up cannot get it wrong:
 *
 *  - `scope: "live"` is the teacher's tab reconciling on load and on
 *    return (iPadOS reloads a backgrounded Safari tab with an empty cart
 *    and no memory of the ticket it left up). It takes down a live
 *    ticket or a post-sale summary and NOTHING else: a waiver, a
 *    sign-up, a contract or an approval is answered as a no-op with
 *    `held` naming it, and no event reaches the display.
 *  - `scope: "reset"` is "Reset customer screen". A live ticket, a
 *    summary or nothing goes at once; anything a student is in asks
 *    first (409 `reason: "confirm"` with the question in words) unless
 *    `confirm: true`. Every reset logs the teacher's staff id.
 *
 *  No scope is the cancel every flow has always sent, unchanged. */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  /* T203: `takenOver` says the teacher needed the screen for something
   * else, so the display apologises for a few seconds instead of
   * blinking back to Ready in front of a student who was half way
   * through something. A body is optional; anything unreadable is a
   * plain cancel, because a cancel must never fail for want of JSON. */
  let takenOver = false;
  let scope: "live" | "reset" | null = null;
  let confirm = false;
  /** T244 review: the scene the teacher was asked about, on "Clear it". */
  let confirmedHeld: string | null = null;
  try {
    const body: unknown = await request.json();
    if (body !== null && typeof body === "object") {
      const b = body as Record<string, unknown>;
      takenOver = b["takenOver"] === true;
      if (b["scope"] === "live" || b["scope"] === "reset") scope = b["scope"];
      confirm = b["confirm"] === true;
      if (typeof b["held"] === "string") confirmedHeld = b["held"];
    }
  } catch {
    /* No body: a plain cancel. */
  }

  if (scope === "live") {
    const done = await cancelRequest(Date.now(), {
      only: (held) => isQuietScene(held),
    });
    return NextResponse.json({
      ok: true,
      cancelled: done.cancelled,
      held: done.held,
    });
  }

  if (scope === "reset") {
    const staffId = actor.session.staffId;
    const done = await cancelRequest(Date.now(), {
      /* A confirmation clears only the kind of scene it was given for:
       * if a different one is up now, the teacher is asked again. */
      only: (held) =>
        isQuietScene(held) || (confirm && confirmedHeld !== null && held === confirmedHeld),
    });
    if (!done.cancelled && done.held !== null && !isQuietScene(done.held)) {
      return NextResponse.json(
        {
          ok: false,
          reason: "confirm",
          held: done.held,
          error: resetQuestion(done.held),
        },
        { status: 409 },
      );
    }
    console.log(
      `[display] reset by staff ${staffId}: ` +
        (done.cancelled ? `cleared ${done.held}` : "nothing was up, sent idle"),
    );
    return NextResponse.json({
      ok: true,
      cancelled: done.cancelled,
      held: done.held,
    });
  }

  const { cancelled } = await cancelRequest(Date.now(), { takenOver });
  return NextResponse.json({ ok: true, cancelled });
}
