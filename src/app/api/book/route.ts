import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import { bookClientIntoClass, classIsFull } from "@/lib/roster";

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
 *
 * T208: **capacity is checked HERE, not in the browser.** Pete's second
 * drive put three people in a class of two. Mindbody's API does not
 * enforce capacity (class.yml:1077 says the caller must check
 * `MaxCapacity`, `TotalBooked` and `IsAvailable` first), and the
 * `waitlist` flag arrives from a class summary that can be minutes old,
 * so a plain booking now costs one fresh read of that one class and
 * goes onto the WAITING LIST instead when the count says the class is
 * full. The answer says `waitlisted: true` with a sentence for the
 * screen, so nobody is told they are in a class they are not. A
 * promotion (`waitlistEntryId`) is exempt: it is a seat Mindbody
 * already decided on. The read is on the service account, like every
 * read, and a read that cannot answer books exactly as asked.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read, so a
   * signed-out iPad hears only the 401 and never a validation detail
   * or a Mindbody read made on its behalf. */
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
  try {
    const {
      clientId,
      classId,
      waitlist,
      waitlistEntryId,
      clientServiceId,
      /* T208 review: the class's own start, as the screen holds it, so
       * the capacity read below asks about the right DAY. Mindbody's
       * `/class/classes` ends its window at today by default, so a
       * by-id read with none comes back empty for tomorrow's class. It
       * decides nothing but which day is asked about. */
      classStartsAt,
    } = await request.json();
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
    let queue = waitlist === true;
    const promoting = typeof waitlistEntryId === "number";
    /* T208: the browser's flag can only ADD a waiting list here; what it
     * cannot do is keep a full class from being overbooked, because the
     * count it read may be minutes old. One metered read settles it. */
    let waitlistReason: string | null = null;
    if (!queue && !promoting) {
      /* Never fatal: a read that did not answer must not refuse a
       * booking the teacher asked for, and Mindbody's own refusal is
       * still behind it. */
      const full = await classIsFull(
        classId,
        typeof classStartsAt === "string" ? classStartsAt : null,
      ).catch((err: unknown) => {
        console.warn(
          `[book] capacity read failed for class ${classId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      });
      if (full === true) {
        queue = true;
        waitlistReason = "Class was full, added to the waiting list";
        console.log(
          `[book] class ${classId} is full; client ${clientId} went onto the waiting list`,
        );
      }
    }
    const run = await runAsActor(session, "/api/book", (actor) =>
      bookClientIntoClass({
        clientId,
        classId,
        waitlist: queue,
        waitlistEntryId: promoting ? (waitlistEntryId as number) : undefined,
        clientServiceId:
          typeof clientServiceId === "number" ? clientServiceId : undefined,
        actor,
      }),
    );
    return NextResponse.json({
      ok: true,
      ...run.result,
      /* What actually happened, for a screen that must not say "checked
       * in" about somebody in a queue. `waitlistReason` is set only when
       * the SERVER made that choice, so a teacher who tapped the wait
       * list is not told something they already know. */
      waitlisted: queue,
      ...(waitlistReason === null ? {} : { waitlistReason }),
      ...actorFields(run),
    });
  } catch (err) {
    /* T50 review: the teacher's token died under this write (the
     * session is already ended, nothing ran): 401 reason "staff", so
     * the gate comes back. */
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
