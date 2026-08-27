import { NextResponse } from "next/server";

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
 * The write goes through the mindbody() client, so dry run and the
 * POS_WRITE_CLIENT_IDS guard both apply; a suppressed booking is reported
 * as such rather than pretending a visit exists.
 */
export async function POST(request: Request) {
  try {
    const { clientId, classId, waitlist, waitlistEntryId } =
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
    const result = await bookClientIntoClass({
      clientId,
      classId,
      waitlist: waitlist === true,
      waitlistEntryId:
        typeof waitlistEntryId === "number" ? waitlistEntryId : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
