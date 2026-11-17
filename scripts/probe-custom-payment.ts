/**
 * Phase 4 probes R1, R2, R3 and R5 (docs/PLAN.md): will Mindbody record a
 * sale paid on the studio's own Stripe card reader?
 *
 * The reader's money lands in Stripe, not Mindbody, so the Mindbody half of
 * every reader sale is recorded under a CUSTOM payment method the studio
 * creates in Mindbody (P7, e.g. "Card (Stripe reader)"). Everything in
 * Phase 4 rests on Mindbody accepting that payment on each route a sale can
 * take, and nobody has asked it yet:
 *
 *   R1. `GET /sale/custompaymentmethods`: what the site has, and under which
 *       key. The spec says `PaymentMethods` (sale.yml:2798) while
 *       scripts/probe-giftcard-free.ts reads `CustomPaymentMethods`, so that
 *       script may have printed "(none configured)" for a site that has
 *       some. Both keys are read and printed.
 *   R2. A cart (`checkoutshoppingcart`) paid with `Custom`. The shape tried
 *       first is the PascalCase OBJECT every proven payment here uses,
 *       `{ Type: "Custom", Metadata: { Amount, Id } }`; if Mindbody refuses
 *       it, the spec's lowercase key list (sale.yml:3934) is tried as a
 *       second, separate question and reported as such. This is a probe:
 *       the checkout route itself never retries a payment in another shape.
 *   R3. R2 again with a `Notes` key carrying a made-up PaymentIntent id, to
 *       see whether `SalePayment.Notes` (sale.yml:4557) could carry the
 *       Stripe link inside Mindbody. Only the answer is printed here; R4
 *       (a real sale read back) is what shows whether the note SURVIVES.
 *   R5. Gift cards, three ways, because a cart must never carry a gift card
 *       (T103) and `purchasegiftcard` already refuses Comp:
 *         a. `purchasegiftcard` paid with Custom, directly.
 *         b. `purchaseaccountcredit` paid with Custom: the first half of
 *            Pete's manual workaround (sell the student account credit on
 *            the reader, behind the scenes). `purchaseCredit` in
 *            src/lib/sale.ts makes this call; no card sale reaches it
 *            since T238 retired the $10 card floor.
 *         c. `purchasegiftcard` paid with DebitAccount: the second half,
 *            spending that credit on the card. A Test call cannot chain b
 *            into c, so c asks against whatever balance the client already
 *            holds; "insufficient" is an answer about the balance, not the
 *            payment type, and is printed as such.
 *
 * EVERY call is `Test: true`. Mindbody validates and commits nothing: no
 * sale, no credit, no card, nothing charged. The gift card barcode ids are
 * generated and unused.
 *
 * Usage. The custom method id comes from R1; run once without it to list
 * them, then again with it:
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-custom-payment.ts <clientId> <pricingOptionId> [customMethodId]
 *
 *   MINDBODY_TARGET=sandbox npx tsx --env-file=.env \
 *     scripts/probe-custom-payment.ts <clientId> <pricingOptionId> [customMethodId]
 *
 * BOTH RAILS APPLY even though nothing is sold: a Test call is still a POST,
 * so dry run and the write guard each suppress it, and a suppressed call is
 * reported as SUPPRESSED, never as an answer. Use a dummy client (100042041
 * on prod) and a cheap pricing option such as the drop-in.
 */
import { mindbody, target } from "../src/lib/mindbody";
import {
  pricingOptions,
  priceCart,
  STUDIO_LOCATION_ID,
  type CartLine,
} from "../src/lib/sale";
import { giftCardProducts, newGiftCardId } from "../src/lib/giftcardsale";

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "(none)" : `$${n.toFixed(2)}`;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function suppressed(res: any): boolean {
  return res?.DryRun === true || res?.WriteSuppressed === true;
}

const SUPPRESSED_LINE =
  "      SUPPRESSED. Mindbody never saw this call. Set POS_DRY_RUN=false and\n" +
  "      put this client in POS_WRITE_CLIENT_IDS, then run it again.";

type Pay = { Type: string; Metadata: unknown };

/** The shape Phase 4 will ship: PascalCase object, like every proven one. */
const customPascal = (amount: number, id: number, notes?: string): Pay => ({
  Type: "Custom",
  Metadata: { Amount: amount, Id: id, ...(notes ? { Notes: notes } : {}) },
});

/** The spec's own key list for the type (sale.yml:3934), as a JSON string,
 *  which is how T83 found the gift card payment wants its Metadata. */
const customLower = (amount: number, id: number): Pay => ({
  Type: "Custom",
  Metadata: JSON.stringify({ amount, id }),
});

async function r1(): Promise<void> {
  console.log("\n=== R1. Custom payment methods on this site");
  try {
    const res: any = await mindbody("/sale/custompaymentmethods");
    for (const key of ["PaymentMethods", "CustomPaymentMethods"]) {
      const list = res?.[key];
      if (!Array.isArray(list)) {
        console.log(`  ${key}: (absent)`);
        continue;
      }
      console.log(`  ${key}: ${list.length} method(s)`);
      for (const m of list) console.log(`    id=${m?.Id}  ${m?.Name ?? ""}`);
    }
    const others = Object.keys(res ?? {}).filter(
      (k) => !["PaymentMethods", "CustomPaymentMethods", "PaginationResponse"].includes(k),
    );
    if (others.length > 0) console.log(`  other keys in the answer: ${others.join(", ")}`);
  } catch (err) {
    console.log(`  unreadable: ${errText(err)}`);
  }
}

/** One Test: true cart with the given payments, reported plainly. */
async function cartWith(
  label: string,
  line: CartLine,
  clientId: string,
  payments: Pay[],
  expectTotal: number,
): Promise<boolean> {
  console.log(`\n  --- ${label}`);
  try {
    const res: any = await mindbody("/sale/checkoutshoppingcart", {
      method: "POST",
      body: {
        Items: [
          { Item: { Type: line.type, Metadata: { Id: line.metadataId } }, Quantity: 1 },
        ],
        ClientId: clientId,
        Test: true,
        LocationId: STUDIO_LOCATION_ID,
        InStore: true,
        CalculateTax: true,
        Payments: payments,
      },
      clientId,
    });
    if (suppressed(res)) {
      console.log(SUPPRESSED_LINE);
      return false;
    }
    const total = num(res?.ShoppingCart?.GrandTotal);
    console.log(
      `      ACCEPTED. GrandTotal ${money(total)} (expected ${money(expectTotal)})`,
    );
    return true;
  } catch (err) {
    console.log(`      REFUSED: ${errText(err)}`);
    return false;
  }
}

async function r2r3(
  clientId: string,
  optionId: number,
  customId: number,
): Promise<void> {
  console.log("\n=== R2 and R3. A cart paid with the custom method (Test: true)");
  const option = (await pricingOptions()).find((o) => Number(o.id) === optionId);
  if (!option) {
    console.log(`  Pricing option ${optionId} is not on this site's shelf list.`);
    return;
  }
  const line: CartLine = {
    type: "Service",
    metadataId: option.id,
    quantity: 1,
    price: option.price,
    taxExempt: option.taxExempt,
    taxRate: option.taxRate,
  };
  let total: number | null = null;
  try {
    const priced = await priceCart([line], clientId, null, null, null);
    if (priced.suppressed) {
      console.log(SUPPRESSED_LINE);
      return;
    }
    total = priced.grandTotal;
  } catch (err) {
    console.log(`  The cart would not price at all: ${errText(err)}`);
    return;
  }
  if (total === null) {
    console.log("  The cart priced with no GrandTotal; nothing to pay.");
    return;
  }
  console.log(`  ${option.name}: priced ${money(total)} with the usual Comp stub`);

  const pascal = await cartWith(
    "R2. PascalCase object { Amount, Id }",
    line, clientId, [customPascal(total, customId)], total,
  );
  if (!pascal) {
    await cartWith(
      "R2b. The spec's lowercase keys, as a JSON string { amount, id }",
      line, clientId, [customLower(total, customId)], total,
    );
  }
  await cartWith(
    "R3. PascalCase with Notes carrying a made-up PaymentIntent id",
    line, clientId, [customPascal(total, customId, "pi_probe_not_real")], total,
  );
}

async function giftCard(
  label: string,
  clientId: string,
  productId: number,
  payment: Pay,
  face: number,
): Promise<void> {
  console.log(`\n  --- ${label}`);
  try {
    const res: any = await mindbody("/sale/purchasegiftcard", {
      method: "POST",
      body: {
        LocationId: STUDIO_LOCATION_ID,
        PurchaserClientId: clientId,
        GiftCardId: productId,
        Test: true,
        LayoutId: 0,
        SendEmailReceipt: false,
        PaymentInfo: payment,
        BarcodeId: newGiftCardId(),
      },
      clientId,
    });
    if (suppressed(res)) {
      console.log(SUPPRESSED_LINE);
      return;
    }
    const value = num(res?.Value);
    const paid = num(res?.AmountPaid);
    const ok =
      value !== null && paid !== null &&
      Math.abs(value - face) < 0.005 && Math.abs(paid - face) < 0.005;
    console.log(
      `      ACCEPTED. Value ${money(value)}  AmountPaid ${money(paid)}` +
        (ok ? "  (both as expected)" : `  (expected ${money(face)} for both)`),
    );
  } catch (err) {
    console.log(`      REFUSED: ${errText(err)}`);
  }
}

async function r5(clientId: string, customId: number): Promise<void> {
  console.log("\n=== R5. Gift cards (Test: true)");
  const products = await giftCardProducts(true);
  const fixed = products.find((p) => !p.editable && p.cardValue > 0) ?? null;
  if (!fixed) {
    console.log("  No fixed gift card product on this site to ask about.");
  } else {
    const face = fixed.salePrice;
    console.log(
      `  ${fixed.description ?? "(unnamed)"} (id ${fixed.id}), price ${money(face)},` +
        ` value ${money(fixed.cardValue)}`,
    );
    await giftCard(
      "R5a. purchasegiftcard paid with the custom method",
      clientId, fixed.id, customPascal(face, customId), face,
    );
    await giftCard(
      "R5c. purchasegiftcard paid from account credit (DebitAccount)",
      clientId, fixed.id, { Type: "DebitAccount", Metadata: { Amount: face } }, face,
    );
  }

  console.log("\n  --- R5b. purchaseaccountcredit paid with the custom method, $10.00");
  try {
    const res: any = await mindbody("/sale/purchaseaccountcredit", {
      method: "POST",
      body: {
        ClientId: clientId,
        Test: true,
        LocationId: STUDIO_LOCATION_ID,
        SendEmailReceipt: false,
        PaymentInfo: customPascal(10, customId),
      },
      clientId,
    });
    if (suppressed(res)) {
      console.log(SUPPRESSED_LINE);
    } else {
      console.log(`      ACCEPTED. Answer: ${JSON.stringify(res)}`);
    }
  } catch (err) {
    console.log(`      REFUSED: ${errText(err)}`);
  }
}

async function main(): Promise<void> {
  const [clientId, optionRaw, customRaw] = process.argv.slice(2);
  const optionId = Number(optionRaw);
  if (!clientId || !Number.isInteger(optionId)) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-custom-payment.ts " +
        "<clientId> <pricingOptionId> [customMethodId]",
    );
    process.exit(1);
  }
  console.log(`Target: ${target()}. Test: true throughout; nothing is sold.`);

  await r1();

  if (customRaw === undefined) {
    console.log(
      "\nNo custom method id given, so R2, R3 and R5 were not asked. Create the\n" +
        "reader's method in Mindbody if R1 shows none, then run again with its id.\n",
    );
    return;
  }
  const customId = Number(customRaw);
  if (!Number.isInteger(customId) || customId <= 0) {
    console.error(`"${customRaw}" is not a custom payment method id.`);
    process.exit(1);
  }

  await r2r3(clientId, optionId, customId);
  await r5(clientId, customId);
  console.log(
    "\nRecord the answers in docs/PLAN.md's probe table (R1, R2, R3, R5).\n",
  );
}

main().catch((err) => {
  console.error(errText(err));
  process.exit(1);
});
