/**
 * T219: selling a pass that comes with a place in a class or a course
 * books that place too.
 *
 * Pete, 2026-11-09: "if someone purchases either 'Gratitude Yin Sound
 * Bath' or 'Gratitude Yin Sound Bath (Members)' workshop, they are
 * automatically signed up for the Gratitude Yin Sound Bath on 11/25/26
 * ... in mindbody we have to sell the pass to the person and sign them
 * up for the course. think through how to add this as a feature so next
 * time it is easy to implement."
 *
 * The rules are shelf configuration (`enrolments` in
 * src/lib/shelfconfig.ts, rows on the drawer's Shelf tab): a pass id,
 * and the course or class it signs its owner up for. This module is
 * what happens with them after a sale:
 *
 * - **It runs once, on the SERVER, at the one choke point every charge
 *   path shares**: `/api/checkout`'s POST, after the checkout answered a
 *   real sale and BEFORE T113's idempotency record is written, so a
 *   request arriving twice replays the first answer, enrolments
 *   included, and books nobody twice. The Cart screen's Charge and the
 *   roster's "Pay and check in" both reach it with no code of their own,
 *   which is T209's lesson about charge paths taken at its word.
 * - **Only a sale that STANDS enrols anybody**: a 200 with `ok: true`.
 *   A suppressed sale, a refusal, an ambiguous answer, T103's
 *   sold-nothing and T90's partial ticket all leave the answer exactly
 *   as the checkout wrote it. A partial ticket is the one gap: the pass
 *   may have landed on a cart that went out, and that student is then
 *   signed up by hand (its sentence already says which carts landed).
 * - **The pass goes to the person the LINE was for** (T90's
 *   `forClientId`), else the paying client. Never the house client: a
 *   pass on an anonymous sale belongs to nobody, and nobody is booked.
 * - **The target is read first, and nothing is written unless it is
 *   confirmed UPCOMING.** One read names it for the done screen, and a
 *   target that has ended, that Mindbody does not have, or that a read
 *   could not confirm books nothing and says so, because a booking into
 *   a finished class is attendance invented, and a row left behind in
 *   the drawer after the workshop is exactly how that would happen.
 * - **The write is the teacher's own**, under their token (T49's
 *   runAsActor, with its one loud fallback), through mindbody() with the
 *   client id in the options, so dry run, the write guard and T89's
 *   settling window apply exactly as they do to a tap.
 * - **A full one goes on its waiting list** when the read can count it
 *   (T208's rule: Mindbody does not enforce capacity, the caller does).
 * - **Nothing here can make the sale look failed.** Every outcome,
 *   failure included, is a sentence beside a sale that stands, and an
 *   error thrown anywhere in this module leaves the checkout's own
 *   answer untouched with one `[enrol]` log line.
 *
 * Which pricing option pays for the place is Mindbody's to decide, as it
 * is for every booking this app makes without a `ClientServiceId`: the
 * pass was sold seconds earlier and is the one on the account that
 * matches. Whether Mindbody applies it to an ENROLLMENT the way it does
 * to a class has not been seen live; see TICKETS T219.
 */

import { runAsActor } from "./actor";
import { mindbody } from "./mindbody";
import { bookClientIntoClass, studioWall } from "./roster";
import { houseClientId, parseCartLines, type CartLine } from "./sale";
import type { EnrolmentKind, PassEnrolment } from "./shelfconfig";
import type { StaffSession } from "./staffsession";

/** How far ahead a target is looked for. A workshop pass is sold weeks
 *  ahead (the sound bath's is valid two months), and a target further
 *  out than this is reported as not found rather than booked blind. */
const LOOKAHEAD_DAYS = 180;

/** One booking to make: a person, a target, and the passes that asked
 *  for it (two of the same workshop's passes on one person is ONE place,
 *  since nobody can be enrolled twice). */
export interface PlannedEnrolment {
  clientId: string;
  kind: EnrolmentKind;
  targetId: number;
  passIds: string[];
}

/**
 * Which bookings a sale asks for. Pure, so the rule is the same in the
 * route, the probe and a plain node test.
 *
 * `payerClientId` is the checkout's `clientId`; `house` is
 * POS_HOUSE_CLIENT_ID. A line with no owner (an anonymous sale, or a
 * line on the house client) asks for nothing.
 */
export function planEnrolments(
  items: readonly CartLine[],
  payerClientId: string | null,
  rules: readonly PassEnrolment[],
  house: string | null,
): PlannedEnrolment[] {
  if (rules.length === 0) return [];
  const byPass = new Map(rules.map((rule) => [rule.passId, rule]));
  const planned = new Map<string, PlannedEnrolment>();
  for (const line of items) {
    if (line.type !== "Service") continue;
    const rule = byPass.get(String(line.metadataId).trim());
    if (rule === undefined) continue;
    const owner =
      typeof line.forClientId === "string" && line.forClientId.trim() !== ""
        ? line.forClientId.trim()
        : payerClientId;
    if (owner === null || owner === "" || owner === house) continue;
    const key = `${owner}|${rule.kind}|${rule.targetId}`;
    const existing = planned.get(key);
    if (existing) {
      if (!existing.passIds.includes(rule.passId)) {
        existing.passIds.push(rule.passId);
      }
      continue;
    }
    planned.set(key, {
      clientId: owner,
      kind: rule.kind,
      targetId: rule.targetId,
      passIds: [rule.passId],
    });
  }
  return [...planned.values()];
}

/** A target as Mindbody describes it today. `startsAt`/`endsAt` are naive
 *  studio wall-clock strings, like every Mindbody datetime (T40). */
export interface EnrolTarget {
  kind: EnrolmentKind;
  id: number;
  name: string;
  startsAt: string | null;
  endsAt: string | null;
  /** True full, false room, null "Mindbody did not say". */
  full: boolean | null;
  cancelled: boolean;
}

function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  return new Date(at.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** "2026-11-25T00:00:00" + "1900-01-01T19:00:00" -> "2026-11-25T19:00:00".
 *  An enrollment carries its dates and its times in separate fields. */
function joinDateTime(date: unknown, time: unknown): string | null {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(date)) {
    return null;
  }
  const clock =
    typeof time === "string" && /T\d{2}:\d{2}/.test(time)
      ? time.slice(time.indexOf("T") + 1, time.indexOf("T") + 9)
      : "00:00:00";
  return `${date.slice(0, 10)}T${clock.padEnd(8, ":00").slice(0, 8)}`;
}

function countFull(capacity: unknown, booked: unknown): boolean | null {
  if (
    typeof capacity === "number" &&
    Number.isFinite(capacity) &&
    capacity > 0 &&
    typeof booked === "number" &&
    Number.isFinite(booked)
  ) {
    return booked >= capacity;
  }
  return null;
}

/**
 * Read one target. Null means Mindbody ANSWERED and has no such upcoming
 * target; a throw means the read itself failed. One metered call, on the
 * service account like every read.
 */
export async function readEnrolTarget(
  kind: EnrolmentKind,
  id: number,
): Promise<EnrolTarget | null> {
  const today = studioWall(new Date()).slice(0, 10);
  const until = addDays(today, LOOKAHEAD_DAYS);
  if (kind === "enrollment") {
    /* getEnrollments: "returns any active enrollments that occur on or
     * after" startDate, and endDate defaults to startDate, so both are
     * sent or a course that starts next week is not found today. */
    const body = await mindbody(
      `/enrollment/enrollments?ClassScheduleIds=${id}` +
        `&StartDate=${today}T00:00:00&EndDate=${until}T00:00:00`,
    );
    const found = (body?.Enrollments ?? []).find(
      (e: any) => Number(e?.Id) === id,
    );
    if (!found) return null;
    /* Its sessions, when the answer carries them: the first that has not
     * ended decides the start and the capacity. A course with none listed
     * falls back to its own date fields. */
    const sessions: any[] = Array.isArray(found.Classes) ? found.Classes : [];
    const now = studioWall(new Date());
    const next = sessions
      .filter(
        (c) =>
          c?.IsCanceled !== true &&
          typeof c?.EndDateTime === "string" &&
          c.EndDateTime >= now,
      )
      .sort((a, b) => String(a.StartDateTime).localeCompare(String(b.StartDateTime)))[0];
    const name =
      found.ClassDescription?.Name ??
      next?.ClassDescription?.Name ??
      `Course ${id}`;
    return {
      kind,
      id,
      name: String(name),
      startsAt:
        typeof next?.StartDateTime === "string"
          ? next.StartDateTime
          : joinDateTime(found.StartDate, found.StartTime),
      endsAt: joinDateTime(found.EndDate, found.EndTime),
      full: next ? countFull(next.MaxCapacity, next.TotalBooked) : null,
      cancelled: false,
    };
  }
  /* T208 review's rule: /class/classes ends its own window at today, so
   * a by-id read of a later class must bracket the days it may be on. */
  const body = await mindbody(
    `/class/classes?ClassIds=${id}` +
      `&StartDateTime=${encodeURIComponent(`${today}T00:00:00`)}` +
      `&EndDateTime=${encodeURIComponent(`${until}T00:00:00`)}`,
  );
  const found = (body?.Classes ?? []).find((c: any) => Number(c?.Id) === id);
  if (!found) return null;
  return {
    kind,
    id,
    name: String(found.ClassDescription?.Name ?? `Class ${id}`),
    startsAt: typeof found.StartDateTime === "string" ? found.StartDateTime : null,
    endsAt: typeof found.EndDateTime === "string" ? found.EndDateTime : null,
    full: countFull(found.MaxCapacity, found.TotalBooked),
    cancelled: found.IsCanceled === true,
  };
}

/** The classes a ClassScheduleId puts on the calendar, for the drawer's
 *  lookup: Mindbody's workshop URL carries a schedule id, and a one-off
 *  class's schedule id is not the id addclienttoclass takes. */
export async function classesOfSchedule(
  scheduleId: number,
): Promise<{ classId: number; name: string; startsAt: string | null }[]> {
  const today = studioWall(new Date()).slice(0, 10);
  const body = await mindbody(
    `/class/classes?ClassScheduleIds=${scheduleId}` +
      `&StartDateTime=${encodeURIComponent(`${today}T00:00:00`)}` +
      `&EndDateTime=${encodeURIComponent(`${addDays(today, LOOKAHEAD_DAYS)}T00:00:00`)}` +
      `&Limit=20`,
  );
  /* Filtered on the field as well as the parameter: a query parameter
   * Mindbody does not honour comes back as every class in the window,
   * and the drawer would offer a stranger's class as this schedule's. */
  return (body?.Classes ?? [])
    .filter(
      (c: any) =>
        c?.IsCanceled !== true &&
        Number.isInteger(c?.Id) &&
        Number(c?.ClassScheduleId) === scheduleId,
    )
    .map((c: any) => ({
      classId: c.Id as number,
      name: String(c.ClassDescription?.Name ?? `Class ${c.Id}`),
      startsAt: typeof c.StartDateTime === "string" ? c.StartDateTime : null,
    }));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-11-25T19:00:00" -> "Wed Nov 25, 7:00pm". Read off the string's
 *  own digits: it is already studio wall-clock time, and handing it to a
 *  Date in a server's zone is how T40's seven-hour window happened. */
export function wallLabel(wall: string | null): string | null {
  const m = wall?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const weekday = DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const month = MONTHS[mo - 1];
  const hour = h % 12 === 0 ? 12 : h % 12;
  const clock = `${hour}:${String(mi).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  return `${weekday} ${month} ${d}, ${clock}`;
}

export function targetLabel(target: EnrolTarget): string {
  const when = wallLabel(target.startsAt);
  return when ? `${target.name}, ${when}` : target.name;
}

/** What one planned booking came to. `sentence` is what the done screen
 *  shows, and `ok` decides its colour: false is amber, because the sale
 *  stands and the place does not. */
export interface EnrolmentOutcome {
  clientId: string;
  kind: EnrolmentKind;
  targetId: number;
  passIds: string[];
  name: string | null;
  startsAt: string | null;
  status: "enrolled" | "waitlisted" | "suppressed" | "skipped" | "failed";
  ok: boolean;
  suppressed?: "dry-run" | "write-guard";
  sentence: string;
  actorFallback?: unknown;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One booking, read then write. Never throws. */
export async function runEnrolment(
  plan: PlannedEnrolment,
  session: StaffSession | null,
  who: string | null,
): Promise<EnrolmentOutcome> {
  const base = {
    clientId: plan.clientId,
    kind: plan.kind,
    targetId: plan.targetId,
    passIds: plan.passIds,
  };
  /* A place bought for somebody else names them first (T90 sends their
   * name with the line); the paying client's own reads without. */
  const say = (text: string) => (who ? `For ${who}: ${text}` : text);
  const what = plan.kind === "enrollment" ? "course" : "class";
  const byHand = "The pass is sold; sign them up in Mindbody by hand.";

  let target: EnrolTarget | null;
  try {
    target = await readEnrolTarget(plan.kind, plan.targetId);
  } catch (err) {
    return {
      ...base,
      name: null,
      startsAt: null,
      status: "failed",
      ok: false,
      sentence: say(
        `NOT signed up: Mindbody did not answer about ${what} ` +
        `${plan.targetId} (${errText(err)}). ${byHand}`,
      ),
    };
  }
  if (target === null) {
    return {
      ...base,
      name: null,
      startsAt: null,
      status: "skipped",
      ok: false,
      sentence: say(
        `NOT signed up: Mindbody has no upcoming ${what} ` +
        `${plan.targetId}, so it has ended or the sign-up rule in the ` +
        `drawer's Shelf tab names the wrong id. ${byHand}`,
      ),
    };
  }
  const label = targetLabel(target);
  const named = { ...base, name: target.name, startsAt: target.startsAt };
  const now = studioWall(new Date());
  if (target.cancelled) {
    return {
      ...named,
      status: "skipped",
      ok: false,
      sentence: say(`NOT signed up: ${label} is cancelled. ${byHand}`),
    };
  }
  if ((target.endsAt ?? target.startsAt ?? "9999") < now) {
    return {
      ...named,
      status: "skipped",
      ok: false,
      sentence: say(`NOT signed up: ${label} has already ended.`),
    };
  }

  const queue = target.full === true;
  try {
    const run = await runAsActor(session, "/api/checkout (sign-up)", async (actor) => {
      if (plan.kind === "class") {
        const booked = await bookClientIntoClass({
          clientId: plan.clientId,
          classId: plan.targetId,
          waitlist: queue,
          actor,
        });
        return booked.suppressed;
      }
      const body: Record<string, unknown> = {
        ClientId: plan.clientId,
        ClassScheduleId: plan.targetId,
        SendEmail: false,
      };
      if (queue) body["Waitlist"] = true;
      const res = await mindbody("/enrollment/addclienttoenrollment", {
        method: "POST",
        body,
        clientId: plan.clientId,
        ...(actor ? { actor } : {}),
      });
      if (res?.DryRun) return "dry-run" as const;
      if (res?.WriteSuppressed) return "write-guard" as const;
      return null;
    });
    const fallback =
      run.actorFallback === null ? {} : { actorFallback: run.actorFallback };
    if (run.result !== null) {
      return {
        ...named,
        ...fallback,
        status: "suppressed",
        ok: false,
        suppressed: run.result,
        sentence: say(
          `Not signed up for ${label}: the booking was not sent ` +
          `to Mindbody (${run.result}).`,
        ),
      };
    }
    if (queue) {
      return {
        ...named,
        ...fallback,
        status: "waitlisted",
        ok: true,
        sentence: say(`${label} is full: added to its waiting list.`),
      };
    }
    return {
      ...named,
      ...fallback,
      status: "enrolled",
      ok: true,
      sentence: say(`Signed up for ${label}.`),
    };
  } catch (err) {
    return {
      ...named,
      status: "failed",
      ok: false,
      sentence: say(
        `NOT signed up for ${label}: ${errText(err)} ${byHand}`,
      ),
    };
  }
}

/**
 * The checkout's wrapper: given the answer `/api/checkout` is about to
 * send, book whatever the sold passes ask for and send the same answer
 * with `enrolments: EnrolmentOutcome[]` added. Any other answer, and any
 * sale that sold no such pass, goes back as the very same Response.
 *
 * Never throws: the sale has already happened, and a bug in here must
 * not turn it into an error on the teacher's screen.
 */
export async function enrolAfterCheckout(
  res: Response,
  payload: any,
  session: StaffSession | null,
  rules: readonly PassEnrolment[],
): Promise<Response> {
  try {
    if (rules.length === 0 || res.status !== 200) return res;
    const answer = await res.clone().json().catch(() => null);
    if (answer?.ok !== true || answer?.suppressed) return res;
    if (!Array.isArray(payload?.items) || payload.items.length === 0) return res;
    const parsed = parseCartLines(payload.items);
    if (parsed.error !== null) return res;
    const payer =
      typeof payload?.clientId === "string" && payload.clientId.trim() !== ""
        ? payload.clientId.trim()
        : null;
    const plans = planEnrolments(parsed.items, payer, rules, houseClientId());
    if (plans.length === 0) return res;

    /* T90: a ticket bought for other people answers each sale with the
     * name of who it was for, which is the only name this route holds.
     * The paying client's own place reads without one. */
    const names = new Map<string, string>();
    for (const sale of Array.isArray(answer.sales) ? answer.sales : []) {
      const id = sale?.forClientId ?? sale?.clientId;
      if (typeof id === "string" && typeof sale?.name === "string" && id !== payer) {
        names.set(id, sale.name);
      }
    }

    /* One at a time: two places in one small class must not race each
     * other for its last seat. */
    const enrolments: EnrolmentOutcome[] = [];
    for (const plan of plans) {
      const outcome = await runEnrolment(
        plan,
        session,
        names.get(plan.clientId) ?? null,
      );
      console.log(
        `[enrol] ${outcome.status} client ${plan.clientId} ${plan.kind} ` +
          `${plan.targetId} (pass ${plan.passIds.join(", ")}): ${outcome.sentence}`,
      );
      enrolments.push(outcome);
    }
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify({ ...answer, enrolments }), {
      status: res.status,
      headers,
    });
  } catch (err) {
    console.error(
      `[enrol] the sale stands; signing up after it failed: ${errText(err)}`,
    );
    return res;
  }
}
