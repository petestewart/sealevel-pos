/**
 * Census of RedAlert usage: pages every client and prints each distinct
 * red-alert text with how many clients carry it.
 *
 * Read-only, but it pages the WHOLE client list (200 per call), so a
 * 2,000-client studio costs ~10 metered calls. Run it deliberately, not
 * on a loop. Respects MINDBODY_TARGET like everything else; .env is
 * loaded by Node itself, no extra dependency:
 *
 *     MINDBODY_TARGET=prod npx tsx --env-file=.env scripts/red-alerts.ts
 *
 * Motivation (2026-08-29): the app treats RedAlert as blocking, and Pete
 * found the studio also uses it for benign notes ("Cleaning on
 * Wednesdays"). This shows the real distribution so the gate's weight
 * can be judged against how the field is actually used.
 */
import { mindbody } from "../src/lib/mindbody";

async function main(): Promise<void> {
  const counts = new Map<string, number>();
  let offset = 0;
  let total = 0;
  for (;;) {
    const body = await mindbody(
      `/client/clients?limit=200&offset=${offset}`,
    );
    const clients: any[] = body?.Clients ?? [];
    for (const c of clients) {
      total += 1;
      const alert = typeof c?.RedAlert === "string" ? c.RedAlert.trim() : "";
      if (alert) counts.set(alert, (counts.get(alert) ?? 0) + 1);
    }
    const page = body?.PaginationResponse;
    offset += clients.length;
    if (
      clients.length === 0 ||
      (typeof page?.TotalResults === "number" && offset >= page.TotalResults)
    ) {
      break;
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`${total} clients scanned, ${sorted.length} distinct red alerts:\n`);
  for (const [text, n] of sorted) {
    console.log(`${String(n).padStart(4)}  ${text}`);
  }
  if (sorted.length === 0) console.log("(none)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
