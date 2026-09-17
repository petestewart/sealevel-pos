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
 * <clientId> any real client to price against. With no [productId] it
 * lists every gift card product on the site and then probes TWO of
 * them, which answer different questions: the editable custom-amount
 * card, whose SalePrice is $0 so a cart prices it at nothing, and the
 * first fixed card, which carries a real SalePrice and is the only one
 * a cart could charge for and take a discount off.

 * The first honest run (2026-09-17, product 282) came back PRICED at
 * $0.00 with the audit reading `theirs $0.00 x1`: Mindbody matched the
 * line and charged nothing for it. A cart never carries our price, so
 * a product with no price of its own is a free card. That is the
 * reason this script now names the zero case loudly.
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
import { giftCardProducts, type GiftCardProduct } from "../src/lib/giftcardsale";
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
    /* A priced cart whose subtotal is ZERO when we asked for a real
     * figure is the dangerous answer, not a harmless one: Mindbody took
     * the line and charged nothing for it. Whether it took the ITEM is
     * what the audit below says: a null `theirPrice` means no line in
     * Mindbody's cart matched what we sent, so the cart is empty and the
     * gift card never entered it. */
    if ((priced.subTotal ?? 0) === 0 && priced.expectedSubtotal > 0) {
      console.log(
        `      -> ZERO. We asked for ${money(priced.expectedSubtotal)} and the` +
          ` cart came back worth nothing.`,
      );
    }
    for (const line of priced.lineAudit ?? []) {
      console.log(
        `      audit: id ${line.metadataId} as ${line.type}` +
          `  ours ${money(line.ourPrice)} x${line.quantity}` +
          `  theirs ${money(line.theirPrice)} x${line.theirQuantity ?? "(none)"}` +
          `${line.theirPrice === null ? "  <- NO LINE MATCHED: Mindbody priced no such item" : ""}`,
      );
    }
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

async function probeProduct(
  target: GiftCardProduct,
  clientId: string,
): Promise<void> {
  console.log(
    `\n=== ${target.description ?? "(unnamed)"} (id ${target.id}), value ` +
      `${money(target.cardValue)}, price ${money(target.salePrice)}` +
      `${target.editable ? ", EDITABLE (custom amount)" : ", fixed"}`,
  );
  /* A cart never carries our price: Mindbody prices a line from its own
   * catalog. So the figure here is only what we ASSERT against, and the
   * product's own numbers are the honest expectation. The editable
   * product has none, which is why it came back worth nothing; $50 is
   * the stand-in that makes that visible rather than plausible. */
  const price =
    target.salePrice > 0 ? target.salePrice : target.cardValue > 0 ? target.cardValue : 50;
  console.log(`    expecting ${money(price)} a card\n`);

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
  if (products.length === 0) {
    console.log("\nThe site offers no gift card products. Nothing to ask.\n");
    return;
  }

  console.log("\n=== the gift card products on this site");
  for (const p of products) {
    console.log(
      `  id=${String(p.id).padEnd(6)} value ${money(p.cardValue).padStart(9)}` +
        `  price ${money(p.salePrice).padStart(9)}` +
        `  ${p.editable ? "EDITABLE" : "fixed   "}  ${p.description ?? "(unnamed)"}`,
    );
  }

  /* Two products answer two different questions, so BOTH go out unless
   * one is named. The editable card has no price of its own and a cart
   * therefore prices it at nothing; a fixed card carries a real
   * SalePrice, and whether a cart charges that, and takes a discount off
   * it, is the question the first run could not reach. */
  const named =
    productRaw === undefined
      ? null
      : (products.find((p) => String(p.id) === productRaw) ?? null);
  if (productRaw !== undefined && !named) {
    console.log(`\nNo gift card product has id ${productRaw}.\n`);
    return;
  }
  const targets: GiftCardProduct[] = named
    ? [named]
    : [
        products.find((p) => p.editable),
        products.find((p) => !p.editable && p.salePrice > 0),
      ].filter((p): p is GiftCardProduct => p !== undefined);

  console.log("\n=== priced as a cart line, Test: true, nothing is sold");
  for (const target of targets) await probeProduct(target, clientId);

  console.log(
    "\nNothing above was sold: every call was a Test cart.\n" +
      "If a line PRICED at the figure asked and the discount LANDED, a\n" +
      "gift card can be discounted the way passes and retail already\n" +
      "are, and the next question is how the barcode id rides along. If\n" +
      "every line was refused, the purchase endpoint is the only route\n" +
      "and a discount there can only mean paying less. If a line PRICED\n" +
      "at ZERO, that is the worst of the three: Mindbody accepted the\n" +
      "cart and charged nothing, so the cart route would give a card\n" +
      "away. The audit line says whether it matched the item at all.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
