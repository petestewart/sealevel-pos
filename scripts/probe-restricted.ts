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
 *    does today.
 * 3. T112: THE SAME CART AGAIN, under a TEACHER'S OWN TOKEN. Pete asked
 *    for an Override button on the refused line ("teacher PIN and reason
 *    can be given"), and whether a teacher's token is answered
 *    differently is the whole question that decides what such a button
 *    can honestly do. Since T49 a checkout write already runs under the
 *    signed-in teacher's token while the rehearsal runs on the service
 *    account, so the two answers below are exactly the two halves of a
 *    real sale, asked side by side. The token comes from one
 *    `/usertoken/issue` with that teacher's own Mindbody login
 *    (signInAsStaff, the same call the counter's sign-in makes) and is
 *    revoked again at the end; the password is read from the environment
 *    rather than argv, so it stays out of shell history, and neither the
 *    password nor the token is ever printed.
 *
 * Nothing is sold and nothing is written: two Test carts and a
 * permissions read.
 *
 * Usage, against prod:
 *
 *   MINDBODY_TARGET=prod npx tsx --env-file=.env \
 *     scripts/probe-restricted.ts <clientId> <serviceProductId> [staffId]
 *
 * To ask the teacher's-token half too, set the teacher's own Mindbody
 * login in the environment first:
 *
 *   POS_PROBE_STAFF_USER=<their Mindbody username> \
 *   POS_PROBE_STAFF_PASS=<their password> \
 *   MINDBODY_TARGET=prod npx tsx --env-file=.env \
 *     scripts/probe-restricted.ts <clientId> <serviceProductId> [staffId]
 *
 * With those unset the probe prints the service-account answer alone and
 * says what is still unasked.
 *
 * 4. T112: the SUBSTITUTE pass, asked the same two ways. Pete's fallback
 *    for a pass no token can sell: "if that doesn't work then we can use
 *    the 'Returning Student 2-week unlimited' item and discount it to be
 *    at the standard 2-week special price behind the scenes". On site 471
 *    that is pass 555, "Returning Student 2-wk Unlimited (1+ Years
 *    Away)", $79.00, to be sold at the intro's $59.00. Its name says it
 *    may carry an eligibility rule of its own, and if it does the
 *    fallback fails for exactly the same reason as the thing it is meant
 *    to rescue, so it is not shipped as an offer on a guess. Pass the
 *    substitute's id as the FOURTH argument to ask about it:
 *
 *      MINDBODY_TARGET=prod npx tsx --env-file=.env \
 *        scripts/probe-restricted.ts <clientId> 414 <staffId> 555
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
import { mindbody, revokeStaffToken, signInAsStaff, type Actor } from "../src/lib/mindbody";
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

/** The one line this probe prices, built from the shelf's own entry so
 *  the figures are the counter's. Read once and asked twice, because the
 *  two answers are only comparable if the cart is identical. */
async function passLine(productId: number): Promise<{
  line: {
    type: "Service";
    metadataId: number;
    quantity: number;
    price: number;
    taxExempt: boolean;
    taxRate: number | null;
  };
  name: string;
}> {
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
      console.log(`\n  ${name}, shelf price $${price.toFixed(2)}`);
    } else {
      console.log(`\n  product ${productId} is not on the shelf; pricing it anyway`);
    }
  } catch (err) {
    console.log(
      `\n  could not read the catalog: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    line: {
      type: "Service",
      metadataId: productId,
      quantity: 1,
      price,
      taxExempt: taxRate === null,
      taxRate,
    },
    name,
  };
}

/**
 * Price that one line for that client, `Test: true`, as whoever `actor`
 * names (null is the service account). Returns what Mindbody said so
 * main() can compare the two answers rather than leaving a human to read
 * two paragraphs and decide.
 */
async function rehearse(
  clientId: string,
  line: Awaited<ReturnType<typeof passLine>>["line"],
  actor: Actor | null,
): Promise<{ accepted: boolean; message: string }> {
  console.log(
    `\n=== pricing the pass ${line.metadataId} for client ${clientId},` +
      ` Test: true, ` +
      (actor === null
        ? "on the SERVICE ACCOUNT\n"
        : `under the TEACHER'S OWN TOKEN (${actor.name}, staff ${actor.staffId})\n`),
  );
  try {
    const priced = await priceCart([line], clientId, actor, null);
    console.log(
      `  ACCEPTED. Mindbody priced it: subtotal ${priced.subTotal}, tax ` +
        `${priced.taxTotal}, total ${priced.grandTotal}.`,
    );
    return { accepted: true, message: "accepted" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  REFUSED: ${message}`);
    return { accepted: false, message };
  }
}

/**
 * T112 review: the teacher's token, held here so it is revoked whether
 * the probe finishes or throws. A token left live because a read failed
 * half way through is a credential this script created and did not clean
 * up, on the one run that goes against the live studio. It is never
 * printed, here or anywhere.
 */
let issuedToken: string | null = null;

async function revokeIssued(): Promise<void> {
  if (issuedToken === null) return;
  const token = issuedToken;
  issuedToken = null;
  await revokeStaffToken(token);
  console.log("\n  the teacher's token was revoked.");
}

/** T112: a teacher's own token, from one `/usertoken/issue` with their
 *  Mindbody login out of the environment. Null when no login is set, or
 *  when Mindbody refused it (which is its own finding, and not the
 *  question this probe is asking). The token is never printed. */
async function teacherActor(): Promise<
  { actor: Actor; token: string } | null
> {
  const user = (process.env.POS_PROBE_STAFF_USER ?? "").trim();
  const pass = process.env.POS_PROBE_STAFF_PASS ?? "";
  if (!user || !pass) return null;
  console.log(`\n=== signing in as ${user} to get their own token\n`);
  const signed = await signInAsStaff(user, pass);
  if (!signed.ok) {
    console.log(
      `  Mindbody refused that login (HTTP ${signed.status}). The` +
        ` teacher's-token half cannot be asked.`,
    );
    return null;
  }
  issuedToken = signed.token;
  const name = `${signed.user.firstName} ${signed.user.lastName}`.trim();
  console.log(
    `  signed in: ${name || "(unnamed)"}, staff id ${signed.user.id},` +
      ` type ${signed.user.type || "(none)"}`,
  );
  return {
    actor: { token: signed.token, staffId: signed.user.id, name },
    token: signed.token,
  };
}

async function main(): Promise<void> {
  const [clientId, productRaw, staffId, substituteRaw] = process.argv.slice(2);
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
  const { line } = await passLine(productId);
  const asStudio = await rehearse(clientId, line, null);
  const teacher = await teacherActor();
  if (teacher === null) {
    console.log(
      `\n=== the teacher's own token was NOT asked\n` +
        `  Set POS_PROBE_STAFF_USER and POS_PROBE_STAFF_PASS to a teacher's\n` +
        `  own Mindbody login and run this again. Until that half is\n` +
        `  answered, whether an Override can do anything at all is unknown,\n` +
        `  and T112's button reports whatever Mindbody says rather than\n` +
        `  promising an outcome.`,
    );
  } else {
    const asTeacher = await rehearse(clientId, line, teacher.actor);
    console.log(`\n=== the answer\n`);
    if (!asStudio.accepted && asTeacher.accepted) {
      console.log(
        `  THE TEACHER'S TOKEN GETS THROUGH and the service account does\n` +
          `  not. An Override can really sell this pass: rehearse and charge\n` +
          `  the overridden line under the teacher's token (T112 does).`,
      );
    } else if (!asStudio.accepted && !asTeacher.accepted) {
      console.log(
        `  BOTH TOKENS ARE REFUSED, in these words:\n` +
          `    service account: ${asStudio.message}\n` +
          `    teacher's token: ${asTeacher.message}\n` +
          `  So this is a rule no token escapes through the API. T112's\n` +
          `  Override still attempts it and reports Mindbody's sentence; it\n` +
          `  must never imply the teacher did something wrong, and the way\n` +
          `  through is the client's record in Mindbody or a gift card.`,
      );
    } else if (asStudio.accepted && asTeacher.accepted) {
      console.log(
        `  BOTH ACCEPTED: this client and this pass are not refused at all\n` +
          `  right now, so this run says nothing about the rule. Pick a\n` +
          `  client the rule really excludes.`,
      );
    } else {
      console.log(
        `  THE SERVICE ACCOUNT GETS THROUGH AND THE TEACHER DOES NOT:\n` +
          `    teacher's token: ${asTeacher.message}\n` +
          `  That is a permission gap in the teacher's group, not the intro\n` +
          `  rule, and T49's fallback is what already covers it.`,
      );
    }
  }
  /* T112: the substitute, asked the same two ways and reported on its
   * own terms. A substitute the same rule refuses is not a fallback. */
  const substituteId = Number(substituteRaw);
  if (substituteRaw !== undefined && Number.isInteger(substituteId)) {
    console.log(
      `\n=== the SUBSTITUTE pass ${substituteId}, for the same client\n`,
    );
    const { line: subLine } = await passLine(substituteId);
    const subStudio = await rehearse(clientId, subLine, null);
    const subTeacher =
      teacher === null ? null : await rehearse(clientId, subLine, teacher.actor);
    console.log(`\n=== the substitute's answer\n`);
    if (subStudio.accepted || subTeacher?.accepted === true) {
      console.log(
        `  THE SUBSTITUTE PRICES for this client` +
          `${subStudio.accepted ? " on the service account" : " under the teacher's token only"}.\n` +
          `  So Pete's fallback works: map ${productRaw} -> ${substituteId} in the\n` +
          `  drawer's shelf tab with "match the refused pass's price" on, and\n` +
          `  the counter sells the two weeks for the intro's money.`,
      );
    } else {
      console.log(
        `  THE SUBSTITUTE IS REFUSED TOO:\n` +
          `    service account: ${subStudio.message}\n` +
          (subTeacher === null
            ? "    teacher's token: not asked\n"
            : `    teacher's token: ${subTeacher.message}\n`) +
          `  Then it carries an eligibility rule of its own and this\n` +
          `  fallback cannot work for this client. Do not configure the\n` +
          `  mapping: the Override would offer a sale that fails.`,
      );
    }
  }
  await revokeIssued();
  console.log("\nReads only: nothing was sold and nothing was changed.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  /* T112 review: and on the way out either way, so a throw between the
   * sign-in and the end does not leave the teacher's token live. */
  .finally(() => revokeIssued().catch(() => {}));
