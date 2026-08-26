import { createInterface } from "node:readline/promises";

import { loadEnv } from "../env.js";

/**
 * The POS pre-flight: does this Site ID actually allow credit-card
 * processing through the Public API?
 *
 * Credentials live on the Railway worker service, so either use the
 * Railway CLI (`railway link`, then `railway run <cmd>`) or copy the four
 * MINDBODY_* variables into a local .env, which is gitignored.
 *
 *   npm run mindbody:probe-payments -w @ai-manager/core
 *   npm run mindbody:probe-payments -w @ai-manager/core -- you@example.com
 *   npm run mindbody:probe-payments -w @ai-manager/core -- you@example.com --live
 *
 * The email looks the client up for you and can be passed bare, as above
 * (npm swallows a literal --email, since npm has an email config of its
 * own; --client-email works too). --client <id> names one directly, which
 * is what you need if two records share an email.
 *
 * The charge defaults to the cheapest priced thing in the catalog, across
 * both services and retail products. At this studio that lands around a
 * dollar on its own (parking token $1, Liquid IV $1.81, boxed water $2,
 * towel rental $2.72), so there is rarely any need to reach for
 * --discount. --service <id> picks a specific item; the probe prints the
 * cheapest five with their ids so you can.
 *
 * "Card not present enabled" in the payments.mindbody.io portal is not
 * literally the same entitlement as "API card processing enabled for this
 * Site ID", and the only way to be sure is to ask the API. This walks the
 * ladder from free to definitive and stops at the first rung that fails:
 *
 *   1. GET /site/sites            -- is a merchant account wired up at all?
 *   2. POST /usertoken/issue      -- do the staff credentials work?
 *   3. GET /sale/services         -- can we read the catalog (needs token)?
 *   4. GET /sale/alternativepaymentmethods -- any custom payment types?
 *   5. POST /sale/checkoutshoppingcart with Test:true -- does a StoredCard
 *      cart VALIDATE? No money moves.
 *   6. --live only: the same cart with Test:false. Money moves.
 *
 * Rung 5 is the important free one, but note its limit: Test:true
 * validates cart contents and may not reach the payment gateway at all,
 * so a pass there is necessary, not sufficient. Only rung 6 proves the
 * gateway will accept an API-originated charge. Run 6 once, on a real
 * client with a card on file (use your own account), then refund it in
 * Mindbody.
 *
 * Nothing here is destructive without --live, and --live prints the client,
 * card, item and amount and waits for you to type "charge" before it moves
 * any money. No PII is printed beyond a name and a card's last four.
 */
loadEnv();

const LIVE = process.argv.includes("--live");
const SERVICE_ID = argValue("--service");
let CLIENT_ID = argValue("--client");

/**
 * `--email` cannot be relied on: npm has its own `email` config, so
 * `npm run ... -- --email you@x` is swallowed by npm and never reaches
 * here (the value arrives as a bare positional instead). So take the
 * email from --client-email, from --email if it did survive, or from any
 * bare argument that looks like an address.
 */
const EMAIL =
  argValue("--client-email") ??
  argValue("--email") ??
  process.argv.slice(2).find((a) => !a.startsWith("-") && a.includes("@"));

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const apiKey = process.env["MINDBODY_API_KEY"] ?? "";
const siteId = process.env["MINDBODY_SITE_ID"] ?? "";
const username = process.env["MINDBODY_STAFF_USERNAME"] ?? "";
const password = process.env["MINDBODY_STAFF_PASSWORD"] ?? "";
const baseUrl =
  process.env["MINDBODY_API_BASE_URL"] ||
  "https://api.mindbodyonline.com/public/v6";

if (!apiKey || !siteId) {
  console.error(
    "Set MINDBODY_API_KEY and MINDBODY_SITE_ID (and the staff credentials) in .env first.",
  );
  process.exit(1);
}

const VERBOSE = process.argv.includes("--verbose");

/** Long API error bodies (HTML error pages especially) get truncated. */
function render(detail: unknown, limit = 2000): string {
  const text =
    typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
  return text.length > limit
    ? `${text.slice(0, limit)}\n   ... [${text.length - limit} more chars, re-run with --verbose]`
    : text;
}

async function call(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; body: any }> {
  const headers: Record<string, string> = {
    "Api-Key": apiKey,
    SiteId: siteId,
    "content-type": "application/json",
  };
  if (opts.token) headers["Authorization"] = opts.token;
  if (VERBOSE && opts.body) {
    console.log(`   > ${method} ${path}\n${render(opts.body)}`);
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const why =
      err instanceof Error && err.name === "TimeoutError"
        ? "no response within 30s"
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`   ${method} ${path} -> network error after ${Date.now() - started}ms: ${why}`);
    throw err;
  }
  const ms = Date.now() - started;
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  console.log(`   ${method} ${path} -> ${res.status} in ${ms}ms`);
  if (VERBOSE) console.log(`   < ${render(body, 4000)}`);
  return { ok: res.ok, status: res.status, body };
}

function fail(rung: string, detail: unknown): never {
  console.error(`\nFAILED at ${rung}`);
  console.error(VERBOSE ? render(detail, 100_000) : render(detail));
  console.error(
    "\nRungs passed before this: " +
      (passed.length ? passed.join(", ") : "none"),
  );
  process.exit(1);
}

/** Rungs cleared so far, so a failure says how far it got. */
const passed: string[] = [];

console.log("Mindbody payments probe");
console.log(`  base url   ${baseUrl}`);
console.log(`  site id    ${siteId}`);
console.log(`  api key    ...${apiKey.slice(-4)}`);
console.log(`  staff user ${username || "(none set)"}`);
console.log(
  `  mode       ${LIVE ? "LIVE (rung 6 will ask before charging)" : "read-only (no money moves)"}`,
);
console.log("");

// --- 1. Merchant account wired up? -----------------------------------

const sites = await call("GET", "/site/sites");
if (!sites.ok) fail("1. GET /site/sites", sites.body);
const allSites: any[] = sites.body?.Sites ?? [];
console.log(
  `1. /site/sites returned ${allSites.length}: ${allSites
    .map((s) => `${s.Name} (${s.Id})`)
    .join(", ")}`,
);

/**
 * Pick the site the credentials are actually configured for, not
 * Sites[0]. The list can include Mindbody's sandbox (id -99, "LastSpot"),
 * and reading the first entry silently reports on the wrong studio.
 */
const site = allSites.find((s) => String(s.Id) === String(siteId));
if (!site) {
  fail(
    "1. GET /site/sites",
    `MINDBODY_SITE_ID is ${siteId}, but the API key only reaches: ${allSites
      .map((s) => `${s.Id}`)
      .join(", ")}. Either the Site ID or the API key is wrong for this studio.`,
  );
}
const brands: Record<string, unknown> = {
  Visa: site.AcceptsVisa,
  MasterCard: site.AcceptsMasterCard,
  Discover: site.AcceptsDiscover,
  AmericanExpress: site.AcceptsAmericanExpress,
  DirectDebit: site.AcceptsDirectDebit,
};
console.log(`   Site ${siteId}: ${site.Name}`);
console.log(`   Accepts: ${JSON.stringify(brands)}`);

/**
 * null means "not reported", which is not the same as false. Only an
 * explicit false on every card brand proves there is no merchant account;
 * nulls are inconclusive and must not stop the probe, since the later
 * rungs answer the question far more directly anyway.
 */
const brandValues = Object.values(brands);
if (brandValues.every((v) => v === false)) {
  fail(
    "1. GET /site/sites",
    "Every card brand is explicitly false. There is no merchant account behind this Site ID, so API card processing cannot work. Stop here.",
  );
}
if (!brandValues.some((v) => v === true)) {
  console.log(
    "   Inconclusive (no brand reported true, none explicitly false). Continuing: the checkout rungs answer this directly.",
  );
}

passed.push("1 site");

// --- 2. Staff token ---------------------------------------------------

if (!username || !password) {
  fail(
    "2. POST /usertoken/issue",
    "No staff credentials set. Sales and check-ins both require a staff user token; set MINDBODY_STAFF_USERNAME / MINDBODY_STAFF_PASSWORD.",
  );
}
const tokenRes = await call("POST", "/usertoken/issue", {
  body: { Username: username, Password: password },
});
if (!tokenRes.ok || !tokenRes.body?.AccessToken) {
  fail("2. POST /usertoken/issue", tokenRes.body);
}
const token: string = tokenRes.body.AccessToken;
console.log(`2. Staff token issued for ${tokenRes.body?.User?.Id ?? "?"}`);
passed.push("2 staff token");

// --- 3. Catalog -------------------------------------------------------

/**
 * Both halves of the catalog, because the cheap things at this studio are
 * retail products and rentals (towel $2.72, boxed water $2, Liquid IV
 * $1.81, parking token $1), not pricing options. Services alone would
 * make the smallest possible live charge a class pass.
 */
const services = await call("GET", "/sale/services?limit=200", { token });
if (!services.ok) fail("3. GET /sale/services", services.body);
const products = await call("GET", "/sale/products?limit=200", { token });
if (!products.ok) fail("3. GET /sale/products", products.body);

interface Sellable {
  type: "Service" | "Product";
  id: string;
  name: string;
  price: number;
}
const priced = (rows: any[], type: "Service" | "Product"): Sellable[] =>
  (rows ?? [])
    .filter((r) => typeof r.Price === "number" && r.Price > 0)
    .map((r) => ({
      type,
      id: String(r.Id ?? r.ProductId),
      name: String(r.Name ?? "(unnamed)"),
      price: r.Price,
    }));

const catalog = [
  ...priced(services.body?.Services, "Service"),
  ...priced(products.body?.Products, "Product"),
].sort((a, b) => a.price - b.price);

console.log(
  `3. Catalog: ${catalog.length} priced items readable ` +
    `(${catalog.filter((c) => c.type === "Service").length} services, ` +
    `${catalog.filter((c) => c.type === "Product").length} products)`,
);
if (catalog.length === 0) {
  fail("3. catalog", "Nothing priced to build a cart with.");
}
console.log(
  `   Cheapest five: ${catalog
    .slice(0, 5)
    .map((c) => `${c.name} $${c.price} (${c.type} ${c.id})`)
    .join(", ")}`,
);

const chosen = SERVICE_ID
  ? catalog.find((c) => c.id === SERVICE_ID)
  : catalog[0];
if (!chosen) {
  fail("3. catalog", `No priced item with id ${SERVICE_ID}.`);
}
console.log(
  `   Using "${chosen.name}" (${chosen.type} ${chosen.id}, $${chosen.price}) as the probe item`,
);

// --- 4. Custom payment types -----------------------------------------

passed.push("3 catalog");
const alt = await call("GET", "/sale/alternativepaymentmethods", { token });
console.log(
  `4. Custom payment methods: ${
    alt.ok
      ? JSON.stringify(
          (alt.body?.AlternativePaymentMethods ?? []).map((m: any) => m.Name),
        )
      : `unavailable (HTTP ${alt.status})`
  }`,
);

// --- 5. Test-mode checkout -------------------------------------------

if (!CLIENT_ID && EMAIL) {
  const found = await call(
    "GET",
    `/client/clients?searchText=${encodeURIComponent(EMAIL)}`,
    { token },
  );
  if (!found.ok) fail("5. GET /client/clients (by email)", found.body);
  const matches = (found.body?.Clients ?? []).filter(
    (c: any) => String(c.Email ?? "").toLowerCase() === EMAIL.toLowerCase(),
  );
  if (matches.length === 0) {
    fail("5. lookup", `No client found with email ${EMAIL}`);
  }
  if (matches.length > 1) {
    console.log(
      `5. ${matches.length} clients share that email: ${matches
        .map((c: any) => `${c.Id} (${c.FirstName} ${c.LastName})`)
        .join(", ")}`,
    );
    fail("5. lookup", "Ambiguous. Re-run with --client <id> naming one of them.");
  }
  CLIENT_ID = String(matches[0].Id);
  console.log(
    `5. Resolved ${EMAIL} to client ${CLIENT_ID} (${matches[0].FirstName} ${matches[0].LastName})`,
  );
}

if (!CLIENT_ID) {
  console.log(
    "\n5. Skipped: name a client to validate a StoredCard cart against.",
  );
  console.log("   you@example.com          (bare, looked up for you), or");
  console.log("   --client <mindbody client id>");
  console.log(
    "   Use someone with a card on file. Your own account is the obvious pick,",
  );
  console.log("   since --live later puts a real charge on it.");
  console.log(`\nRungs passed: ${passed.join(", ")}`);
  process.exit(0);
}

const clientRes = await call(
  "GET",
  `/client/clients?clientIds=${encodeURIComponent(CLIENT_ID)}`,
  { token },
);
if (!clientRes.ok) fail("5. GET /client/clients", clientRes.body);
const client = clientRes.body?.Clients?.[0];
if (!client) fail("5. GET /client/clients", `No client with Id ${CLIENT_ID}`);
const card = client.ClientCreditCard;
if (!card?.LastFour) {
  fail(
    "5. stored card",
    `Client ${CLIENT_ID} has no card on file, so the StoredCard path cannot be tested with them. Pick a client who does.`,
  );
}
passed.push("4 payment methods");
console.log(`5. Client ${CLIENT_ID} has a card on file ending ${card.LastFour}`);

/**
 * The item price is whatever Mindbody has configured; the v6 request-side
 * CheckoutItem carries only Type and Metadata, with no documented price
 * override. `DiscountAmount` appears on the RESPONSE cart item, and the
 * item metadata may or may not honor it on the way in, so --discount is
 * offered but never assumed: the amount we print for confirmation is
 * always the total the SERVER came back with on the Test run, not one we
 * computed. If the discount is ignored, you will see that before paying.
 *
 * To charge exactly $1, the reliable route is a $1 item in Mindbody
 * ("API test", not sold at the desk) passed with --service <id>.
 */
const DISCOUNT = Number(argValue("--discount") ?? 0);
const item: Sellable = chosen;
const charge = Math.max(0, item.price - DISCOUNT);

function cart(test: boolean) {
  const metadata: Record<string, unknown> = { Id: item.id };
  if (DISCOUNT > 0) metadata["DiscountAmount"] = DISCOUNT;
  return {
    ClientId: String(CLIENT_ID),
    Test: test,
    InStore: true,
    SendEmail: false,
    Items: [{ Item: { Type: item.type, Metadata: metadata }, Quantity: 1 }],
    Payments: [
      {
        Type: "StoredCard",
        Metadata: { Amount: charge, LastFour: card.LastFour },
      },
    ],
  };
}

const dry = await call("POST", "/sale/checkoutshoppingcart", {
  token,
  body: cart(true),
});
console.log(`   Test-mode checkout: HTTP ${dry.status}`);
if (!dry.ok) {
  /**
   * A permission rejection is good news wearing a bad hat: the request
   * shape and the entitlement are fine, the staff account just is not
   * allowed to do it. Say so, rather than letting it read as "the API
   * cannot do sales".
   */
  const message = String(dry.body?.Error?.Message ?? "");
  if (/permission/i.test(message)) {
    console.error(`\n   Mindbody says: ${message}`);
    console.error(
      "   Two very different causes look identical here, so distinguishing them:",
    );

    /**
     * Same cart, paid with Cash instead of StoredCard, still in Test
     * mode. Cash needs only the general sales permissions; StoredCard
     * additionally needs UseStoredCreditCards, which lives with the
     * credit-card permissions rather than the retail ones and so is the
     * one most often missed. Which of the two fails tells us which
     * permission family is actually blocking.
     *
     * (The old Siteowner trick -- issuing an owner token with the API key
     * as the password -- is legacy and returns 403 "Staff identity
     * authentication failed" on this site, so it is not used.)
     */
    const asCash = await call("POST", "/sale/checkoutshoppingcart", {
      token,
      body: { ...cart(true), Payments: [{ Type: "Cash", Metadata: { Amount: charge } }] },
    });
    if (asCash.ok) {
      console.error(
        "\n   DIAGNOSIS: the same cart validates when paid with CASH.\n" +
          "   So the account can ring a sale, and what it cannot do is charge a\n" +
          "   stored card. The missing permission is UseStoredCreditCards, which\n" +
          "   is filed with the credit-card permissions, NOT the retail/sales ones.\n" +
          "   That is why working through everything sales-shaped did not find it.",
      );
    } else {
      const cashMessage = String(asCash.body?.Error?.Message ?? "");
      console.error(
        `\n   DIAGNOSIS: cash fails too (${cashMessage || asCash.status}).\n` +
          "   So this is not about stored cards; the account cannot ring any sale.\n" +
          "   Look for MakeSales and CreateRetailTickets, and check that the staff\n" +
          "   member's permission GROUP (not just individual toggles) allows sales,\n" +
          "   and that they are assigned to the Fremont location. If everything is\n" +
          "   granted and it still fails, the API key itself likely lacks scope for\n" +
          "   sale endpoints, which is a request to Mindbody rather than a studio\n" +
          "   setting.",
      );
    }
  }
  fail("5. POST /sale/checkoutshoppingcart (Test:true)", dry.body);
}
const serverCart = dry.body?.ShoppingCart;
const serverTotal = serverCart?.GrandTotal;
console.log(
  `   Cart validates. Server-computed total: ${
    typeof serverTotal === "number" ? `$${serverTotal}` : "(not reported)"
  }`,
);
for (const line of serverCart?.CartItems ?? []) {
  console.log(
    `     line: ${line?.Item?.Name ?? "(unnamed)"} x${line?.Quantity ?? "?"}` +
      `${line?.DiscountAmount ? ` less $${line.DiscountAmount}` : ""}`,
  );
}
if (serverCart && typeof serverTotal !== "number") {
  console.log(
    "     (no GrandTotal in the response; re-run with --verbose to see the full cart)",
  );
}
if (DISCOUNT > 0 && typeof serverTotal === "number" && serverTotal !== charge) {
  console.log(
    `   NOTE: --discount ${DISCOUNT} did not take. Expected $${charge}, server says $${serverTotal}.`,
  );
}
console.log(
  "   Necessary but NOT sufficient: Test:true may not reach the gateway.",
);
passed.push("5 cart validates");

// --- 6. Live charge ---------------------------------------------------

if (!LIVE) {
  console.log(
    "\n6. Skipped. Re-run with --live to put a real charge through and prove the gateway accepts an API-originated sale. Refund it in Mindbody afterwards.",
  );
  console.log(`\nRungs passed: ${passed.join(", ")}`);
  process.exit(0);
}

console.log("\n6. LIVE CHARGE. This moves real money:");
console.log(`     client   ${client.FirstName} ${client.LastName} (${CLIENT_ID})`);
console.log(`     card     ending ${card.LastFour}`);
console.log(`     item     ${chosen.name} (${chosen.type} ${chosen.id})`);
console.log(
  `     amount   ${
    typeof serverTotal === "number"
      ? `$${serverTotal} (as the server priced it on the Test run)`
      : `$${charge} (server did not report a total; this is our figure)`
  }`,
);
console.log("   Refundable in Mindbody afterwards.");

if (!process.stdin.isTTY) {
  fail(
    "6. confirmation",
    "Not an interactive terminal, so the charge cannot be confirmed. Run this from a real shell.",
  );
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question("\n   Type 'charge' to proceed: ")).trim();
rl.close();
if (answer !== "charge") {
  console.log("   Aborted. Nothing was charged.");
  console.log(`\nRungs passed: ${passed.join(", ")}`);
  process.exit(0);
}

const live = await call("POST", "/sale/checkoutshoppingcart", {
  token,
  body: cart(false),
});
if (!live.ok) fail("6. POST /sale/checkoutshoppingcart (live)", live.body);
passed.push("6 live charge");
const soldCart = live.body?.ShoppingCart;
console.log(`   SALE COMPLETED.`);
console.log(`     sale id  ${soldCart?.Id ?? "(not in response)"}`);
console.log(`     charged  $${soldCart?.GrandTotal ?? charge}`);
for (const p of soldCart?.Payments ?? []) {
  console.log(`     payment  ${p?.Type ?? "?"} $${p?.Amount ?? "?"}`);
}
console.log("   Refund it in Mindbody.");
console.log(`\nRungs passed: ${passed.join(", ")}`);
console.log(
  "API credit-card processing is enabled for this Site ID. The POS payment design is unblocked.",
);
