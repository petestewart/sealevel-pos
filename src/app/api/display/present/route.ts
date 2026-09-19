import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import {
  PAYLOAD_LIMIT_BYTES,
  SUMMARY_TTL_MS,
  isDisplayRequestKind,
  presentRequest,
  readJsonObject,
} from "@/lib/display";
import { readTicketPayload } from "@/lib/displayticket";

export const dynamic = "force-dynamic";

/**
 * A teacher puts a scene on the customer display (T112).
 *
 * The device session AND a signed-in teacher, exactly like every write
 * route here: with nobody signed in this answers 401 `reason: "staff"`
 * and the sign-in gate comes back. The staff id on the request is the
 * session's, never the browser's: the request records who put the scene
 * up, and that is who Mindbody will name when the result is finalised
 * from this teacher's iPad later.
 *
 * THIS ROUTE CALLS MINDBODY NOWHERE. Presenting a scene is a server-side
 * handoff between two browsers; the writes stay in the routes that
 * already have them.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  if (!isDisplayRequestKind(input.kind)) {
    return NextResponse.json(
      { error: "kind must be waiver, ticket, register or contract" },
      { status: 400 },
    );
  }
  const payload = readJsonObject(input.payload ?? {}, PAYLOAD_LIMIT_BYTES);
  if (!payload.ok) {
    return NextResponse.json(
      { error: `payload: ${payload.error}` },
      { status: 400 },
    );
  }
  /* T114: a ticket's payload is rebuilt field by field rather than
   * forwarded. The generic check above only says "a JSON object under
   * 64KB"; this one says what a ticket IS, and everything else the body
   * carried (a client id, a pricing option id, a product id, a card
   * number) is dropped here rather than travelling to a screen a student
   * is holding. */
  let scene = payload.value;
  let ttlMs: number | undefined;
  if (input.kind === "ticket") {
    const ticket = readTicketPayload(payload.value);
    if (!ticket.ok) {
      return NextResponse.json(
        { error: `payload: ${ticket.error}` },
        { status: 400 },
      );
    }
    scene = ticket.value;
    /* The summary ends by itself: a teacher's tab that closes, sleeps or
     * reloads must not leave one student's ticket in front of the next
     * one in the queue. */
    if (ticket.value.mode === "summary") ttlMs = SUMMARY_TTL_MS;
  }
  /* The one thing a scene may carry about the person in front of it: a
   * first name, for the greeting. Trimmed and bounded here so a payload
   * cannot smuggle a paragraph in through it. */
  const first = input.clientFirstName;
  const clientFirstName =
    typeof first === "string" && first.trim().length > 0
      ? first.trim().slice(0, 40)
      : null;

  const presented = await presentRequest({
    kind: input.kind,
    payload: {
      ...scene,
      ...(clientFirstName === null ? {} : { clientFirstName }),
    },
    initiator: "teacher",
    requestedByStaffId: String(actor.session.staffId),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  if (!presented.ok) {
    /* T114: `reason` is what lets the live mirror drop a refusal the
     * teacher never asked for. "busy" means something else holds the
     * screen (a waiver, a sign-up, a summary), which the design says is
     * skipped silently and resumes on the next priced change. */
    return NextResponse.json(
      { error: presented.error, reason: presented.reason },
      { status: presented.status },
    );
  }
  return NextResponse.json({
    ok: true,
    requestId: presented.request.id,
    kind: presented.request.kind,
    /* True when this replaced a live ticket in place rather than putting
     * a new scene up. */
    replaced: presented.replaced,
    expiresAt: new Date(presented.request.expiresAt).toISOString(),
  });
}
