/**
 * Census of shared client ids: pages every client, ACTIVE AND INACTIVE,
 * and lists every `Id` that more than one record carries.
 *
 * Why (T114, 2026-09-25): Mindbody's client `Id` (the "client ID" on a
 * profile) is NOT unique on a site. Stacia Sander (UniqueId 100037835,
 * active) and Kati Robison (UniqueId 1005543, inactive since 2010) both
 * carry Id 10814, and the roster put Kati's name on Stacia's row.
 * `UniqueId` is the real key. This says whether that is one accident or
 * a pattern, and which pairs involve a live student.
 *
 * Read-only, but it pages the WHOLE client list including inactive
 * records (200 per call), so a studio with 30,000 records on file costs
 * ~150 metered calls. Run it deliberately, not on a loop:
 *
 *     MINDBODY_TARGET=prod npx tsx --env-file=.env scripts/duplicate-client-ids.ts
 *
 * Add `--csv` to also write duplicate-client-ids.csv in the current
 * directory (one row per record, grouped by id). It holds client names
 * and emails: keep it off the repo.
 */
import { writeFileSync } from "node:fs";
import { mindbody } from "../src/lib/mindbody";

interface Rec {
  id: string;
  uniqueId: number | null;
  name: string;
  email: string;
  active: boolean;
  status: string;
  created: string;
  lastModified: string;
}

function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}

async function main(): Promise<void> {
  const csv = process.argv.includes("--csv");
  /* Keyed by UniqueId, so a record that shifts between pages while we
   * read (a client created mid-scan moves everyone along one place) is
   * counted once rather than reported as its own duplicate. */
  const seen = new Map<string, Rec>();
  let offset = 0;
  let calls = 0;
  let reported: number | null = null;
  for (;;) {
    const body = await mindbody(
      `/client/clients?includeInactive=true&limit=200&offset=${offset}`,
    );
    calls += 1;
    const clients: any[] = body?.Clients ?? [];
    const page = body?.PaginationResponse;
    if (typeof page?.TotalResults === "number") reported = page.TotalResults;
    for (const c of clients) {
      if (c?.Id === undefined || c?.Id === null) continue;
      const uniqueId = typeof c?.UniqueId === "number" ? c.UniqueId : null;
      const rec: Rec = {
        id: String(c.Id),
        uniqueId,
        name: `${str(c?.FirstName)} ${str(c?.LastName)}`.trim(),
        email: str(c?.Email),
        active: c?.Active === true,
        status: str(c?.Status),
        created: str(c?.CreationDate).slice(0, 10),
        lastModified: str(c?.LastModifiedDateTime).slice(0, 10),
      };
      /* No UniqueId is unexpected; keep it under a key that cannot
       * collide so it is still counted against its Id. */
      seen.set(uniqueId !== null ? `u${uniqueId}` : `x${seen.size}`, rec);
    }
    offset += clients.length;
    process.stderr.write(
      `\r${offset}${reported !== null ? ` of ${reported}` : ""} records, ${calls} calls`,
    );
    if (clients.length === 0 || (reported !== null && offset >= reported)) {
      break;
    }
  }
  process.stderr.write("\n");

  const byId = new Map<string, Rec[]>();
  for (const rec of seen.values()) {
    const list = byId.get(rec.id) ?? [];
    list.push(rec);
    byId.set(rec.id, list);
  }
  const groups = [...byId.entries()]
    .filter(([, recs]) => recs.length > 1)
    .map(([id, recs]) => ({
      id,
      recs: recs.sort((a, b) => Number(b.active) - Number(a.active)),
      activeCount: recs.filter((r) => r.active).length,
    }))
    /* Worst first: two live students sharing an id, then a live student
     * sharing with a dead record, then dead with dead. */
    .sort((a, b) => b.activeCount - a.activeCount || a.id.localeCompare(b.id));

  const bothActive = groups.filter((g) => g.activeCount >= 2).length;
  const oneActive = groups.filter((g) => g.activeCount === 1).length;
  const noneActive = groups.filter((g) => g.activeCount === 0).length;
  const records = groups.reduce((n, g) => n + g.recs.length, 0);
  const inactiveSeen = [...seen.values()].filter((r) => !r.active).length;

  console.log(
    `\n${seen.size} client records scanned (active and inactive), ${calls} calls.`,
  );
  if (inactiveSeen === 0) {
    console.log(
      "WARNING: not one inactive record came back, so Mindbody probably\n" +
        "ignored includeInactive and this scan saw active clients only.\n" +
        "Kati Robison (10814) is inactive: a scan that misses her would\n" +
        "undercount. Treat the numbers below as a floor.\n",
    );
  } else {
    console.log(`${inactiveSeen} of them inactive.`);
  }
  console.log(
    `${groups.length} client ids are shared, by ${records} records in all.\n`,
  );
  console.log(`  ${bothActive}  shared by two or more ACTIVE clients (worst)`);
  console.log(`  ${oneActive}  an active client sharing with an inactive record`);
  console.log(`  ${noneActive}  inactive records only (harmless at the counter)\n`);

  for (const g of groups) {
    console.log(`Id ${g.id}  (${g.activeCount} active of ${g.recs.length})`);
    for (const r of g.recs) {
      console.log(
        `    ${r.active ? "ACTIVE  " : "inactive"}  UniqueId ${String(r.uniqueId ?? "?").padEnd(10)}` +
          `  ${r.name || "(no name)"}  created ${r.created || "?"}` +
          `  modified ${r.lastModified || "?"}  ${r.status}`,
      );
    }
  }
  if (groups.length === 0) console.log("(no shared ids)");

  if (csv) {
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = [
      "id,unique_id,active,name,email,status,created,last_modified",
      ...groups.flatMap((g) =>
        g.recs.map((r) =>
          [
            q(g.id),
            r.uniqueId ?? "",
            r.active,
            q(r.name),
            q(r.email),
            q(r.status),
            r.created,
            r.lastModified,
          ].join(","),
        ),
      ),
    ];
    writeFileSync("duplicate-client-ids.csv", lines.join("\n") + "\n");
    console.log("\nWrote duplicate-client-ids.csv");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
