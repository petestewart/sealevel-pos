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
 *  No scope is the cancel every flow has always sent: since T241 it
 *  names its tab (`presenter`) and is a no-op (`foreign`) against a
 *  ticket another tab owns, unless that is a live mirror being taken
 *  over. `scope: "live"` keeps that owner check; `scope: "reset"` does
 *  not, and tells the owning tab (`ticket-retired`). */
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
  let presenter: string | null = null;
  let requestId: string | undefined;
  let scope: "live" | "reset" | null = null;
  let confirm = false;
  /** T244 review: the scene the teacher was asked about, on "Clear it". */
  let confirmedHeld: string | null = null;
  try {
    const body: unknown = await request.json();
    const b =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>)
        : {};
    takenOver = b["takenOver"] === true;
    /* T241 second review (N3): the tab this cancel comes from. A ticket
     * another tab owns is not this cancel's to take down (a no-op that
     * answers `foreign`), unless it is a live mirror being taken over. */
    presenter = typeof b["presenter"] === "string" ? b["presenter"] : null;
    requestId =
      typeof b["requestId"] === "string" ? (b["requestId"] as string) : undefined;
    if (b["scope"] === "live" || b["scope"] === "reset") scope = b["scope"];
    confirm = b["confirm"] === true;
    if (typeof b["held"] === "string") confirmedHeld = b["held"];
  } catch {
    /* No body: a plain cancel, from no tab in particular. */
  }

  if (scope === "live") {
    /* T244 with T241: a live ticket or a summary, and only one THIS tab
     * owns (or a live ticket nobody has presented for two minutes). */
    const done = await cancelRequest(Date.now(), {
      only: (held) => isQuietScene(held),
      teacher: {
        presenter,
        staleLive: true,
        ...(requestId !== undefined ? { requestId } : {}),
      },
    });
    return NextResponse.json({
      ok: true,
      cancelled: done.cancelled,
      held: done.held,
      ...(done.foreign === true ? { foreign: true } : {}),
    });
  }

  if (scope === "reset") {
    const staffId = actor.session.staffId;
    const done = await cancelRequest(Date.now(), {
      /* A confirmation clears only the kind of scene it was given for:
       * if a different one is up now, the teacher is asked again. */
      only: (held) =>
        isQuietScene(held) || (confirm && confirmedHeld !== null && held === confirmedHeld),
      /* Whoever owns it; the owning tab is told. */
      reset: true,
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

  const { cancelled, foreign } = await cancelRequest(Date.now(), {
    takenOver,
    teacher: {
      presenter,
      ...(requestId !== undefined ? { requestId } : {}),
    },
  });
  return NextResponse.json({
    ok: true,
    cancelled,
    ...(foreign === true ? { foreign: true } : {}),
  });
}
