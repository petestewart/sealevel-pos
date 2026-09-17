/**
 * Can a gift card be DISCOUNTED, the way Mindbody's own POS discounts
 * one?
 *
 * Pete, 2026-09-17: "the gift card can be discounted regardless.
 * Mindbody UI lets you do that." His screenshot of that UI shows the
 * card as a TICKET LINE with three separate columns, Price, Value and
 * Discount, which is a shape `POST /sale/purchasegiftcard` does not
 * have: its whole field list is LocationId, PurchaserClientId,
 * GiftCardId, Test, LayoutId, SendEmailReceipt, RecipientEmail,
 * RecipientName, Title, GiftMessage, DeliveryDate, PaymentInfo,
 * SalesRepId, ConsumerPresent, PaymentAuthenticationCallbackUrl,
 * BarcodeId, SenderName. No price, no value, no discount, no promotion
 * code. The only figure the counter controls there is what is PAID, and
 * the T96 probes showed the custom-amount card's value simply follows
 * that.
 *
 * So the question this probe asks is whether the OTHER endpoint sells
 * one. `checkoutshoppingcart` takes `DiscountAmount` per line, which is
 * how every other discount in this app already works (T79), and
 * Mindbody's own POS showing the card as a ticket line is the reason to
 * think it belongs there. The spec's `CheckoutItem.Type` enumerates
 * Service, Product, Package and Tip and no gift card, but CLAUDE.md is
 * explicit that the spec's item metadata is a hole rather than an
 * answer, and that the way to settle such a question is a `Test: true`
 * call and a look at the totals.
 *
 * Every call here is `Test: true`: Mindbody validates and commits
 * nothing. Nothing is sold and no card is created.
 *
 * Usage, against prod:
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-giftcard-discount.ts <clientId> [productId]
 *
 * <clientId> any real client to price against. [productId] defaults to
 * the site's editable gift card product, the custom-amount one, which
 * is the case Pete is asking about.
 *
 * BOTH RAILS MATTER HERE even though nothing is sold: a Test cart is
 * still a POST, so dry run suppresses it and the write guard suppresses
 * it unless the client is listed. A suppressed call never reaches
 * Mindbody and answers nothing, which is why this script now refuses to
 * report one as a result (the first run of it did, and the output read
 * like an answer).
 *
 * What to read in the output: whether a gift card product prices as a
 * cart line at all, and if it does, whether a DiscountAmount comes back
 * in Mindbody's DiscountTotal. If both, the card can be discounted the
 * way everything else in this app is discounted, and the open question
 * becomes where the barcode id is carried. If it will not price as a
 * line, the purchase endpoint is the only route and a discount there
 * can only mean paying less, which for the custom card means a smaller
 * card.
 */
import { giftCardProducts } from "../src/lib/giftcardsale";
import { priceCart, type CartLine } from "../src/lib/sale";

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "(none)" : `$${n.toFixed(2)}`;
}

async function tryLine(
  label: string,
  line: CartLine,
  clientId: string,
  discount: { mode: "amount"; value: number } | null,
): Promise<void> {
  console.log(`\n  --- ${label}`);
  try {
    const priced = await priceCart([line], clientId, null, discount);
    if (priced.suppressed) {
      console.log(
        "      SUPPRESSED. Mindbody never saw this call, so it answers\n" +
          "      nothing. Set POS_DRY_RUN=false and put this client in\n" +
          "      POS_WRITE_CLIENT_IDS, then run it again.",
      );
      return;
    }
    console.log(
      `      PRICED. subtotal ${money(priced.subTotal)}` +
        `  discount ${money(priced.discountTotal)}` +
        `  tax ${money(priced.taxTotal)}  total ${money(priced.grandTotal)}`,
    );
    if (discount) {
      const took =
        priced.discountTotal !== null &&
        Math.abs(priced.discountTotal - discount.value) < 0.005;
      console.log(
        `      -> ${
          took
            ? "THE DISCOUNT LANDED. A gift card can be discounted as a cart line."
            : "the line priced but the discount did NOT land as asked."
        }`,
      );
    }
  } catch (err) {
    console.log(
      `      REFUSED: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function main(): Promise<void> {
  const [clientId, productRaw] = process.argv.slice(2);
  if (!clientId) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-giftcard-discount.ts " +
        "<clientId> [productId]",
    );
    process.exit(1);
  }

  const products = await giftCardProducts(true);
  const editable = products.find((p) => p.editable) ?? null;
  const wanted =
    productRaw === undefined ? null : products.find((p) => String(p.id) === productRaw);
  const target = wanted ?? editable ?? products[0];
  if (!target) {
    console.log("\nThe site offers no gift card products. Nothing to ask.\n");
    return;
  }
  console.log(
    `\n=== ${target.description ?? "(unnamed)"} (id ${target.id}), value ` +
      `${money(target.cardValue)}, price ${money(target.salePrice)}` +
      `${target.editable ? ", EDITABLE (custom amount)" : ", fixed"}\n`,
  );
  /* An editable product carries no price of its own, so the figure a
   * cart line would have to name is the teacher's. $50 is a plain,
   * round stand-in; the $10 discount below is what the question is. */
  const price = target.cardValue > 0 ? target.cardValue : 50;

  console.log("=== priced as a cart line, Test: true, nothing is sold");
  for (const type of ["Product", "Service"] as const) {
    const line: CartLine = {
      type,
      metadataId: target.id,
      quantity: 1,
      price,
      taxExempt: true,
      taxRate: null,
    };
    await tryLine(`as a ${type}, no discount`, line, clientId, null);
    await tryLine(`as a ${type}, $10.00 off`, line, clientId, {
      mode: "amount",
      value: 10,
    });
  }

  console.log(
    "\nNothing above was sold: every call was a Test cart.\n" +
      "If a line PRICED and the discount LANDED, a gift card can be\n" +
      "discounted the way passes and retail already are, and the next\n" +
      "question is how the barcode id rides along. If every line was\n" +
      "refused, the purchase endpoint is the only route and a discount\n" +
      "there can only mean paying less.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
