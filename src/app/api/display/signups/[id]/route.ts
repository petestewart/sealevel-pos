import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { consumeRequest, signupById } from "@/lib/display";
import { signupFormOf } from "@/lib/displaysignup";

export const dynamic = "force-dynamic";

/**
 * One waiting sign-up, for the form the teacher is about to read back
 * (T204).
 *
 * This is the ONE place a student's typed email and phone are served to
 * a browser, and it is a signed-in teacher's own iPad behind the device
 * session. It carries the form and the two consent answers and NEVER
 * the signature: the PNG is the server's, and the create pulls it from
 * the server's own store the way T202's release does. The result is
 * deleted on consume, or when its four hours are up.
 *
 * DELETE is the tray's "Clear": the student never came to the counter,
 * or signed up twice, so the handle is spent without creating anybody
 * and the result goes with it. No Mindbody call in either verb.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  const { id } = await context.params;
  const held = await signupById(id);
  const read = held === null ? null : signupFormOf(held.result);
  if (held === null || read === null) {
    return NextResponse.json(
      {
        error:
          "That sign-up is no longer waiting. Ask them to sign up again on the customer screen.",
      },
      { status: 404 },
    );
  }
  return NextResponse.json({
    requestId: held.id,
    form: read.form,
    consent: read.consent,
    completedAt:
      held.completedAt === null
        ? null
        : new Date(held.completedAt).toISOString(),
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  const { id } = await context.params;
  const held = await signupById(id);
  if (held === null) {
    /* Already gone is the outcome the teacher asked for. */
    return NextResponse.json({ cleared: false });
  }
  const spent = await consumeRequest(id);
  console.log(
    `[display] sign-up ${id} cleared by staff=${actor.session.staffId} without creating anybody`,
  );
  return NextResponse.json({ cleared: spent !== null });
}
