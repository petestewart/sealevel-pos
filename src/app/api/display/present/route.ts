import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import {
  PAYLOAD_LIMIT_BYTES,
  isDisplayRequestKind,
  presentRequest,
  readJsonObject,
} from "@/lib/display";

export const dynamic = "force-dynamic";

/**
 * A teacher puts a scene on the customer display (T113).
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
      ...payload.value,
      ...(clientFirstName === null ? {} : { clientFirstName }),
    },
    initiator: "teacher",
    requestedByStaffId: String(actor.session.staffId),
  });
  if (!presented.ok) {
    return NextResponse.json(
      { error: presented.error },
      { status: presented.status },
    );
  }
  return NextResponse.json({
    ok: true,
    requestId: presented.request.id,
    kind: presented.request.kind,
    expiresAt: new Date(presented.request.expiresAt).toISOString(),
  });
}
