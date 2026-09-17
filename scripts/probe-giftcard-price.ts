/**
 * Can `POST /sale/updateproductprice` even ADDRESS a gift card product?
 *
 * Pete, 2026-09-17: "my only other idea to support this is to use POST
 * /sale/updateproductprice to dynamically update the price of a custom
 * gift card every time it is sold."
 *
 * The endpoint identifies its product by **BarcodeId**, not by id
 * (sale.yml:2154: the request is `{ BarcodeId, Price, OnlinePrice }`, and
 * "Passing at least one of them is mandatory" refers to the two prices).
 * The vendored `GiftCard` schema has no BarcodeId: Id, LocationIds,
 * Description, EditableByConsumer, CardValue, SalePrice, SoldOnline,
 * MembershipRestrictionIds, GiftCardTerms, ContactInfo, DisplayLogo,
 * Layouts. So on the documentation this cannot be pointed at a gift card
 * at all.
 *
 * But the spec has been wrong about presence before (CLAUDE.md's standing
 * rule: absence in the spec is absence of documentation), and the live
 * `/sale/giftcards` answer might carry fields the schema omits. Two
 * reads settle it, and this probe is READ-ONLY: it changes no price and
 * sells nothing.
 *
 *   1. Every KEY the live gift card answer actually returns, per product,
 *      with anything barcode-ish called out. If a gift card product
 *      carries a barcode, the endpoint has something to aim at.
 *   2. Whether the gift card products also appear in `/sale/products`,
 *      which is where a BarcodeId lives, matched by name and by id. If a
 *      gift card is also a retail product, that product's barcode is the
 *      other way in.
 *
 * Read the verdict at the bottom, and read the design note with it: even
 * where this CAN be pointed at something, a price change is a change to
 * the studio's live catalog, not to one sale. See the reply that went
 * with this probe.
 *
 * Usage, against prod. No writes, so neither rail has to be opened:
 *
 *   MINDBODY_TARGET=prod npx tsx --env-file=.env \
 *     scripts/probe-giftcard-price.ts
 */
import { mindbody } from "../src/lib/mindbody";
import { STUDIO_LOCATION_ID } from "../src/lib/sale";

function money(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n)
    ? `$${n.toFixed(2)}`
    : String(n ?? "(none)");
}

async function main(): Promise<void> {
  console.log("\n=== 1. every field the live gift card answer returns\n");
  const gc: any = await mindbody(
    `/sale/giftcards?request.locationId=${STUDIO_LOCATION_ID}&request.limit=100`,
  );
  const cards: any[] = Array.isArray(gc?.GiftCards) ? gc.GiftCards : [];
  if (cards.length === 0) {
    console.log("  No gift card products came back.\n");
    return;
  }
  const allKeys = new Set<string>();
  for (const c of cards) for (const k of Object.keys(c ?? {})) allKeys.add(k);
  console.log(`  keys across ${cards.length} products: ${[...allKeys].sort().join(", ")}\n`);

  const barcodeKeys = [...allKeys].filter((k) => /barcode/i.test(k));
  if (barcodeKeys.length === 0) {
    console.log(
      "  NO barcode-ish key anywhere. updateproductprice takes a BarcodeId\n" +
        "  and a gift card product has none, so it cannot be aimed at one\n" +
        "  directly.\n",
    );
  } else {
    console.log(`  barcode-ish keys present: ${barcodeKeys.join(", ")}`);
    for (const c of cards) {
      const vals = barcodeKeys.map((k) => `${k}=${String(c?.[k] ?? "(none)")}`);
      console.log(
        `    id=${c?.Id}  ${c?.Description ?? "(unnamed)"}  ${vals.join("  ")}`,
      );
    }
    console.log();
  }

  console.log("=== 2. are the gift card products also retail products?\n");
  const names = new Set(
    cards
      .map((c) => String(c?.Description ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const ids = new Set(cards.map((c) => c?.Id).filter((v) => v !== undefined));

  const prods: any[] = [];
  /* /sale/products is paged; 3 pages of 200 covers a studio's catalog
   * comfortably and stops rather than looping forever. */
  for (let offset = 0; offset < 600; offset += 200) {
    const res: any = await mindbody(
      `/sale/products?request.limit=200&request.offset=${offset}` +
        `&request.locationId=${STUDIO_LOCATION_ID}`,
    );
    const page: any[] = Array.isArray(res?.Products) ? res.Products : [];
    prods.push(...page);
    if (page.length < 200) break;
  }
  console.log(`  ${prods.length} retail products read.`);

  const hits = prods.filter((p) => {
    const nm = String(p?.Name ?? "").trim().toLowerCase();
    return ids.has(p?.Id) || (nm && names.has(nm)) || /gift\s*card/i.test(nm);
  });
  if (hits.length === 0) {
    console.log(
      "  None of the gift card products appears in /sale/products, so\n" +
        "  there is no retail barcode standing in for one either.\n",
    );
  } else {
    for (const p of hits) {
      console.log(
        `    id=${p?.Id}  ${p?.Name ?? "(unnamed)"}  price ${money(p?.Price)}` +
          `  online ${money(p?.OnlinePrice)}  barcode ${p?.BarcodeId ?? "(none)"}`,
      );
    }
    console.log(
      "\n  A product above with a BarcodeId is something updateproductprice\n" +
        "  COULD be aimed at. Whether it is the same thing the gift card\n" +
        "  endpoint sells is the next question, and it is not answered by a\n" +
        "  matching name.\n",
    );
  }

  console.log(
    "Read this with the design note: a price update is a change to the\n" +
      "studio's live catalog, not to one sale. Every iPad, the online store\n" +
      "and anyone mid-checkout sees the new figure until it is put back, and\n" +
      "a process that dies between the sale and the revert leaves a\n" +
      "mispriced product behind. Nothing was changed by this probe.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
