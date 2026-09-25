/**
 * Who carries a client id? Read-only: one `/client/clients` call per id,
 * inactive records included, keeping only records whose Id matches
 * exactly (clientIds is not guaranteed exact).
 *
 * Mindbody's client Id is not unique on a site (T114: Stacia Sander and
 * Kati Robison both carried 10814), so use this to check a new id is
 * free before assigning it, and to confirm the result afterwards:
 *
 *     MINDBODY_TARGET=prod npx tsx --env-file=.env scripts/client-id-lookup.ts 10814 R10814
 */
import { mindbody } from "../src/lib/mindbody";

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (ids.length === 0) {
    console.log("Usage: client-id-lookup.ts <id> [<id> ...]");
    process.exit(1);
  }
  for (const id of ids) {
    const body = await mindbody(
      `/client/clients?clientIds=${encodeURIComponent(id)}&includeInactive=true&limit=200`,
    );
    const hits = (body?.Clients ?? []).filter(
      (c: any) => String(c?.Id ?? "") === id,
    );
    const verdict =
      hits.length === 0 ? "FREE, nobody" : hits.length === 1 ? "one record" : `SHARED by ${hits.length}`;
    console.log(`${id}: ${verdict}`);
    for (const c of hits) {
      console.log(
        `    ${c?.Active === false ? "inactive" : "ACTIVE  "}  UniqueId ${c?.UniqueId ?? "?"}` +
          `  ${`${c?.FirstName ?? ""} ${c?.LastName ?? ""}`.trim() || "(no name)"}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
