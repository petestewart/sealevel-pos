/**
 * Can a restricted pricing option be sold to a client the studio's own
 * business rules exclude, and if so by whom?
 *
 * Pete, 2026-09-17: "we allow someone who just went to their first drop
 * in to buy a 2-week special and use the $29 as credit toward its price.
 * we need to both allow and accommodate that as well." Mindbody refuses
 * that pass today with "Only new clients qualify for this intro series",
 * and his Mindbody business app lets staff do it anyway. Whether the API
 * lets ANY token do it is unknown, and a feature cannot be designed on a
 * guess.
 *
 * Two readings, no writes:
 *
 * 1. The staff member's permission group (`GET /staff/staffpermissions`,
 *    CLAUDE.md: the live response puts `PermissionGroupName`,
 *    `AllowedPermissions` and `DeniedPermissions` at the TOP level, not
 *    under `UserGroup` as the schema says). The four permissions that
 *    could plausibly carry an override are flagged. An explicit DENY
 *    beats everything, which this repo learned the hard way, so denied
 *    ones are called out separately.
 * 2. The cart priced with `Test: true` for that client and that pricing
 *    option, which is what the counter does before it charges. It runs
 *    on the SERVICE ACCOUNT, because that is what `/api/price-cart`
 *    does today; if the refusal turns out to be about permissions rather
 *    than the client, the next step is to re-ask under a teacher's own
 *    token, which needs a route rather than a script.
 *
 * Nothing is sold and nothing is written: a Test cart and a permissions
 * read.
 *
 * Usage, against prod:
 *
 *   MINDBODY_TARGET=prod npx tsx --env-file=.env \
 *     scripts/probe-restricted.ts <clientId> <serviceProductId> [staffId]
 *
 * <clientId> a real client the rule EXCLUDES (someone who has already
 * been to a class), <serviceProductId> the intro pass's ProductId as the
 * shelf knows it, [staffId] a teacher to read permissions for.
 *
 * Do not know the pass's id? Run it with the client id ALONE and it
 * prints every pricing option the shelf sells with its id, then stops.
 * The staff id is optional: leave it off to skip the permission read,
 * or find yours in the dev drawer's Settings tab, where the signed-in
 * teacher is named.
 *
 * POS_DRY_RUN does not matter: dry run suppresses writes and there are
 * none here.
 */
import { mindbody } from "../src/lib/mindbody";
import { priceCart, pricingOptions } from "../src/lib/sale";

/** The permissions that might let a staff member sell past a business
 *  rule. Named here so the output says which ones to look at rather than
 *  printing a hundred rows. */
const INTERESTING = [
  "OverrideAssignedPricing",
  "EditSalePriceCountOnRetailScreen",
  "ApplyCustomDiscountsOnRetailScreen",
  "MakeSales",
  "CreateRetailTickets",
];

async function permissions(staffId: string): Promise<void> {
  console.log(`\n=== permission group for staff ${staffId}\n`);
  try {
    const res = await mindbody<Record<string, unknown>>(
      `/staff/staffpermissions?StaffId=${encodeURIComponent(staffId)}`,
    );
    const allowed = new Set(
      (Array.isArray(res?.["AllowedPermissions"])
        ? res["AllowedPermissions"]
        : []
      ).map(String),
    );
    const denied = new Set(
      (Array.isArray(res?.["DeniedPermissions"])
        ? res["DeniedPermissions"]
        : []
      ).map(String),
    );
    console.log(`  group: ${String(res?.["PermissionGroupName"] ?? "(none named)")}`);
    console.log(`  ${allowed.size} allowed, ${denied.size} denied\n`);
    for (const name of INTERESTING) {
      const state = denied.has(name)
        ? "DENIED (an explicit deny beats everything)"
        : allowed.has(name)
          ? "allowed"
          : "not in either list";
      console.log(`  ${name.padEnd(36)} ${state}`);
    }
  } catch (err) {
    console.log(
      `  FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function rehearse(clientId: string, productId: number): Promise<void> {
  console.log(
    `\n=== pricing the pass ${productId} for client ${clientId},` +
      ` Test: true, on the service account\n`,
  );
  /* The catalog's own entry, so the figures printed are the shelf's. */
  let price = 0;
  let taxRate: number | null = null;
  let name = "(not in the catalog)";
  try {
    const options = await pricingOptions();
    const found = options.find((o) => String(o.id) === String(productId));
    if (found) {
      name = found.name;
      price = found.price;
      taxRate = found.taxRate;
      console.log(`  ${name}, shelf price $${price.toFixed(2)}`);
    } else {
      console.log(`  product ${productId} is not on the shelf; pricing it anyway`);
    }
  } catch (err) {
    console.log(
      `  could not read the catalog: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const priced = await priceCart(
      [
        {
          type: "Service",
          metadataId: productId,
          quantity: 1,
          price,
          taxExempt: taxRate === null,
          taxRate,
        },
      ],
      clientId,
      null,
      null,
    );
    console.log(
      `  ACCEPTED. Mindbody priced it: subtotal ${priced.subTotal}, tax ` +
        `${priced.taxTotal}, total ${priced.grandTotal}.\n` +
        `  So the rule does not block this client and the sale can go ahead.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  REFUSED: ${message}`);
    console.log(
      `\n  That is Mindbody's own sentence. If it names the CLIENT (a rule\n` +
        `  about who qualifies) the pass cannot simply be sold and the\n` +
        `  question becomes whether a teacher's own token is answered\n` +
        `  differently. If it names a PERMISSION, the group above is where\n` +
        `  to look.`,
    );
  }
}

async function main(): Promise<void> {
  const [clientId, productRaw, staffId] = process.argv.slice(2);
  if (!clientId) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-restricted.ts " +
        "<clientId> [serviceProductId] [staffId]",
    );
    process.exit(1);
  }
  const productId = Number(productRaw);
  if (productRaw === undefined || !Number.isInteger(productId)) {
    /* The id is the awkward part of this probe's usage, so with none
     * given it answers the easier question first: what the shelf sells
     * and what each one's id is. A plain read. */
    console.log("\n=== the pricing options the shelf sells\n");
    const options = await pricingOptions();
    for (const o of options) {
      console.log(
        `  id=${String(o.id).padEnd(8)} $${o.price.toFixed(2).padStart(8)}  ${o.name}`,
      );
    }
    console.log(
      `\n  ${options.length} option(s). Run it again with the id of the pass` +
        ` the rule refuses,\n  for example the new student intro.\n`,
    );
    return;
  }
  if (staffId) await permissions(staffId);
  await rehearse(clientId, productId);
  console.log("\nReads only: nothing was sold and nothing was changed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
