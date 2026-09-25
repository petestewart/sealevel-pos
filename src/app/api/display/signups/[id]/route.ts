import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { clearSignup, signupById } from "@/lib/display";
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
 * and the result goes with it. Since T208 it spends the handle whatever
 * the by-id lookup says, because a row a teacher can see and cannot
 * clear is worse than one cleared twice. No Mindbody call in either
 * verb.
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
  /* T208: unconditional. Pete's second drive: "i can't clear the failed
   * one from the previous build." This used to consume only what the
   * by-id lookup resolved, so a row the tray was listing and this
   * answered null for was cleared by nothing and came back on the next
   * poll. `clearSignup` drops it from memory, remembers the id as spent
   * and marks the table row by id, whatever any store says about it.
   * Still no Mindbody call: nobody is created either way. */
  const spent = await clearSignup(id);
  if (spent.wrongKind) {
    /* T208 review: this route clears SIGN-UPS. A waiver, a ticket
     * approval or a contract signature is finished somewhere else, and
     * spending one here would blank the screen under the student. */
    return NextResponse.json(
      { error: "That is not a sign-up waiting for a teacher.", cleared: false },
      { status: 404 },
    );
  }
  console.log(
    `[display] sign-up ${id} cleared by staff=${actor.session.staffId} without creating anybody` +
      (spent.marked ? "" : " (no row was marked)"),
  );
  return NextResponse.json({ cleared: true });
}
