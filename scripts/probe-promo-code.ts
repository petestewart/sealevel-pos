/**
 * T220: does a Mindbody promotion code move a `Test: true` cart's total?
 *
 * The counter's promotion code field (CLAUDE.md, T220) shows MINDBODY's
 * discount and total, read off the `Test: true` rehearsal, and charges
 * the total that rehearsal priced. That rests on one thing nobody has
 * watched yet: that `PromotionCode` on `POST /sale/checkoutshoppingcart`
 * (sale.yml:5684) is HONOURED under `Test: true`, so the rehearsal's
 * DiscountTotal and GrandTotal are the coded ones. This asks it, side by
 * side: the same one-line cart with no code, then with the code.
 *
 * Every pricing here is `Test: true`: nothing is sold and the code is
 * not spent (if Mindbody counted a Test use against `MaxUses: 1`, the
 * second run of this script would say so, which is itself an answer).
 *
 * The one optional WRITE is `--create`, which makes a promotion code
 * with `POST /site/addpromocode`, and only in the SANDBOX: it refuses
 * outright against prod, where codes are made by hand or by Pete's own
 * mailing run. It needs the "Set up promotions / Semester discounts"
 * permission on the sandbox staff login.
 *
 * Usage, sandbox first (dry run is forced off there):
 *
 *   MINDBODY_TARGET=sandbox npx tsx --env-file=.env \
 *     scripts/probe-promo-code.ts <clientId> <code> <pricingOptionId> [--create <amountOff>]
 *
 * then prod, against a dummy client in the write guard (a Test cart is
 * still a POST, so dry run and the write guard both suppress it):
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-promo-code.ts <clientId> <code> 581
 *
 * What to read: "WITH THE CODE" should show a DiscountTotal equal to the
 * code's amount and a GrandTotal that moved by it, with T75's SubTotal
 * check still agreeing (SubTotal is before discounts). If the totals do
 * not move, the rehearsal is not honouring the code and the counter will
 * say "took nothing off" for every code: do not ship the field to the
 * counter until that is understood.
 */
import { mindbody, target } from "../src/lib/mindbody";
import {
  pricingOptions,
  priceCart,
  priceCartWithPromotion,
  type CartLine,
} from "../src/lib/sale";

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "(none)" : `$${n.toFixed(2)}`;
}

function studioDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  /* Site-local wall clock, as every request here is read (CLAUDE.md). */
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) + "T00:00:00";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [clientId, code, optionRaw] = args;
  const createAt = args.indexOf("--create");
  if (!clientId || !code || !optionRaw) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-promo-code.ts " +
        "<clientId> <code> <pricingOptionId> [--create <amountOff>]",
    );
    process.exit(1);
  }
  const optionId = Number(optionRaw);
  console.log(`\n=== target ${target()}, client ${clientId}, code ${code}, option ${optionId}`);

  if (createAt >= 0) {
    if (target() !== "sandbox") {
      console.error("--create is refused outside the sandbox. Make prod codes by hand.");
      process.exit(1);
    }
    const amount = Number(args[createAt + 1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      console.error("--create needs the dollar amount off, e.g. --create 28");
      process.exit(1);
    }
    console.log(`\n--- creating ${code}: $${amount.toFixed(2)} off item ${optionId}, one use, a week`);
    try {
      const made = await mindbody("/site/addpromocode", {
        method: "POST",
        body: {
          Code: code,
          Name: `T220 probe ${code}`,
          Active: true,
          Discount: { Type: "Amount", Amount: amount },
          ActivationDate: studioDay(0),
          ExpirationDate: studioDay(7),
          MaxUses: 1,
          AllowOnline: false,
          ApplicableItems: [{ Type: "Item", Id: optionId }],
        },
      });
      console.log(`    created: ${JSON.stringify(made).slice(0, 400)}`);
    } catch (err) {
      console.log(`    REFUSED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const option = (await pricingOptions()).find((o) => Number(o.id) === optionId);
  if (!option) {
    console.log(`\nPricing option ${optionId} is not on this site's shelf list. Nothing to price.`);
    return;
  }
  console.log(
    `\n    ${option.name}: ${money(option.price)}, intro offer ${String(option.isIntroOffer)}`,
  );
  const line: CartLine = {
    type: "Service",
    metadataId: option.id,
    quantity: 1,
    price: option.price,
    taxExempt: option.taxExempt,
    taxRate: option.taxRate,
  };

  console.log("\n--- WITHOUT A CODE");
  let plainTotal: number | null = null;
  try {
    const plain = await priceCart([line], clientId, null, null, null);
    if (plain.suppressed) {
      console.log("    SUPPRESSED: dry run or the write guard. Set them as the usage says.");
      return;
    }
    plainTotal = plain.grandTotal;
    console.log(
      `    subtotal ${money(plain.subTotal)}  discount ${money(plain.discountTotal)}` +
        `  tax ${money(plain.taxTotal)}  total ${money(plain.grandTotal)}  T75 disagrees ${plain.disagrees}`,
    );
  } catch (err) {
    console.log(`    REFUSED: ${err instanceof Error ? err.message : String(err)}`);
    console.log("    The pass itself is refused for this client, so the code cannot be judged here.");
    return;
  }

  console.log("\n--- WITH THE CODE (the counter's own path, priceCartWithPromotion)");
  const { priced, promotion } = await priceCartWithPromotion([line], clientId, null, code);
  console.log(
    `    subtotal ${money(priced.subTotal)}  discount ${money(priced.discountTotal)}` +
      `  tax ${money(priced.taxTotal)}  total ${money(priced.grandTotal)}  T75 disagrees ${priced.disagrees}`,
  );
  console.log(`    promotion: ${JSON.stringify(promotion)}`);
  console.log(
    promotion.applied
      ? `\n    -> HONOURED ON Test: true. The total moved ${money(plainTotal)} -> ${money(priced.grandTotal)}.`
      : promotion.refusal
        ? `\n    -> NOT APPLIED: ${promotion.refusal}`
        : "\n    -> NOTHING KNOWN (suppressed).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
