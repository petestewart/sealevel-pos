/**
 * T95's open question, answered against the live site: can the studio's
 * "Gift Card (Custom Amount)" product be sold for an amount the counter
 * chooses, or is a gift card's value always its PRODUCT's CardValue?
 *
 * `PurchaseGiftCardRequest` (docs/mindbody-openapi/sale.yml:5090) has no
 * amount field. The only figure in it the counter controls is the
 * PaymentInfo's amount, so the hypothesis this probe tests is that a
 * custom-amount product takes its value from what was paid. The answer
 * comes back in `Value` and `AmountPaid` (PurchaseGiftCardResponse,
 * sale.yml:4914).
 *
 * Nothing is sold. Every purchase here is `Test: true`, which per the
 * spec (sale.yml:5108) "allows you to test the request without affecting
 * the database". It runs through the app's own purchaseGiftCard(), so
 * what Mindbody sees is exactly what a real sale would send.
 *
 * Usage, against prod:
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-giftcards.ts <clientId> [amount]
 *
 * <clientId> is any real client to name as the purchaser (the house
 * client is the obvious one); nothing lands on their account, because
 * nothing lands at all. [amount] defaults to 37.00, deliberately an
 * amount no sensible product would carry, so a card that comes back
 * worth exactly that came from the payment and not from a coincidence.
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
import {
  giftCardProducts,
  newGiftCardId,
  purchaseGiftCard,
} from "../src/lib/giftcardsale";

function money(n: number | null): string {
  return n === null ? "(none)" : `$${n.toFixed(2)}`;
}

async function main(): Promise<void> {
  const [clientId, amountRaw] = process.argv.slice(2);
  const amount = Number(amountRaw ?? "37");
  if (!clientId || !Number.isFinite(amount) || amount <= 0) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-giftcards.ts <clientId> [amount]",
    );
    process.exit(1);
  }

  /* 1. What the site actually offers. A plain read: this half answers
   *    "which amounts can the counter sell today" on its own. */
  const products = await giftCardProducts(true);
  console.log(`\n=== ${products.length} gift card product(s) at the studio\n`);
  if (products.length === 0) {
    console.log(
      "  None. Until at least one exists, the shelf's Gift card box is empty\n" +
        "  and nothing can be sold.",
    );
  }
  for (const p of products) {
    const note = p.cardValue === p.salePrice ? "" : "   <-- price is not the value";
    console.log(
      `  id=${String(p.id).padEnd(6)} value=${money(p.cardValue).padEnd(9)}` +
        `price=${money(p.salePrice).padEnd(9)}${p.description ?? ""}${note}`,
    );
  }

  /* 2. The question. A custom-amount product is the one whose description
   *    says so; failing that, every product is rehearsed at the odd
   *    amount, which also proves what a FIXED product does with a payment
   *    that disagrees with its price (refuse, or quietly re-price). */
  const custom = products.filter((p) => /custom/i.test(p.description ?? ""));
  const targets = custom.length > 0 ? custom : products;
  if (targets.length === 0) return;
  console.log(
    `\n=== rehearsing ${targets.length} purchase(s) at ${money(amount)},` +
      ` Test: true, nothing is sold\n`,
  );
  for (const p of targets) {
    const barcodeId = newGiftCardId();
    const label = `id=${p.id} ${p.description ?? ""} (value ${money(p.cardValue)})`;
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
          `  ${label}\n    SUPPRESSED (${out.suppressed}). Mindbody never saw it:` +
            ` set POS_DRY_RUN=false and put ${clientId} in POS_WRITE_CLIENT_IDS.`,
        );
        continue;
      }
      const took = out.value !== null && Math.abs(out.value - amount) < 0.005;
      console.log(
        `  ${label}\n    Value=${money(out.value)}  AmountPaid=${money(out.amountPaid)}` +
          `  BarcodeId=${out.barcodeId ?? "(none)"} (sent ${barcodeId})\n` +
          `    -> ${
            took
              ? "TOOK THE AMOUNT. A custom-amount card is sellable; the number pad can be free."
              : "kept the product's own value. The amount paid does not set the card."
          }`,
      );
    } catch (err) {
      /* Mindbody's refusal IS an answer: it says which field it wanted. */
      console.log(
        `  ${label}\n    REFUSED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(
    "\nNothing above was sold: every call carried Test: true.\n" +
      "Paste this output back into the session and T95 can be finished either way.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
