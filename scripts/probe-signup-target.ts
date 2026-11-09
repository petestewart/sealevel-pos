/**
 * T219's probe: what is this id, and would Mindbody sign this client up
 * for it? Read-only, plus one `Test: true` rehearsal when a client id is
 * given, which Mindbody validates and does NOT commit.
 *
 *   MINDBODY_TARGET=prod npx tsx --env-file=.env \
 *     scripts/probe-signup-target.ts 743
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-signup-target.ts 743 <clientId>
 *
 * The first answers the drawer's own lookup from a terminal: the id read
 * as a course (enrollment ClassScheduleId), as one class (ClassId), and
 * as a class schedule. The second rehearses the write a sale would make,
 * for the kind the id was found as. The rails stay armed on purpose, as
 * in rehearse-booking.ts: dry run must be off for the rehearsal to reach
 * Mindbody at all, and the write guard lets exactly this client through.
 */
import { mindbody } from "../src/lib/mindbody";
import {
  classesOfSchedule,
  readEnrolTarget,
  targetLabel,
} from "../src/lib/enrolonpurchase";

async function main(): Promise<void> {
  const [idRaw, clientId] = process.argv.slice(2);
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-signup-target.ts <id> [clientId]",
    );
    process.exit(1);
  }
  const settle = async <T>(what: string, run: () => Promise<T>) => {
    try {
      return await run();
    } catch (err) {
      console.log(`${what}: did not read: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  };
  const course = await settle("as a course", () => readEnrolTarget("enrollment", id));
  if (course !== undefined) {
    console.log(`as a course:    ${course ? targetLabel(course) : "none upcoming"}`);
  }
  const cls = await settle("as one class", () => readEnrolTarget("class", id));
  if (cls !== undefined) {
    console.log(`as one class:   ${cls ? targetLabel(cls) : "none upcoming"}`);
  }
  const schedule = await settle("as a schedule", () => classesOfSchedule(id));
  for (const c of schedule ?? []) {
    console.log(`schedule class: ${c.classId} ${c.name} ${c.startsAt ?? ""}`);
  }

  if (!clientId) return;
  const kind = course ? "enrollment" : cls ? "class" : null;
  if (kind === null) {
    console.log("nothing upcoming to rehearse against");
    return;
  }
  const res =
    kind === "enrollment"
      ? await mindbody("/enrollment/addclienttoenrollment", {
          method: "POST",
          body: { ClientId: clientId, ClassScheduleId: id, SendEmail: false, Test: true },
          clientId,
        })
      : await mindbody("/class/addclienttoclass", {
          method: "POST",
          body: { ClientId: clientId, ClassId: id, SendEmail: false, Test: true },
          clientId,
        });
  if (res?.DryRun || res?.WriteSuppressed) {
    console.log(
      `rehearsal suppressed (${res?.DryRun ? "dry run" : "write guard"}): ` +
        "set POS_DRY_RUN=false and put the client id in POS_WRITE_CLIENT_IDS",
    );
    return;
  }
  console.log(`rehearsal (${kind}, Test: true) accepted:`);
  console.log(JSON.stringify(res, null, 2).slice(0, 2000));
}

main().catch((err) => {
  console.error(`refused: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
