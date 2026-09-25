/**
 * Put Stacia Sander's client record back to the copy the app read at
 * 2026-09-25 10:19 UTC (3:19am Seattle), before Kati Robison's record
 * was renumbered off client id 10814 in Mindbody's UI. Pete believes
 * that renumbering damaged the active record that shared the id.
 *
 * Without `--apply` it only READS and prints what differs. With
 * `--apply` it sends ONE `updateclient` carrying only the differing
 * fields (updateclient overwrites what it is given, and nothing else),
 * rehearsed first with `Test: true`, then reads the record back.
 *
 * It refuses to write unless client id 10814 resolves to exactly one
 * record whose UniqueId is Stacia's (100037835).
 *
 * Not restorable here: the card on file (only the last four digits are
 * known), text opt-ins (Mindbody ignores them from the API), and her
 * notes, which were already empty in the 3:19am copy.
 *
 *     MINDBODY_TARGET=prod npx tsx --env-file=.env scripts/restore-stacia.ts
 *     MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=10814 \
 *       npx tsx --env-file=.env scripts/restore-stacia.ts --apply
 */
import { mindbody } from "../src/lib/mindbody";

const ID = "10814";
const UNIQUE_ID = 100037835;

/** The 10:19 UTC snapshot, field by field, as Mindbody spells them. */
const SNAPSHOT: Record<string, string | boolean | null> = {
  FirstName: "Stacia",
  LastName: "Sander",
  RedAlert: "Pronounced Stay-sha",
  YellowAlert: null,
  Email: "sanderowski@gmail.com",
  MobilePhone: "2087204565",
  HomePhone: "2087204565",
  WorkPhone: null,
  AddressLine1: "3205 44th Ave W",
  AddressLine2: null,
  City: "Seattle",
  State: "WA",
  PostalCode: "98199",
  Country: "US",
  Gender: "None",
  SendAccountEmails: true,
  SendScheduleEmails: true,
  SendPromotionalEmails: false,
  LiabilityRelease: true,
};

function norm(v: unknown): string | boolean | null {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

async function readStacia(): Promise<any> {
  const body = await mindbody(
    `/client/clients?clientIds=${ID}&includeInactive=true&limit=200`,
  );
  const hits = (body?.Clients ?? []).filter(
    (c: any) => String(c?.Id ?? "") === ID,
  );
  if (hits.length !== 1) {
    throw new Error(
      `Client id ${ID} matches ${hits.length} records, not 1. Stopping; nothing written.`,
    );
  }
  if (hits[0]?.UniqueId !== UNIQUE_ID) {
    throw new Error(
      `Client id ${ID} is UniqueId ${hits[0]?.UniqueId}, not Stacia's ${UNIQUE_ID}. Stopping; nothing written.`,
    );
  }
  return hits[0];
}

function diff(c: any): Record<string, string | boolean | null> {
  const out: Record<string, string | boolean | null> = {};
  for (const [k, want] of Object.entries(SNAPSHOT)) {
    // LiabilityRelease reads back as Liability.IsReleased.
    const have =
      k === "LiabilityRelease" ? c?.Liability?.IsReleased === true : c?.[k];
    if (norm(have) !== norm(want)) out[k] = want;
  }
  return out;
}

function show(c: any, changes: Record<string, unknown>): void {
  const keys = Object.keys(changes);
  if (keys.length === 0) {
    console.log("Every restorable field already matches the 3:19am copy.");
    return;
  }
  console.log(`${keys.length} field(s) differ from the 3:19am copy:\n`);
  for (const k of keys) {
    const have =
      k === "LiabilityRelease" ? c?.Liability?.IsReleased : c?.[k];
    console.log(`  ${k.padEnd(22)} now: ${JSON.stringify(have ?? null)}`);
    console.log(`  ${"".padEnd(22)} was: ${JSON.stringify(changes[k])}`);
  }
}

function suppressed(res: any): string | null {
  if (res?.DryRun) return "POS_DRY_RUN is on";
  if (res?.WriteSuppressed) return "POS_WRITE_CLIENT_IDS does not name 10814";
  return null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const before = await readStacia();
  console.log(
    `Found ${before.FirstName} ${before.LastName}, id ${ID}, UniqueId ${UNIQUE_ID}, card ...${before?.ClientCreditCard?.LastFour ?? "none"}.\n`,
  );
  const changes = diff(before);
  show(before, changes);
  if (Object.keys(changes).length === 0) return;
  if (!apply) {
    console.log("\nRead only; nothing written. Add --apply to restore these fields.");
    return;
  }

  const request = (test: boolean) => ({
    Client: { Id: ID, ...changes },
    Test: test,
    CrossRegionalUpdate: false,
  });

  const rehearsal = await mindbody("/client/updateclient", {
    method: "POST",
    body: request(true),
    clientId: ID,
  });
  const blocked = suppressed(rehearsal);
  if (blocked) {
    console.log(
      `\nSTOPPED. The rehearsal never reached Mindbody: ${blocked}.\n` +
        `Run with POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=${ID} in front. Nothing written.`,
    );
    process.exit(1);
  }
  if (rehearsal?.Client?.UniqueId !== UNIQUE_ID) {
    console.log(
      `\nSTOPPED. The rehearsal resolved UniqueId ${rehearsal?.Client?.UniqueId ?? "?"}, not Stacia. Nothing written.`,
    );
    process.exit(1);
  }

  console.log("\nRehearsal resolved Stacia. Writing once ...");
  const res = await mindbody("/client/updateclient", {
    method: "POST",
    body: request(false),
    clientId: ID,
  });
  const blockedLive = suppressed(res);
  if (blockedLive) {
    console.log(`STOPPED. The write never reached Mindbody: ${blockedLive}.`);
    process.exit(1);
  }

  const after = await readStacia();
  const left = diff(after);
  if (Object.keys(left).length === 0) {
    console.log("DONE. Every restorable field now matches the 3:19am copy.");
  } else {
    console.log("Written, but these still differ on read-back:");
    show(after, left);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
