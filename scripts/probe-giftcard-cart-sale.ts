/**
 * Does a gift card sold through the CART actually become a card, and is a
 * discounted one worth its face value?
 *
 * This is the one question left after three earlier probes, and unlike
 * them it CANNOT be answered with `Test: true`, because a test call
 * commits nothing and a card that was never created has no barcode and no
 * balance to read. So this probe makes two REAL sales. Pete authorised it
 * explicitly on 2026-09-17 ("go"), after being told exactly that.
 *
 * What makes that acceptable, and what makes this script honest:
 *
 *  - Both sales are paid with a COMP payment, so no money moves, no card
 *    is charged and no account is debited.
 *  - `POST /sale/returnsale` (sale.yml:2056) says: "The sale is
 *    returnable only if it is a sale of a service, product or gift card
 *    and it has not been used. Currently, only the comp payment method is
 *    supported." A comp-paid gift card sale is therefore the one sale
 *    this API can undo, which is why the payment is a comp. (A comp is
 *    REFUSED on `purchasegiftcard` itself, probed 2026-09-17: "Invalid
 *    payment method", for a comp alone as well as beside another payment.
 *    A cart takes one, which is what makes this experiment possible.)
 *  - Each sale is returned immediately, and the balance is read again
 *    afterwards so the output says whether the return actually voided the
 *    card rather than assuming it.
 *  - If a return fails, the script says so LOUDLY and prints the barcode,
 *    because an unvoided live gift card is a bearer instrument someone
 *    could spend and it must be voided by hand in Mindbody.
 *
 * A barcode printed by this script is deliberate and is the ONE place
 * this project prints one outside the two teacher-facing screens: the
 * card it names is meant to be void seconds later, and if it is not, the
 * number is what lets a human go and kill it. It is still a bearer
 * secret, so this output belongs in a terminal and nowhere else.
 *
 * What the two sales ask:
 *
 *   S1. A fixed gift card product as a cart line, no discount, comped at
 *       its face value. Does a card come into existence, what is it
 *       worth, and what is its barcode? T102 needs to SET the barcode so
 *       a teacher can write it on blank stock, and the cart has no field
 *       for one, so an id Mindbody generates is the thing to look for.
 *   S2. The same line with a DiscountAmount, comped at the smaller
 *       figure. The Test probe already proved the discount lands in the
 *       totals ($28.00 / -$10.00 / $18.00 on product 323). This asks the
 *       question that matters: is the CARD still worth $28?
 *
 * If S2 issues a full-value card, the cart is the route for a discounted
 * gift card, and `purchasegiftcard` is needed only where the barcode must
 * be chosen. If S2 issues a card worth what was paid, the cart discounts
 * the card rather than its price, and T102's rehearsal guard is the whole
 * answer.
 *
 * Usage, against prod, and it will not run without the word LIVE:
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-giftcard-cart-sale.ts <clientId> LIVE [productId]
 *
 * Use the dummy client. Both rails must be open, and a suppressed call is
 * reported as suppressed rather than as a result.
 */
import { mindbody } from "../src/lib/mindbody";
import { giftCardProducts } from "../src/lib/giftcardsale";
import { STUDIO_LOCATION_ID } from "../src/lib/sale";

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "(none)" : `$${n.toFixed(2)}`;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Every string in a response held under a barcode-ish KEY. The cart's
 *  answer names its own fields and we do not know which one would carry a
 *  gift card id, so the search is by key at any depth rather than by
 *  guessing one path. */
function barcodesIn(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) {
    for (const item of v) barcodesIn(item, out);
    return out;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/barcode/i.test(k) && typeof val === "string" && val.trim()) {
        out.add(val.trim());
      }
      barcodesIn(val, out);
    }
  }
  return out;
}

async function balance(barcodeId: string): Promise<number | null> {
  try {
    const res: any = await mindbody(
      `/sale/giftcardbalance?barcodeId=${encodeURIComponent(barcodeId)}`,
    );
    return num(res?.RemainingBalance);
  } catch (err) {
    console.log(
      `      balance unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function sell(
  label: string,
  productId: number,
  clientId: string,
  face: number,
  discount: number,
): Promise<void> {
  const pay = Math.round((face - discount) * 100) / 100;
  console.log(`\n=== ${label}`);
  console.log(
    `    face ${money(face)}, discount ${money(discount)}, comped ${money(pay)}`,
  );
  let res: any;
  try {
    res = await mindbody("/sale/checkoutshoppingcart", {
      method: "POST",
      body: {
        Items: [
          {
            Item: { Type: "Product", Metadata: { Id: productId } },
            Quantity: 1,
            ...(discount > 0 ? { DiscountAmount: discount } : {}),
          },
        ],
        Payments: [{ Type: "Comp", Metadata: { Amount: pay } }],
        ClientId: clientId,
        Test: false,
        LocationId: STUDIO_LOCATION_ID,
        InStore: true,
        CalculateTax: true,
        SendEmail: false,
      },
      clientId,
    });
  } catch (err) {
    console.log(
      `    REFUSED: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log("    Nothing was sold, so there is nothing to return.");
    return;
  }
  if (res?.DryRun === true || res?.WriteSuppressed === true) {
    console.log(
      "    SUPPRESSED. Mindbody never saw this call, so it answers nothing.\n" +
        "    Set POS_DRY_RUN=false and list this client in POS_WRITE_CLIENT_IDS.",
    );
    return;
  }

  const cart = res?.ShoppingCart ?? {};
  const saleId = num(cart?.Id);
  console.log(
    `    SOLD. sale id ${saleId ?? "(none)"}  total ${money(num(cart?.GrandTotal))}` +
      `  discount ${money(num(cart?.DiscountTotal))}`,
  );

  const items: any[] = Array.isArray(cart?.PurchasedItems)
    ? cart.PurchasedItems
    : [];
  for (const it of items) {
    console.log(
      `    item: id ${it?.Id ?? "(none)"} ${it?.Name ?? ""}` +
        `${it?.Type ? ` [${it.Type}]` : ""}`,
    );
  }

  const found = [...barcodesIn(res)];
  if (found.length === 0) {
    console.log(
      "    NO BARCODE anywhere in the answer. Either the cart issued no\n" +
        "    card, or it issued one and does not say which. Look at the\n" +
        "    client's gift cards in Mindbody before trusting this route.",
    );
  }
  for (const code of found) {
    const bal = await balance(code);
    const worthFace = bal !== null && Math.abs(bal - face) < 0.005;
    const worthPaid = bal !== null && Math.abs(bal - pay) < 0.005;
    console.log(
      `    CARD ${code}  balance ${money(bal)}` +
        (worthFace ? "  <- worth its FACE VALUE" : "") +
        (worthPaid && discount > 0 ? "  <- worth only what was PAID" : ""),
    );
  }

  if (saleId === null) {
    console.log(
      "    !! NO SALE ID came back, so this sale cannot be returned from\n" +
        "    here. Find it in Mindbody and void it by hand.",
    );
    return;
  }
  try {
    const ret: any = await mindbody("/sale/returnsale", {
      method: "POST",
      body: {
        SaleId: saleId,
        ReturnReason: "API probe, comped, voided at once",
      },
      clientId,
    });
    if (ret?.DryRun === true || ret?.WriteSuppressed === true) {
      console.log(
        `    !! THE RETURN WAS SUPPRESSED. Sale ${saleId} is still live.` +
          " Void it by hand in Mindbody.",
      );
      return;
    }
    console.log(`    RETURNED. sale ${saleId} reversed.`);
    for (const code of found) {
      const after = await balance(code);
      console.log(
        `    card ${code} after the return: ${money(after)}` +
          (after !== null && after > 0
            ? "  !! STILL SPENDABLE, void it by hand"
            : ""),
      );
    }
  } catch (err) {
    console.log(
      `    !! THE RETURN FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(
      `    !! Sale ${saleId} is live and any card above is spendable.` +
        " Void it by hand in Mindbody now.",
    );
  }
}

async function main(): Promise<void> {
  const [clientId, live, productRaw] = process.argv.slice(2);
  if (!clientId || live !== "LIVE") {
    console.error(
      "This probe makes TWO REAL comped sales and returns each one.\n" +
        "Usage: npx tsx --env-file=.env scripts/probe-giftcard-cart-sale.ts " +
        "<clientId> LIVE [productId]",
    );
    process.exit(1);
  }

  const products = await giftCardProducts(true);
  const named =
    productRaw === undefined
      ? null
      : (products.find((p) => String(p.id) === productRaw) ?? null);
  if (productRaw !== undefined && !named) {
    console.log(`\nNo gift card product has id ${productRaw}.\n`);
    return;
  }
  const fixed = named ?? products.find((p) => !p.editable && p.cardValue > 0);
  if (!fixed) {
    console.log("\nNo fixed gift card product to ask about.\n");
    return;
  }
  const face = fixed.cardValue;
  const discount = Math.min(10, Math.round(face * 0.25 * 100) / 100);

  console.log(
    `\n=== ${fixed.description ?? "(unnamed)"} (id ${fixed.id}), face value ` +
      `${money(face)}\n` +
      "    Two real sales, both comped so no money moves, each returned\n" +
      "    immediately. A barcode printed below belongs to a live card\n" +
      "    until the return says otherwise.\n",
  );

  await sell("S1. no discount, comped in full", fixed.id, clientId, face, 0);
  await sell(
    `S2. ${money(discount)} off, comped at the smaller figure`,
    fixed.id,
    clientId,
    face,
    discount,
  );

  console.log(
    "\nWhat to read: whether a card exists at all, and in S2 whether its\n" +
      "balance is the FACE VALUE (the cart discounts the price, so the cart\n" +
      "is the route for a discounted gift card) or the AMOUNT PAID (the cart\n" +
      "discounts the card itself, so T102's rehearsal guard is the answer).\n" +
      "Then check in Mindbody that both sales are reversed and no card is\n" +
      "left with a balance.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
