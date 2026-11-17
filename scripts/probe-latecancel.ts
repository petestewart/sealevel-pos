/**
 * T245's probe: what does Mindbody do to a visit on
 * `POST /client/updateclientvisit {VisitId, Execute: "Latecancel"}`, and
 * does `Execute: "Unlatecancel"` put it back?
 *
 * What the studio's own late cancel left on a real visit (Andie's 1305761,
 * read live 2026-11-17) is the visit still on the class, `LateCancelled:
 * true`, signed out, its pass still attached. This asks whether the API's
 * execute code does the same, and that it reverses, on ONE visit of the
 * dummy client:
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=100042041 \
 *     npx tsx --env-file=.env scripts/probe-latecancel.ts 100042041 <visitId> [classId]
 *
 * It reads the visit, sends Latecancel, reads it back, sends Unlatecancel,
 * reads it back, printing `LateCancelled`, `SignedIn`, `ServiceId` and the
 * pass's `Remaining` each time. With a classId the visit is read off
 * `/class/classvisits` (where the roster reads it); without one, off
 * `/client/clientvisits` over sixty days either side of today.
 *
 * The two writes send ONLY `{VisitId, Execute}`. The rails stay armed on
 * purpose (rehearse-booking.ts): dry run must be off for the writes to
 * reach Mindbody at all, and the write guard lets exactly this client
 * through. A visit that is signed in is refused here, since a late cancel
 * would sign it out. Never run against a real student.
 */
import { mindbody } from "../src/lib/mindbody";
import { studioWall } from "../src/lib/roster";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Snapshot {
  LateCancelled: unknown;
  SignedIn: unknown;
  Missed: unknown;
  ServiceId: number | null;
  /** The embedded pass's Remaining, when the visit carries one. */
  visitRemaining: unknown;
  /** The client's pass, read from /client/clientservices by id. */
  passRemaining: unknown;
}

async function readVisit(
  clientId: string,
  visitId: number,
  classId: number | null,
): Promise<any | null> {
  if (classId !== null) {
    const body = await mindbody(`/class/classvisits?ClassId=${classId}`);
    const visits: any[] = body?.Class?.Visits ?? body?.Visits ?? [];
    return visits.find((v) => v?.Id === visitId) ?? null;
  }
  const now = Date.now();
  const from = studioWall(new Date(now - 60 * DAY_MS));
  const to = studioWall(new Date(now + 60 * DAY_MS));
  const body = await mindbody(
    `/client/clientvisits?ClientId=${encodeURIComponent(clientId)}` +
      `&StartDate=${encodeURIComponent(from)}&EndDate=${encodeURIComponent(to)}` +
      "&Limit=200",
  );
  const visits: any[] = Array.isArray(body?.Visits) ? body.Visits : [];
  return visits.find((v) => v?.Id === visitId) ?? null;
}

async function snapshot(
  label: string,
  clientId: string,
  visitId: number,
  classId: number | null,
): Promise<Snapshot | null> {
  const v = await readVisit(clientId, visitId, classId);
  if (!v) {
    console.log(`${label}: visit ${visitId} not found`);
    return null;
  }
  const serviceId =
    typeof v.ServiceId === "number"
      ? v.ServiceId
      : typeof v.Service?.Id === "number"
        ? v.Service.Id
        : null;
  let passRemaining: unknown = "(no pass on the visit)";
  if (serviceId !== null) {
    const body = await mindbody(
      `/client/clientservices?ClientId=${encodeURIComponent(clientId)}&Limit=200`,
    );
    const services: any[] = Array.isArray(body?.ClientServices)
      ? body.ClientServices
      : [];
    const pass = services.find((s) => s?.Id === serviceId);
    passRemaining = pass ? pass.Remaining : "(not in the client's current passes)";
  }
  const snap: Snapshot = {
    LateCancelled: v.LateCancelled,
    SignedIn: v.SignedIn,
    Missed: v.Missed,
    ServiceId: serviceId,
    visitRemaining: v.Service?.Remaining,
    passRemaining,
  };
  console.log(
    `${label}: LateCancelled=${String(snap.LateCancelled)} ` +
      `SignedIn=${String(snap.SignedIn)} Missed=${String(snap.Missed)} ` +
      `ServiceId=${snap.ServiceId ?? "(none)"} ` +
      `visit's pass Remaining=${String(snap.visitRemaining)} ` +
      `pass Remaining=${String(snap.passRemaining)}`,
  );
  return snap;
}

async function execute(
  clientId: string,
  visitId: number,
  code: "Latecancel" | "Unlatecancel",
): Promise<boolean> {
  try {
    const res = await mindbody("/client/updateclientvisit", {
      method: "POST",
      body: { VisitId: visitId, Execute: code },
      clientId,
    });
    if (res?.DryRun || res?.WriteSuppressed) {
      console.log(
        `${code}: suppressed (${res?.DryRun ? "dry run" : "write guard"}): ` +
          "set POS_DRY_RUN=false and put the client id in POS_WRITE_CLIENT_IDS",
      );
      return false;
    }
    const v = res?.Visit;
    console.log(
      `${code}: answered LateCancelled=${String(v?.LateCancelled)} ` +
        `SignedIn=${String(v?.SignedIn)} ServiceId=${String(v?.ServiceId ?? v?.Service?.Id)}`,
    );
    return true;
  } catch (err) {
    console.log(`${code}: refused: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function main(): Promise<void> {
  const [clientId, visitRaw, classRaw] = process.argv.slice(2);
  const visitId = Number(visitRaw);
  const classId = classRaw === undefined ? null : Number(classRaw);
  if (
    !clientId ||
    !Number.isInteger(visitId) ||
    visitId <= 0 ||
    (classId !== null && (!Number.isInteger(classId) || classId <= 0))
  ) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-latecancel.ts <clientId> <visitId> [classId]",
    );
    process.exit(1);
  }
  const before = await snapshot("before", clientId, visitId, classId);
  if (!before) process.exit(1);
  if (before.SignedIn === true) {
    console.log("the visit is signed in; a late cancel would sign it out. Not sent.");
    process.exit(1);
  }
  if (before.LateCancelled === true) {
    console.log("the visit is already a late cancel. Not sent.");
    process.exit(1);
  }
  if (!(await execute(clientId, visitId, "Latecancel"))) return;
  await snapshot("after Latecancel", clientId, visitId, classId);
  const undone = await execute(clientId, visitId, "Unlatecancel");
  await snapshot("after Unlatecancel", clientId, visitId, classId);
  if (!undone) {
    console.log(
      `the visit ${visitId} may still be marked a late cancel: undo it in Mindbody's UI.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
