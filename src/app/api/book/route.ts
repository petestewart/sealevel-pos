import { NextResponse } from "next/server";

import { actorFields, actorFor, runAsActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import { bookClientIntoClass } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * Book a client into a class (`POST /class/addclienttoclass`), the
 * money-free half of walk-in booking. Three shapes, one endpoint:
 *
 * - `{clientId, classId}` books.
 * - `{clientId, classId, waitlist: true}` queues, for a full class.
 * - `{clientId, classId, waitlistEntryId}` promotes off the waiting list.
 *
 * Any of them may carry `clientServiceId`, the pricing option explicitly
 * chosen to pay for the booking (the search modal's pass picker); absent
 * means Mindbody picks, as it always did.
 *
 * The write goes through the mindbody() client, so dry run and the
 * POS_WRITE_CLIENT_IDS guard both apply; a suppressed booking is reported
 * as such rather than pretending a visit exists. T49: as the signed-in
 * teacher when there is one, with the one loud fallback.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  try {
    const { clientId, classId, waitlist, waitlistEntryId, clientServiceId } =
      await request.json();
    if (typeof clientId !== "string" || !clientId) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    if (typeof classId !== "number") {
      return NextResponse.json(
        { error: "classId (number) is required" },
        { status: 400 },
      );
    }
    const { session } = actorFor(request);
    const run = await runAsActor(session, "/api/book", (actor) =>
      bookClientIntoClass({
        clientId,
        classId,
        waitlist: waitlist === true,
        waitlistEntryId:
          typeof waitlistEntryId === "number" ? waitlistEntryId : undefined,
        clientServiceId:
          typeof clientServiceId === "number" ? clientServiceId : undefined,
        actor,
      }),
    );
    return NextResponse.json({ ok: true, ...run.result, ...actorFields(run) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
