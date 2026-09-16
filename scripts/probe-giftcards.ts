/**
 * T95's open question, answered against the live site: can a gift card be
 * sold for an amount the counter chooses, or is a card's value always its
 * PRODUCT's CardValue?
 *
 * `PurchaseGiftCardRequest` (docs/mindbody-openapi/sale.yml:5090) has no
 * amount field. The only figure in it the counter controls is the
 * PaymentInfo's amount, so the hypothesis is that an editable product
 * takes its value from what was paid. The answer comes back in `Value`
 * and `AmountPaid` (PurchaseGiftCardResponse, sale.yml:4914).
 *
 * WHAT THE FIRST TWO RUNS FOUND on site 471 (2026-09-16):
 *
 * - The site has ONE editable product, id 282 "Gift Card (Custom
 *   Amount)", `EditableByConsumer: true` and `CardValue: 0`. The first
 *   run never rehearsed it, because giftCardProducts() drops a product
 *   whose CardValue is not above zero and that is exactly what a
 *   custom-amount product carries. This script reads the endpoint raw so
 *   nothing is filtered out of the answer.
 * - The nine fixed products answered INCONSISTENTLY at an amount that
 *   disagreed with their price: six issued a card worth the amount paid,
 *   three issued a card worth their own CardValue while recording the
 *   smaller payment. Every documented field on those products is
 *   identical, so nothing here predicts which way one will go. That is
 *   why the checkout asserts BOTH figures before it charges: a card
 *   worth more than was paid for it is money out of the studio's till.
 *
 * Nothing is sold. Every purchase is `Test: true`, which per the spec
 * (sale.yml:5108) "allows you to test the request without affecting the
 * database". It runs through the app's own purchaseGiftCard(), so what
 * Mindbody sees is exactly what a real sale would send.
 *
 * Usage, against prod:
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-giftcards.ts <clientId> [productId]
 *
 * <clientId> is any real client to name as the purchaser (the house
 * client is the obvious one); nothing lands on their account, because
 * nothing lands at all. With no [productId] it rehearses every editable
 * product, and every product if the site has none. Each is rehearsed at
 * two odd amounts, so a card that follows both came from the payment and
 * not from a coincidence.
 *
 * The rails stay armed on purpose: POS_DRY_RUN must be false or dry run
 * suppresses the call before Mindbody sees it, and putting the purchaser
 * in POS_WRITE_CLIENT_IDS lets exactly this one through while every
 * other write stays suppressed. Test mode is the third rail on top.
 *
 * The barcode id is a secret everywhere else in this app. Here it is
 * printed, because a Test call creates no card for it to unlock and the
 * operator needs to see whether Mindbody echoed the id it was given.
 */
import { newGiftCardId, purchaseGiftCard } from "../src/lib/giftcardsale";
import { mindbody } from "../src/lib/mindbody";

/** The two amounts each product is rehearsed at. Odd on purpose: no
 *  sensible product carries either, so a card worth one of them was
 *  priced by the payment. */
const AMOUNTS = [37, 63.5];

interface RawProduct {
  id: number;
  description: string;
  cardValue: number;
  salePrice: number;
  editable: boolean;
}

function money(n: number | null): string {
  return n === null ? "(none)" : `$${n.toFixed(2)}`;
}

/** The endpoint read RAW, with no filtering of any kind: the app's own
 *  giftCardProducts() drops a zero-value product, which is the one this
 *  probe most needs to see. */
async function rawProducts(): Promise<RawProduct[]> {
  const res = await mindbody<{ GiftCards?: unknown }>(
    "/sale/giftcards?request.limit=100",
  );
  const raw = Array.isArray(res?.GiftCards) ? res.GiftCards : [];
  const out: RawProduct[] = [];
  for (const entry of raw) {
    const e = entry as Record<string, unknown>;
    const id = Number(e["Id"]);
    if (!Number.isInteger(id)) continue;
    const cardValue = Number(e["CardValue"] ?? 0);
    const salePrice = Number(e["SalePrice"] ?? 0);
    out.push({
      id,
      description: String(e["Description"] ?? ""),
      cardValue: Number.isFinite(cardValue) ? cardValue : 0,
      salePrice: Number.isFinite(salePrice) ? salePrice : 0,
      editable: e["EditableByConsumer"] === true,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const [clientId, productRaw] = process.argv.slice(2);
  if (!clientId) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-giftcards.ts <clientId> [productId]",
    );
    process.exit(1);
  }
  const wanted = productRaw === undefined ? null : Number(productRaw);
  if (wanted !== null && !Number.isInteger(wanted)) {
    console.error("productId must be a whole number");
    process.exit(1);
  }

  const products = await rawProducts();
  console.log(`\n=== ${products.length} gift card product(s) on the site\n`);
  for (const p of products) {
    const flags = [
      p.editable ? "EDITABLE" : "fixed",
      p.cardValue === p.salePrice ? "" : "price is not the value",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `  id=${String(p.id).padEnd(6)} value=${money(p.cardValue).padEnd(9)}` +
        `price=${money(p.salePrice).padEnd(9)}${p.description}  [${flags}]`,
    );
  }

  const editable = products.filter((p) => p.editable);
  const targets =
    wanted !== null
      ? products.filter((p) => p.id === wanted)
      : editable.length > 0
        ? editable
        : products;
  if (targets.length === 0) {
    console.log(
      `\nNo product ${wanted} on this site. Nothing rehearsed.\n`,
    );
    return;
  }
  console.log(
    `\n=== rehearsing ${targets.length} product(s) at ${AMOUNTS.map((a) =>
      money(a),
    ).join(" and ")}, Test: true, nothing is sold\n`,
  );
  for (const p of targets) {
    console.log(`  --- id=${p.id} ${p.description} (value ${money(p.cardValue)})`);
    for (const amount of AMOUNTS) {
      const barcodeId = newGiftCardId();
      try {
        const out = await purchaseGiftCard({
          productId: p.id,
          purchaserClientId: clientId,
          barcodeId,
          payment: { type: "Cash", amount },
          test: true,
          sendEmailReceipt: false,
        });
        if (out.suppressed !== null) {
          console.log(
            `      paid ${money(amount)}: SUPPRESSED (${out.suppressed}).` +
              ` Mindbody never saw it: set POS_DRY_RUN=false and put` +
              ` ${clientId} in POS_WRITE_CLIENT_IDS.`,
          );
          continue;
        }
        const took = out.value !== null && Math.abs(out.value - amount) < 0.005;
        console.log(
          `      paid ${money(amount)}: Value=${money(out.value)}` +
            `  AmountPaid=${money(out.amountPaid)}` +
            `  BarcodeId=${out.barcodeId ?? "(none)"} (sent ${barcodeId})` +
            `  -> ${took ? "TOOK THE AMOUNT" : "kept its own value"}`,
        );
      } catch (err) {
        /* Mindbody's refusal IS an answer: it says which field it wanted. */
        console.log(
          `      paid ${money(amount)}: REFUSED: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  console.log(
    "\nNothing above was sold: every call carried Test: true.\n" +
      "A product that took BOTH amounts prices from the payment, and the\n" +
      "counter's number pad can sell through it.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
