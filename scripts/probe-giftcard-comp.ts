/**
 * Can a gift card be DISCOUNTED by paying part of it with Comp?
 *
 * Pete, 2026-09-17: "did you try using Comp as part of the PaymentInfo
 * body?" No, and it is the shape the other probes missed.
 *
 * Why it might work, and why it matters. `POST /sale/purchasegiftcard`
 * has no price, value or discount field: the only figure the counter
 * controls is what is PAID (`PaymentInfo`). The T96 probes then found
 * that six of site 471's nine fixed products issue a card worth what was
 * paid rather than their own CardValue, so simply paying less is a coin
 * flip between discounting the card and SHRINKING it. Comp sidesteps the
 * coin flip: if the endpoint takes a comp of the discount beside a real
 * payment for the rest, the TOTAL paid is still the face value, so every
 * product, follower and non-follower alike, issues a full-value card
 * while the customer is charged less. That is what the studio means by a
 * discount, and it is what Mindbody's own POS appears to do.
 *
 * Comp is an enumerated payment type on this endpoint's payment model
 * (CheckoutPaymentInfo, sale.yml, "Comp Keys - amount") and this app
 * already prices every cart with a Comp stub, so the type is known to
 * work on this site.
 *
 * Four questions, in order:
 *
 *   A. Comp ALONE for the face value. A free card. Mostly this
 *      establishes that the endpoint takes a Comp at all, and what it
 *      then says the card is worth.
 *   B. Comp alone for PART of the face value. If Value comes back at the
 *      face value while AmountPaid is the smaller figure, the product is
 *      a non-follower and this tells us nothing new. If Value follows the
 *      comp, it is a follower and a bare part-payment shrinks the card,
 *      which is the T102 refusal doing its job.
 *   C. TWO payments, a Comp for the discount and a real payment for the
 *      rest. The spec types PaymentInfo as ONE payment object, but the
 *      spec also types Metadata as a string when the live API takes an
 *      object, so absence there is absence of documentation. If an array
 *      is accepted and Value is the face value with AmountPaid the face
 *      value, THAT IS THE DISCOUNT MECHANISM.
 *   D. The same two payments against the editable custom-amount product,
 *      which prices itself from what it is paid.
 *
 * Every call is `Test: true`: Mindbody validates and commits nothing, so
 * no card is created and no account is debited. The barcode ids are real
 * generated ids, unused, and never reach a card.
 *
 * Usage, against prod:
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-giftcard-comp.ts <clientId> [productId]
 *
 * BOTH RAILS APPLY even though nothing is sold: a Test purchase is still
 * a POST, so dry run and the write guard each suppress it. A suppressed
 * call answers nothing and is reported as SUPPRESSED, never as a result.
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

type Pay = { Type: string; Metadata: Record<string, unknown> };

const comp = (amount: number): Pay => ({
  Type: "Comp",
  Metadata: { Amount: amount },
});
const account = (amount: number): Pay => ({
  Type: "DebitAccount",
  Metadata: { Amount: amount },
});

/** One rehearsal. `paymentInfo` goes out exactly as given, which is the
 *  point: case C sends an ARRAY where the spec documents an object. */
async function rehearse(
  label: string,
  productId: number,
  clientId: string,
  paymentInfo: Pay | Pay[],
  expectValue: number,
  expectPaid: number,
): Promise<void> {
  console.log(`\n  --- ${label}`);
  console.log(
    `      expecting a card worth ${money(expectValue)} for ${money(expectPaid)}`,
  );
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
        PaymentInfo: paymentInfo,
        BarcodeId: newGiftCardId(),
      },
      clientId,
    });
    if (res?.DryRun === true || res?.WriteSuppressed === true) {
      console.log(
        "      SUPPRESSED. Mindbody never saw this call, so it answers\n" +
          "      nothing. Set POS_DRY_RUN=false and put this client in\n" +
          "      POS_WRITE_CLIENT_IDS, then run it again.",
      );
      return;
    }
    const value = num(res?.Value);
    const paid = num(res?.AmountPaid);
    console.log(`      ANSWERED. Value ${money(value)}  AmountPaid ${money(paid)}`);
    if (value === null || paid === null) {
      console.log(
        "      -> a figure is MISSING, which our checkout treats as a refusal.",
      );
      return;
    }
    const valueOk = Math.abs(value - expectValue) < 0.005;
    const paidOk = Math.abs(paid - expectPaid) < 0.005;
    if (valueOk && paidOk) {
      console.log("      -> BOTH FIGURES AS EXPECTED.");
    } else if (!valueOk && value < expectValue) {
      console.log(
        `      -> THE CARD SHRANK: worth ${money(value)} where the face value` +
          ` is ${money(expectValue)}.`,
      );
    } else if (!valueOk) {
      console.log(
        `      -> THE CARD IS WORTH MORE THAN EXPECTED (${money(value)}), which` +
          ` is money out of the till.`,
      );
    } else {
      console.log(
        `      -> the card is right but the amount paid is ${money(paid)}.`,
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
      "Usage: npx tsx --env-file=.env scripts/probe-giftcard-comp.ts " +
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
  const fixed: GiftCardProduct | undefined =
    named ?? products.find((p) => !p.editable && p.cardValue > 0);
  const editable = products.find((p) => p.editable) ?? null;
  if (!fixed) {
    console.log("\nNo fixed gift card product to ask about.\n");
    return;
  }

  const face = fixed.cardValue;
  const discount = Math.min(10, Math.round(face * 0.25 * 100) / 100);
  const rest = Math.round((face - discount) * 100) / 100;

  console.log(
    `\n=== ${fixed.description ?? "(unnamed)"} (id ${fixed.id}), face value ` +
      `${money(face)}, price ${money(fixed.salePrice)}\n` +
      `    a ${money(discount)} discount would charge ${money(rest)}\n`,
  );
  console.log("=== Test: true throughout. No card is created, nothing is charged.");

  await rehearse("A. Comp alone, the whole face value (a free card)",
    fixed.id, clientId, comp(face), face, face);

  await rehearse(`B. Comp alone, only ${money(rest)} of it`,
    fixed.id, clientId, comp(rest), face, rest);

  await rehearse(
    `C. TWO payments: Comp ${money(discount)} + account ${money(rest)}`,
    fixed.id, clientId, [comp(discount), account(rest)], face, face);

  if (editable) {
    const custom = 50;
    const cDisc = 10;
    console.log(
      `\n=== ${editable.description ?? "(unnamed)"} (id ${editable.id}), the` +
        ` editable card, asking for a ${money(custom)} card\n`,
    );
    await rehearse(
      `D. TWO payments: Comp ${money(cDisc)} + account ${money(custom - cDisc)}`,
      editable.id, clientId, [comp(cDisc), account(custom - cDisc)],
      custom, custom);
  }

  console.log(
    "\nNothing above was sold: every call was Test: true.\n" +
      "The one that matters is C. If it ANSWERED with the face value and\n" +
      "the face value paid, a gift card can be discounted without ever\n" +
      "risking a shrunken card, on every product, and that becomes the\n" +
      "route. If it was REFUSED, PaymentInfo takes one payment only and\n" +
      "a discount stays what T102 built: paying less, with the rehearsal\n" +
      "refusing any product that answers with a smaller card.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
