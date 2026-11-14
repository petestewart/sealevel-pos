/**
 * T220: does a Mindbody promotion code move a `Test: true` cart's total,
 * and does pricing one use it up?
 *
 * The counter's promotion code field (CLAUDE.md, T220) shows MINDBODY's
 * discount and total, read off the `Test: true` rehearsal, and charges
 * the total that rehearsal priced. That rests on two things nobody has
 * watched yet:
 *
 *   1. `PromotionCode` on `POST /sale/checkoutshoppingcart` (sale.yml:5684)
 *      is HONOURED under `Test: true`, so the rehearsal's DiscountTotal and
 *      GrandTotal are the coded ones, and SubTotal stays pre-discount (T75
 *      compares it).
 *   2. A `Test: true` pricing does NOT count against `MaxUses: 1`. If it
 *      did, the counter would spend a student's single-use code merely by
 *      showing them the price.
 *
 * So the same one-line cart is priced with no code, then WITH the code
 * TWICE: if the second coded pricing is refused as used, (2) is false.
 *
 * Every pricing here is `Test: true`: nothing is sold.
 *
 * `--create <amountOff>` makes the code first, with `POST
 * /site/addpromocode`, as a THROWAWAY: one use, in-store only
 * (`AllowOnline: false`), for this one pricing option only, active today
 * and expiring tomorrow, named so it reads as safe to delete. On prod that
 * is the only shape it will make, and `--create` refuses a code that
 * already exists on the site rather than touch it. Whatever this script
 * created it DEACTIVATES at the end (`POST /site/deactivatepromocode`),
 * whatever happened in between, and says so. Both calls need the "Set up
 * promotions / Semester discounts" staff permission. The discount type is
 * `Amount`: `GET /site/promocodes` LISTS site 471's own codes as
 * `FlatRate`, but `addpromocode` refuses that spelling ("'FlatRate' is
 * not a valid discount type. Options are: Amount or Percent", Pete's
 * prod run, 2026-11-14).
 *
 * Those two writes name no client, so the write guard (POS_WRITE_CLIENT_IDS)
 * would suppress them; they are sent under the probe's own client id,
 * which the usage below puts in the guard. Dry run still suppresses them.
 *
 * `addpromocode` answers `PromotionID: 0` on prod (Pete's run,
 * 2026-11-14) however real the code is, so the id is always read back
 * from the site's list by code. `--deactivate` deactivates a code the
 * probe made on an earlier run and does nothing else; it refuses any code
 * whose name does not start "T220 probe", so it cannot reach a student's.
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-promo-code.ts <clientId> <code> <optionId> --deactivate
 *
 * Usage, sandbox (dry run is forced off there):
 *
 *   MINDBODY_TARGET=sandbox npx tsx --env-file=.env \
 *     scripts/probe-promo-code.ts <clientId> <code> <pricingOptionId> [--create <amountOff>]
 *
 * prod, against a dummy client in the write guard (a Test cart is still a
 * POST, so dry run and the write guard both suppress it):
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-promo-code.ts <clientId> T220-PROBE-1 581 --create 28
 *
 * What to read: "WITH THE CODE" should show a DiscountTotal equal to the
 * code's amount and a GrandTotal that moved by it, with T75 agreeing; "WITH
 * THE CODE, AGAIN" should say the same. If the first does not move, the
 * counter will say "took nothing off" for every code; if the second is
 * refused as used, pricing spends codes. Either one means the field must
 * not be used at the counter until it is understood.
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

/** The site's codes, as `GET /site/promocodes` lists them (inactive ones
 *  included). Read on the service account. */
async function siteCodes(): Promise<
  { PromotionID?: number; Code?: string; Name?: string; Active?: boolean }[]
> {
  const res = await mindbody<any>(
    "/site/promocodes?request.activeOnly=false&request.limit=200",
  );
  return Array.isArray(res?.PromoCodes) ? res.PromoCodes : [];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [clientId, code, optionRaw] = args;
  const createAt = args.indexOf("--create");
  if (!clientId || !code || !optionRaw) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-promo-code.ts " +
        "<clientId> <code> <pricingOptionId> [--create <amountOff> | --deactivate]",
    );
    process.exit(1);
  }
  const optionId = Number(optionRaw);
  console.log(`\n=== target ${target()}, client ${clientId}, code ${code}, option ${optionId}`);

  if (args.includes("--deactivate")) {
    const found = (await siteCodes()).find((c) => c.Code === code);
    if (!found || typeof found.PromotionID !== "number" || found.PromotionID <= 0) {
      console.log(`\n--- ${code} is not on this site. Nothing to deactivate.`);
      return;
    }
    if (!(found.Name ?? "").startsWith("T220 probe")) {
      console.error(
        `--deactivate refused: ${code} is "${found.Name ?? ""}", not a code this probe made.`,
      );
      process.exit(1);
    }
    await deactivate(code, found.PromotionID, clientId);
    return;
  }

  /** The code this run made, to deactivate at the end. */
  let created: { id: number | null } | null = null;
  if (createAt >= 0) {
    const amount = Number(args[createAt + 1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      console.error("--create needs the dollar amount off, e.g. --create 28");
      process.exit(1);
    }
    if ((await siteCodes()).some((c) => c.Code === code)) {
      console.error(
        `--create refused: ${code} already exists on this site. Pick a new code; ` +
          "this script never changes a code it did not make.",
      );
      process.exit(1);
    }
    console.log(
      `\n--- creating ${code}: $${amount.toFixed(2)} off item ${optionId} only, ` +
        "one use, in store only, expires tomorrow",
    );
    try {
      const made = await mindbody<any>("/site/addpromocode", {
        method: "POST",
        body: {
          Code: code,
          Name: `T220 probe ${code} (safe to delete)`,
          Active: true,
          Discount: { Type: "Amount", Amount: amount },
          ActivationDate: studioDay(0),
          ExpirationDate: studioDay(1),
          MaxUses: 1,
          AllowOnline: false,
          ApplicableItems: [{ Type: "Item", Id: optionId }],
        },
        /* The write guard lets a write through only for a listed client,
         * and this one names none; it is the probe's own, for the probe's
         * client. */
        clientId,
      });
      if (made?.DryRun === true || made?.WriteSuppressed === true) {
        console.log("    SUPPRESSED: dry run or the write guard. Set them as the usage says.");
        return;
      }
      /* The answer's PromotionID is 0 on prod, so a positive one is
       * believed and anything else is read back from the list by code. */
      const answered = made?.PromoCode?.PromotionID;
      const listed = (await siteCodes()).find((c) => c.Code === code)?.PromotionID;
      const id =
        typeof answered === "number" && answered > 0
          ? answered
          : typeof listed === "number" && listed > 0
            ? listed
            : null;
      created = { id };
      console.log(`    created, PromotionID ${id ?? "(not found)"}`);
    } catch (err) {
      console.log(`    REFUSED: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  try {
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

    const verdicts: boolean[] = [];
    for (const label of ["WITH THE CODE", "WITH THE CODE, AGAIN"]) {
      console.log(`\n--- ${label} (the counter's own path, priceCartWithPromotion)`);
      const { priced, promotion } = await priceCartWithPromotion([line], clientId, null, code);
      console.log(
        `    subtotal ${money(priced.subTotal)}  discount ${money(priced.discountTotal)}` +
          `  tax ${money(priced.taxTotal)}  total ${money(priced.grandTotal)}  T75 disagrees ${priced.disagrees}`,
      );
      console.log(`    promotion: ${JSON.stringify(promotion)}`);
      verdicts.push(promotion.applied);
    }

    const [first, second] = verdicts;
    console.log(
      first
        ? `\n    -> 1. HONOURED ON Test: true. The total moved ${money(plainTotal)} -> the coded total above.`
        : "\n    -> 1. NOT APPLIED on the first pricing (see the refusal above).",
    );
    if (first) {
      console.log(
        second
          ? "    -> 2. NOT SPENT BY PRICING. The second Test pricing applied it again."
          : "    -> 2. SPENT BY PRICING? The second Test pricing did not apply it. Read its refusal: " +
              "if it says the code is used up, the counter must not price with a student's code.",
      );
    }
  } finally {
    if (created !== null) {
      if (created.id === null) {
        console.log(`\n--- ${code} could not be found to deactivate. Deactivate it by hand in Mindbody.`);
      } else {
        await deactivate(code, created.id, clientId);
      }
    }
  }
}

/** Deactivate one code by its PromotionID, then read the list back and
 *  say what Mindbody now holds, rather than trusting a 200. */
async function deactivate(code: string, id: number, clientId: string): Promise<void> {
  try {
    const res = await mindbody<any>("/site/deactivatepromocode", {
      method: "POST",
      body: { PromotionId: id },
      clientId,
    });
    if (res?.DryRun === true || res?.WriteSuppressed === true) {
      console.log(`\n--- deactivating ${code} was SUPPRESSED (dry run or the write guard).`);
      return;
    }
    const after = (await siteCodes()).find((c) => c.PromotionID === id);
    console.log(
      `\n--- deactivated ${code} (PromotionID ${id}); the site now lists it ` +
        `Active ${String(after?.Active ?? "(not listed)")}.`,
    );
  } catch (err) {
    console.log(
      `\n--- COULD NOT DEACTIVATE ${code} (PromotionID ${id}): ` +
        `${err instanceof Error ? err.message : String(err)} Deactivate it by hand in Mindbody.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
