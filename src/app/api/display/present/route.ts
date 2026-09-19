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
import { cartSha256 } from "@/lib/cartsha";
import { readTicketPayload } from "@/lib/displayticket";
import { readWaiverPayload } from "@/lib/displaywaiver";
import { readClientFirstName } from "@/lib/clients";
import { getWaiver } from "@/lib/waiver";

export const dynamic = "force-dynamic";

/**
 * A teacher puts a scene on the customer display (T200).
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
  /* T201: a ticket's payload is rebuilt field by field rather than
   * forwarded. The generic check above only says "a JSON object under
   * 64KB"; this one says what a ticket IS, and everything else the body
   * carried (a client id, a pricing option id, a product id, a card
   * number) is dropped here rather than travelling to a screen a student
   * is holding. */
  let scene = payload.value;
  let ttlMs: number | undefined;
  let privateHalf: Record<string, unknown> | undefined;
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
    /* T203: an APPROVE ticket is the one the student answers, and the
     * answer is only worth anything if the server knows WHICH ticket was
     * approved. So the request's SERVER-ONLY half records the client the
     * sale is for and the sha256 of the cart as presented, computed HERE
     * from the cart the browser sends beside the payload -- the same
     * `items`/`giftCards`/`discount`/`clientId` it sends to
     * /api/price-cart and /api/checkout. The browser never sends a hash:
     * a promise that the ticket has not changed, made by the thing that
     * changes it, is not a promise. /api/checkout hashes the cart it is
     * about to charge with the same helper and refuses a mismatch.
     *
     * Neither figure reaches the display: `private` never passes through
     * sceneFor, so the student's screen still carries only the ticket. */
    if (ticket.value.mode === "approve") {
      const cart =
        input.cart !== null && typeof input.cart === "object"
          ? (input.cart as Record<string, unknown>)
          : {};
      privateHalf = {
        clientId:
          typeof cart["clientId"] === "string" ? cart["clientId"].trim() : "",
        cartSha256: cartSha256(cart),
      };
    }
  }
  /* T202: a WAIVER's payload is built here, not forwarded. The browser
   * sends a client id and nothing that matters; the server fetches its
   * own copy of the waiver text (the same cache /api/waiver and
   * /api/waiver-agree read, so the hash the receipt names is the hash of
   * what was shown), looks the first name up itself, and keeps the
   * client id and that hash on the request's SERVER-side half. The
   * display is told neither: it has no use for an identifier, and a
   * screen in a student's hands is the last place to put one. */
  if (input.kind === "waiver") {
    const clientId =
      typeof input.clientId === "string" ? input.clientId.trim() : "";
    if (clientId.length === 0) {
      return NextResponse.json(
        { error: "clientId is required for a waiver" },
        { status: 400 },
      );
    }
    let waiver: { text: string; sha256: string };
    try {
      waiver = await getWaiver();
    } catch (err) {
      /* No text, no scene: a student must never be asked to agree to a
       * blank screen, and the counter dialog is still there. */
      return NextResponse.json(
        {
          error: `The waiver text could not be fetched (${err instanceof Error ? err.message : String(err)}).`,
        },
        { status: 502 },
      );
    }
    const built = readWaiverPayload({
      text: waiver.text,
      clientFirstName: await readClientFirstName(clientId),
    });
    if (!built.ok) {
      return NextResponse.json(
        { error: `payload: ${built.error}` },
        { status: 502 },
      );
    }
    scene = built.value as unknown as Record<string, unknown>;
    privateHalf = { clientId, textSha256: waiver.sha256 };
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
      /* A waiver's first name is the SERVER's, looked up above; a hint
       * from the browser does not get to overwrite it. */
      ...(clientFirstName === null || input.kind === "waiver"
        ? {}
        : { clientFirstName }),
    },
    ...(privateHalf === undefined ? {} : { private: privateHalf }),
    initiator: "teacher",
    requestedByStaffId: String(actor.session.staffId),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  if (!presented.ok) {
    /* T201: `reason` is what lets the live mirror drop a refusal the
     * teacher never asked for. "busy" means something else holds the
     * screen (a waiver, a sign-up, a summary), which the design says is
     * skipped silently and resumes on the next priced change. */
    return NextResponse.json(
      {
        error: presented.error,
        reason: presented.reason,
        /* T204: a busy screen says WHAT is on it when it is a student's
         * own sign-up, because that is the one case the teacher's screen
         * words differently and offers Take over for. */
        ...(presented.holdingSignup === true ? { holdingSignup: true } : {}),
      },
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
