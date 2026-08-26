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
 *   npm run mindbody:probe-payments -w @ai-manager/core -- --email you@example.com
 *   npm run mindbody:probe-payments -w @ai-manager/core -- --email you@example.com --live
 *
 * --email looks the client up for you; --client <id> names one directly,
 * which is what you need if two records share an email.
 *
 * The charge defaults to the cheapest priced service in the catalog.
 * --service <id> picks a different one, --discount <amount> tries to knock
 * money off it. To charge exactly $1, make a $1 "API test" item in
 * Mindbody and point --service at it; that always works, whereas the
 * discount depends on Mindbody honoring it in item metadata.
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
const EMAIL = argValue("--email");
const SERVICE_ID = argValue("--service");
let CLIENT_ID = argValue("--client");

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
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { ok: res.ok, status: res.status, body };
}

function fail(rung: string, detail: unknown): never {
  console.error(`\nFAILED at ${rung}`);
  console.error(
    typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
  );
  process.exit(1);
}

// --- 1. Merchant account wired up? -----------------------------------

const sites = await call("GET", "/site/sites");
if (!sites.ok) fail("1. GET /site/sites", sites.body);
const site = sites.body?.Sites?.[0] ?? {};
const brands = {
  Visa: site.AcceptsVisa,
  MasterCard: site.AcceptsMasterCard,
  Discover: site.AcceptsDiscover,
  AmericanExpress: site.AcceptsAmericanExpress,
  DirectDebit: site.AcceptsDirectDebit,
};
console.log(`1. Site: ${site.Name} (id ${site.Id})`);
console.log(`   Accepts: ${JSON.stringify(brands)}`);
if (!Object.values(brands).some(Boolean)) {
  fail(
    "1. GET /site/sites",
    "No card brands accepted. There is no merchant account behind this Site ID, so API card processing cannot work. Stop here.",
  );
}

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

// --- 3. Catalog -------------------------------------------------------

const services = await call("GET", "/sale/services?limit=200", { token });
if (!services.ok) fail("3. GET /sale/services", services.body);
const sellable = (services.body?.Services ?? []).filter(
  (s: any) => typeof s.Price === "number" && s.Price > 0,
);
console.log(`3. Catalog: ${sellable.length} priced services readable`);
const cheapest = [...sellable].sort((a, b) => a.Price - b.Price)[0];
const chosen = SERVICE_ID
  ? sellable.find((s: any) => String(s.Id) === SERVICE_ID)
  : cheapest;
if (!chosen) {
  fail("3. GET /sale/services", "No priced service found to build a cart with.");
}
console.log(
  `   Using "${chosen.Name}" (id ${chosen.Id}, $${chosen.Price}) as the probe item`,
);

// --- 4. Custom payment types -----------------------------------------

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
  console.log("   --email you@example.com   (looked up for you), or");
  console.log("   --client <mindbody client id>");
  console.log(
    "   Use someone with a card on file. Your own account is the obvious pick,",
  );
  console.log("   since --live later puts a real charge on it.");
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
const charge = Math.max(0, chosen.Price - DISCOUNT);

function cart(test: boolean) {
  const metadata: Record<string, unknown> = { Id: String(chosen.Id) };
  if (DISCOUNT > 0) metadata["DiscountAmount"] = DISCOUNT;
  return {
    ClientId: String(CLIENT_ID),
    Test: test,
    InStore: true,
    SendEmail: false,
    Items: [{ Item: { Type: "Service", Metadata: metadata }, Quantity: 1 }],
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
  fail("5. POST /sale/checkoutshoppingcart (Test:true)", dry.body);
}
const serverTotal = dry.body?.ShoppingCart?.GrandTotal;
console.log(
  `   Cart validates. Server-computed total: ${
    typeof serverTotal === "number" ? `$${serverTotal}` : "(not reported)"
  }`,
);
if (DISCOUNT > 0 && typeof serverTotal === "number" && serverTotal !== charge) {
  console.log(
    `   NOTE: --discount ${DISCOUNT} did not take. Expected $${charge}, server says $${serverTotal}.`,
  );
}
console.log(
  "   Necessary but NOT sufficient: Test:true may not reach the gateway.",
);

// --- 6. Live charge ---------------------------------------------------

if (!LIVE) {
  console.log(
    "\n6. Skipped. Re-run with --live to put a real charge through and prove the gateway accepts an API-originated sale. Refund it in Mindbody afterwards.",
  );
  process.exit(0);
}

console.log("\n6. LIVE CHARGE. This moves real money:");
console.log(`     client   ${client.FirstName} ${client.LastName} (${CLIENT_ID})`);
console.log(`     card     ending ${card.LastFour}`);
console.log(`     item     ${chosen.Name}`);
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
  process.exit(0);
}

const live = await call("POST", "/sale/checkoutshoppingcart", {
  token,
  body: cart(false),
});
console.log(`   HTTP ${live.status}`);
if (!live.ok) fail("6. POST /sale/checkoutshoppingcart (live)", live.body);
console.log(
  `   SALE COMPLETED. Sale id ${live.body?.ShoppingCart?.Id ?? "(see payload)"}. Refund it in Mindbody.`,
);
console.log(
  "\nAPI credit-card processing is enabled for this Site ID. The POS payment design is unblocked.",
);
