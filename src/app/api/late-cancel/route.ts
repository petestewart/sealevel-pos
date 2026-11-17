import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { mindbodyHttpStatus } from "@/lib/mindbody";

import { setLateCancelled } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * T245: mark a visit as a late cancel (`undo: false`, the default) or
 * take the mark off (`undo: true`), from the roster's trash and the late
 * row's Undo.
 *
 * `POST /client/updateclientvisit` with ONLY `{VisitId, Execute:
 * "Latecancel" | "Unlatecancel"}` (src/lib/roster.ts setLateCancelled).
 * The booking stays, the pass stays and nothing is charged: that is
 * exactly what the studio's own Late Cancel in Mindbody's UI does (Pete,
 * 2026-11-17, and Andie's visit 1305761 read live). Never
 * `removeclientfromclass` with `LateCancel`, which removes the booking.
 *
 * Under the teacher's token (T49/T50: `requireActor`, then
 * `runAsActor`), through mindbody() with the client id, so dry run and
 * the write guard apply and a suppressed write is reported as such.
 * Pessimistic: the browser's row spins until this answers.
 *
 * A Mindbody 4xx answers 409 `reason: "refused"` with Mindbody's own
 * sentence (the row changes nothing); anything else that failed is a 502.
 * A 200 whose Visit says the flag did NOT move answers `applied: false`
 * so the screen can say so rather than greying a row Mindbody did not
 * mark.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write, before the body is read. */
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ error: "a JSON body is required" }, { status: 400 });
  }
  const { visitId, clientId, undo } = (parsed ?? {}) as {
    visitId?: unknown;
    clientId?: unknown;
    undo?: unknown;
  };
  if (typeof visitId !== "number" || !Number.isInteger(visitId) || visitId <= 0) {
    return NextResponse.json(
      { error: "visitId (a positive integer) is required" },
      { status: 400 },
    );
  }
  /* The client id is what the write guard checks; without it an armed
   * guard would suppress every mark, and a mark for nobody in
   * particular is not something the roster ever sends. */
  if (typeof clientId !== "string" || !clientId) {
    return NextResponse.json(
      { error: "clientId (string) is required" },
      { status: 400 },
    );
  }
  if (undo !== undefined && typeof undo !== "boolean") {
    return NextResponse.json(
      { error: "undo must be true or false" },
      { status: 400 },
    );
  }
  const lateCancel = undo !== true;
  const route = "/api/late-cancel";
  try {
    const run = await runAsActor(session, route, (actor) =>
      setLateCancelled(visitId, lateCancel, clientId, actor),
    );
    const { suppressed, lateCancelled } = run.result;
    const applied =
      suppressed !== null ? false : lateCancelled === null || lateCancelled === lateCancel;
    console.log(
      `[late-cancel] ${lateCancel ? "Latecancel" : "Unlatecancel"} visit=${visitId} ` +
        `client=${clientId} staff=${session?.staffId ?? "(none)"} ` +
        (suppressed ? `suppressed=${suppressed}` : `answered LateCancelled=${lateCancelled ?? "(not said)"}`),
    );
    return NextResponse.json({
      ok: true,
      lateCancel,
      suppressed,
      applied,
      lateCancelled,
      ...actorFields(run),
    });
  } catch (err) {
    /* T50 review: the teacher's token died under this write. */
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    const message = err instanceof Error ? err.message : String(err);
    const status = mindbodyHttpStatus(err);
    console.warn(
      `[late-cancel] ${lateCancel ? "Latecancel" : "Unlatecancel"} visit=${visitId} ` +
        `client=${clientId} failed (${status ?? "no status"}): ${message}`,
    );
    if (status !== null && status >= 400 && status < 500) {
      return NextResponse.json(
        { error: message, reason: "refused" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
