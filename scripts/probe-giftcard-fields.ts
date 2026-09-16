/**
 * Follow-up to scripts/probe-giftcards.ts, which found that site 471
 * answers the SAME question two ways: rehearsed at $37.00, six of nine
 * gift card products came back worth $37.00 and three came back worth
 * their own CardValue. A capability that holds for some products and not
 * others is a per-product FLAG, and this prints every field Mindbody
 * carries on each one so the flag can be named rather than guessed.
 *
 * `GiftCard` (docs/mindbody-openapi/sale.yml:2912) documents
 * `EditableByConsumer` ("the gift card can be edited by the client"),
 * which is the obvious candidate, plus SoldOnline, LocationIds,
 * MembershipRestrictionIds, Layouts and GiftCardTerms. The list read is
 * filtered to the studio's own location, so this also asks again with no
 * filter: Pete's web POS shows a "Gift Card (Custom Amount)" item that
 * the filtered list does not contain, and an item sold only at the
 * online location would explain that.
 *
 * Reads only. No purchase, not even a rehearsal, and nothing here can
 * write: `GET /sale/giftcards` twice.
 *
 * Usage, against prod:
 *
 *   MINDBODY_TARGET=prod npx tsx --env-file=.env scripts/probe-giftcard-fields.ts
 *
 * POS_DRY_RUN does not matter: dry run suppresses writes, and there are
 * none here.
 */
import { mindbody } from "../src/lib/mindbody";

/** The six ids that took the amount, and the three that did not, from
 *  the first probe's run on 2026-09-16. Printed beside each product so
 *  the flag that splits them is visible at a glance. */
const TOOK_THE_AMOUNT = new Set([323, 448, 321, 409, 287, 453]);
const KEPT_ITS_VALUE = new Set([75, 74, 322]);

async function list(query: string, label: string): Promise<unknown[]> {
  console.log(`\n=== ${label}\n    GET /sale/giftcards${query}\n`);
  try {
    const res = await mindbody<{ GiftCards?: unknown }>(
      `/sale/giftcards${query}`,
    );
    const raw = Array.isArray(res?.GiftCards) ? res.GiftCards : [];
    console.log(`    ${raw.length} product(s)\n`);
    return raw;
  } catch (err) {
    console.log(`    FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function verdict(id: unknown): string {
  const n = typeof id === "number" ? id : Number(id);
  if (TOOK_THE_AMOUNT.has(n)) return "  <-- TOOK the $37";
  if (KEPT_ITS_VALUE.has(n)) return "  <-- KEPT its own value";
  return "";
}

async function main(): Promise<void> {
  /* 1. The studio's own list, every field, with the first probe's result
   *    beside each so a field that lines up with the split is obvious. */
  const atStudio = await list(
    "?request.locationId=1&request.limit=100",
    "At the studio (LocationId 1), all fields",
  );
  for (const entry of atStudio) {
    const e = entry as Record<string, unknown>;
    console.log(
      `  --- id=${String(e["Id"])} ${String(e["Description"] ?? "")}${verdict(e["Id"])}`,
    );
    for (const [k, v] of Object.entries(e)) {
      if (k === "Id" || k === "Description") continue;
      /* Layouts is a list of card images and is long; its length is the
       * only part that could plausibly matter here. */
      const shown = Array.isArray(v) ? `[${v.length} item(s)]` : JSON.stringify(v);
      console.log(`        ${k}: ${shown}`);
    }
  }

  /* 2. Unfiltered: does the site carry gift card products the studio's
   *    own location does not, the web POS's "Custom Amount" among them? */
  const all = await list(
    "?request.limit=100",
    "Every location, ids and names only",
  );
  const studioIds = new Set(
    atStudio.map((e) => String((e as Record<string, unknown>)["Id"])),
  );
  for (const entry of all) {
    const e = entry as Record<string, unknown>;
    const extra = studioIds.has(String(e["Id"])) ? "" : "  <-- NOT in the studio list";
    console.log(
      `  id=${String(e["Id"]).padEnd(6)} ${String(e["Description"] ?? "")}` +
        ` (value ${String(e["CardValue"])}, locations ${JSON.stringify(e["LocationIds"])})${extra}`,
    );
  }

  console.log("\nReads only: nothing was sold and nothing was changed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
