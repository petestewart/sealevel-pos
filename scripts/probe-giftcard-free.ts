/**
 * Can a gift card be COMPED, and if so by what payment?
 *
 * Pete, 2026-09-19, asked whether "A gift card cannot be given away for
 * nothing" is a Mindbody constraint. It is not: it is a rule T102 was
 * told to build, standing on one probed fact and one untested
 * assumption. The fact is that `POST /sale/purchasegiftcard` refuses a
 * **Comp** payment outright ("Invalid payment method", 2026-09-17,
 * alone and beside another payment). The assumption is that there is
 * therefore no way to pay NOTHING for a card. This probe tests that
 * assumption, because Pete wants a comped gift card to be possible.
 *
 * A 100% discount means the customer pays nothing, so the question is
 * what shape of PaymentInfo Mindbody will accept for a zero payment:
 *
 *   A. No `PaymentInfo` key at all.
 *   B. `PaymentInfo: {}`, the key present and empty.
 *   C. A DebitAccount payment of $0.00. Account credit is a payment
 *      type this endpoint is KNOWN to take (the 2026-09-17 probe paid a
 *      card with it at $37.00 and $63.50), so zero is the only variable.
 *   D. A Cash payment of $0.00, the shape the counter would otherwise
 *      use.
 *   E. Each of the site's CUSTOM payment methods, at $0.00. A studio
 *      configures these itself (`GET /sale/custompaymentmethods`), and
 *      one of them may be exactly the "Comp" the gift card endpoint
 *      will not take under that name. The list is printed whether or
 *      not any of them works, because it is the studio's own vocabulary
 *      for money that did not arrive.
 *
 * Each case runs against a FIXED product and against the editable
 * custom-amount one, because they answer differently by nature: a fixed
 * product has a face value to issue, an editable one prices itself from
 * what it was paid, so a zero payment there could reasonably produce a
 * worthless card. What matters for each is not just whether it is
 * accepted but what `Value` comes back as, which is why both figures
 * are printed and compared.
 *
 * Every call is `Test: true`: Mindbody validates and commits nothing, so
 * no card is created, nothing is charged and no account is debited. The
 * barcode ids are generated and unused.
 *
 * Usage, against prod:
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-giftcard-free.ts <clientId> [productId]
 *
 * Both rails must be open even though nothing is sold: a Test purchase
 * is still a POST, so dry run and the write guard each suppress it, and
 * a suppressed call answers nothing and is reported as suppressed.
 *
 * What the answer decides. If some shape issues a card worth its FACE
 * VALUE for nothing, a comped gift card is possible and T102's refusal
 * can be lifted, with that card's value asserted to the cent exactly as
 * every other card's is. If a shape is accepted but issues a card worth
 * ZERO, that is worse than a refusal (the teacher would hand over a
 * dead card) and it must stay refused. If everything is refused, the
 * rule stands, and it stands on evidence rather than on judgement.
 */
import { mindbody } from "../src/lib/mindbody";
import {
  giftCardProducts,
  newGiftCardId,
  type GiftCardProduct,
} from "../src/lib/giftcardsale";
import { STUDIO_LOCATION_ID } from "../src/lib/sale";

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "(none)" : `$${n.toFixed(2)}`;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `undefined` means the key is omitted entirely, which is case A and
 *  is not the same thing as an empty object. */
type PayShape = Record<string, unknown> | undefined;

async function rehearse(
  label: string,
  product: GiftCardProduct,
  clientId: string,
  paymentInfo: PayShape,
  omit: boolean,
): Promise<void> {
  console.log(`\n  --- ${label}`);
  try {
    const body: Record<string, unknown> = {
      LocationId: STUDIO_LOCATION_ID,
      PurchaserClientId: clientId,
      GiftCardId: product.id,
      Test: true,
      LayoutId: 0,
      SendEmailReceipt: false,
      BarcodeId: newGiftCardId(),
    };
    if (!omit) body.PaymentInfo = paymentInfo;
    const res: any = await mindbody("/sale/purchasegiftcard", {
      method: "POST",
      body,
      clientId,
    });
    if (res?.DryRun === true || res?.WriteSuppressed === true) {
      console.log(
        "      SUPPRESSED. Mindbody never saw this call, so it answers\n" +
          "      nothing. Open both rails and run it again.",
      );
      return;
    }
    const value = num(res?.Value);
    const paid = num(res?.AmountPaid);
    console.log(
      `      ACCEPTED. Value ${money(value)}  AmountPaid ${money(paid)}`,
    );
    const face = product.editable ? null : product.cardValue;
    if (value === null) {
      console.log(
        "      -> but it said nothing about what the card is WORTH, which\n" +
          "         our checkout treats as a refusal. Not usable.",
      );
    } else if (value === 0) {
      console.log(
        "      -> the card is worth NOTHING. Worse than a refusal: the\n" +
          "         teacher would hand over a dead card. Must stay refused.",
      );
    } else if (face !== null && Math.abs(value - face) < 0.005) {
      console.log(
        `      -> A FREE CARD WORTH ITS FACE VALUE ${money(face)}. This is` +
          " the shape that\n         would let a gift card be comped.",
      );
    } else {
      console.log(
        `      -> a card worth ${money(value)}, which is neither zero nor` +
          ` the face value${face === null ? " (editable product)" : ""}.` +
          " Read it carefully before trusting it.",
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
      "Usage: npx tsx --env-file=.env scripts/probe-giftcard-free.ts " +
        "<clientId> [productId]",
    );
    process.exit(1);
  }

  const products = await giftCardProducts(true);
  if (products.length === 0) {
    console.log("\nThe site offers no gift card products. Nothing to ask.\n");
    return;
  }
  const named =
    productRaw === undefined
      ? null
      : (products.find((p) => String(p.id) === productRaw) ?? null);
  if (productRaw !== undefined && !named) {
    console.log(`\nNo gift card product has id ${productRaw}.\n`);
    return;
  }
  const fixed = named ?? products.find((p) => !p.editable && p.cardValue > 0);
  const editable = products.find((p) => p.editable) ?? null;

  /* The studio's own payment vocabulary. Printed whatever happens: if
   * none of the shapes below works, one of these names may be what the
   * front desk means by a comp, and it is the next thing to try. */
  console.log("\n=== the site's custom payment methods");
  let customs: { Id: number; Name: string }[] = [];
  try {
    const res: any = await mindbody("/sale/custompaymentmethods");
    customs = Array.isArray(res?.CustomPaymentMethods)
      ? res.CustomPaymentMethods
      : [];
    if (customs.length === 0) console.log("  (none configured)");
    for (const c of customs) console.log(`  id=${c?.Id}  ${c?.Name ?? ""}`);
  } catch (err) {
    console.log(
      `  unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const targets = [fixed, editable].filter(
    (p): p is GiftCardProduct => p !== undefined && p !== null,
  );
  for (const product of targets) {
    console.log(
      `\n=== ${product.description ?? "(unnamed)"} (id ${product.id}), ` +
        `${product.editable ? "EDITABLE" : `face value ${money(product.cardValue)}`}`,
    );
    console.log("=== Test: true throughout. No card is created, nothing is charged.");

    await rehearse("A. no PaymentInfo key at all", product, clientId, undefined, true);
    await rehearse("B. PaymentInfo: {}", product, clientId, {}, false);
    await rehearse(
      "C. DebitAccount $0.00",
      product,
      clientId,
      { Type: "DebitAccount", Metadata: { Amount: 0 } },
      false,
    );
    await rehearse(
      "D. Cash $0.00",
      product,
      clientId,
      { Type: "Cash", Metadata: { Amount: 0 } },
      false,
    );
    for (const c of customs) {
      await rehearse(
        `E. Custom "${c?.Name ?? c?.Id}" $0.00`,
        product,
        clientId,
        { Type: "Custom", Metadata: { Amount: 0, Id: c?.Id } },
        false,
      );
    }
  }

  console.log(
    "\nNothing above was sold: every call was Test: true.\n" +
      "A shape that ANSWERED with the face value for nothing is what makes\n" +
      "a comped gift card possible, and the value would still be asserted\n" +
      "to the cent before anything is issued. A shape accepted with a card\n" +
      "worth ZERO must stay refused: a dead card handed across the counter\n" +
      "is worse than a refusal. If everything was refused, the rule stands\n" +
      "on evidence rather than on judgement.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
