/**
 * T256's probe: what is the studio's "ADD CREDIT to ACCOUNT" item, what
 * does the client's balance read, and does `POST
 * /sale/purchaseaccountcredit` with `Test: true` accept each tender the
 * counter will sell credit with, while moving NOTHING?
 *
 * Pete, 2026-11-18: "we need to add the ability to add credit to a
 * student's account. in mindbody we do it by ringing up a sale with the
 * item ADD CREDIT to ACCOUNT." The counter does not ring that product up
 * through a cart (T103: a cart can take money for a special item and sell
 * nothing); it calls purchaseaccountcredit, whose amount rides the
 * payment's Metadata (sale.yml:4774). This asks:
 *
 *   (a) READ: /sale/products and /sale/services at location 1 for anything
 *       named like "credit", so we know what the studio's item is;
 *   (b) READ: the client's balance and card on file, the way the app reads
 *       them (clientPaymentProfile);
 *   (c) ONLY with --test-purchase, which T256 says not to pass (see the
 *       warning in main): `Test: true` purchaseaccountcredit for $1.00 by Cash, by the
 *       card on file (only when there is one and it is current), and by a
 *       typed card (the 4111 test number, which no processor would charge
 *       even if Test were ignored), each followed by a fresh balance read.
 *       If the balance moves after any of them, the probe STOPS there and
 *       says so: Test is not honoured and nothing else may be asked.
 *
 *   (d) `Test: true` ONLY: the studio's own "ADD CREDIT to ACCOUNT" item
 *       (pricing option 325, category 23 "Payments on Account", found by
 *       reading recent sales, since neither /sale/products nor
 *       /sale/services lists it) priced in a CART, alone and beside Boxed
 *       Water, bare and with each Metadata price key we could think of,
 *       to see whether a cart line of it can carry an amount (T256's
 *       route A: credit as an ordinary cart line).
 *
 * Nothing above sends `Test: false`. ONE real call exists, behind an
 * explicit `--real` flag and nothing else, for Pete to run by hand: a
 * real $1.00 CASH `purchaseaccountcredit` on the dummy client, with the
 * balance read before and after, which is the only way to see that a real
 * purchase raises the balance by what it charged. It refuses any client
 * but 100042041.
 *
 *   MINDBODY_TARGET=prod MINDBODY_PROD_SITE_ID=471 POS_DRY_RUN=false \
 *     POS_WRITE_CLIENT_IDS=100042041 \
 *     npx tsx scripts/probe-account-credit.ts 100042041 --real
 *
 *   MINDBODY_TARGET=prod MINDBODY_PROD_SITE_ID=471 POS_DRY_RUN=false \
 *     POS_WRITE_CLIENT_IDS=100042041 \
 *     npx tsx scripts/probe-account-credit.ts 100042041 [--no-typed]
 *
 * Dry run must be off for the Test calls to reach Mindbody at all (the
 * wrapper counts every POST as a write), and the write guard lets exactly
 * this client through. Never run against a real student.
 */
import { mindbody, target } from "../src/lib/mindbody";
import {
  clientPaymentProfile,
  purchaseCredit,
  type CreditTender,
} from "../src/lib/sale";

const AMOUNT = 1.0;

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "(none)" : `$${n.toFixed(2)}`;
}

async function readBalance(clientId: string): Promise<number | null> {
  return (await clientPaymentProfile(clientId)).balance;
}

async function creditLike(): Promise<void> {
  const like = /credit|account/i;
  console.log("\n(a) /sale/products at location 1, names like credit/account:");
  for (const query of ["credit", "account"]) {
    const body = await mindbody(
      `/sale/products?request.searchText=${query}&request.locationId=1&request.limit=200`,
    );
    const rows = (body?.Products ?? []).filter((p: any) =>
      like.test(String(p?.Name ?? "")),
    );
    console.log(`  searchText=${query}: ${rows.length} match(es)`);
    for (const p of rows) {
      console.log(
        "   ",
        JSON.stringify({
          Id: p?.Id,
          ProductId: p?.ProductId,
          Name: p?.Name,
          Price: p?.Price,
          OnlinePrice: p?.OnlinePrice,
          TaxIncluded: p?.TaxIncluded,
          TaxRate: p?.TaxRate,
          CategoryId: p?.CategoryId,
          SecondaryCategoryId: p?.SecondaryCategoryId,
          ShortDescription: p?.ShortDescription,
        }),
      );
    }
  }
  /* The whole list too, in case the search does not reach the name. */
  const all = await mindbody(
    "/sale/products?request.locationId=1&request.limit=200",
  );
  const named = (all?.Products ?? []).filter((p: any) =>
    like.test(String(p?.Name ?? "")),
  );
  console.log(
    `  unfiltered list: ${(all?.Products ?? []).length} product(s), ` +
      `${named.length} named like credit/account: ` +
      named.map((p: any) => `${p?.Id} "${p?.Name}" ${money(p?.Price)}`).join("; "),
  );
  /* T256's run found no such product: the studio's "ADD CREDIT to
   * ACCOUNT" is Mindbody's own account payment item, filed under the
   * system revenue category "Payments on Account", which the categories
   * list shows and /sale/products never serves. */
  console.log("\n(a'') /site/categories named like credit/account:");
  const cats = await mindbody("/site/categories?request.limit=200");
  for (const c of (cats?.Categories ?? []).filter((x: any) =>
    like.test(String(x?.CategoryName ?? "")),
  )) {
    console.log(
      "   ",
      JSON.stringify({
        Id: c?.Id,
        CategoryName: c?.CategoryName,
        Service: c?.Service,
        Active: c?.Active,
      }),
    );
  }
  console.log("\n(a') /sale/services at location 1, names like credit/account:");
  const services = await mindbody(
    "/sale/services?request.locationId=1&request.limit=200",
  );
  const svc = (services?.Services ?? []).filter((s: any) =>
    like.test(String(s?.Name ?? "")),
  );
  console.log(
    `  ${(services?.Services ?? []).length} service(s), ${svc.length} named like ` +
      "credit/account: " +
      svc.map((s: any) => `${s?.Id} "${s?.Name}" ${money(s?.Price)}`).join("; "),
  );
}

/** (d) the ADD CREDIT item in a Test cart. */
async function creditItemInCart(clientId: string): Promise<void> {
  console.log(
    "\n(d) checkoutshoppingcart, Test: true, service 325 (ADD CREDIT to ACCOUNT):",
  );
  const svc = (extra: Record<string, unknown> = {}) => ({
    Item: { Type: "Service", Metadata: { Id: 325, ...extra } },
    Quantity: 1,
  });
  const water = {
    Item: { Type: "Product", Metadata: { Id: "8616119729" } },
    Quantity: 1,
  };
  const shapes: [string, unknown[], number][] = [
    ["alone", [svc()], 0],
    ["alone, Metadata.Price 11", [svc({ Price: 11 })], 11],
    ["alone, Metadata.Amount 11", [svc({ Amount: 11 })], 11],
    ["alone, Metadata.SalePrice 11", [svc({ SalePrice: 11 })], 11],
    ["alone, Metadata.UnitPrice 11", [svc({ UnitPrice: 11 })], 11],
    ["beside Boxed Water", [svc(), water], 4],
    ["Metadata.Price 11 beside Boxed Water", [svc({ Price: 11 }), water], 15],
  ];
  for (const [label, items, amount] of shapes) {
    try {
      const b = await mindbody("/sale/checkoutshoppingcart", {
        method: "POST",
        clientId,
        body: {
          ClientId: clientId,
          Test: true,
          LocationId: 1,
          InStore: true,
          CalculateTax: true,
          Items: items,
          Payments: [{ Type: "Comp", Metadata: { Amount: amount } }],
        },
      });
      const c = b?.ShoppingCart ?? {};
      console.log(
        `  ${label}: SubTotal ${money(c.SubTotal)} Tax ${money(c.TaxTotal)} ` +
          `GrandTotal ${money(c.GrandTotal)} lines ` +
          JSON.stringify(
            (c.CartItems ?? []).map((i: any) => ({
              name: i?.Item?.Name,
              price: i?.Item?.Price,
              online: i?.Item?.OnlinePrice,
              tax: i?.Item?.TaxRate,
              program: i?.Item?.ProgramId,
            })),
          ),
      );
    } catch (err) {
      console.log(
        `  ${label}: REFUSED ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** --real: ONE real $1.00 cash purchase of account credit, dummy client
 *  only, the balance read either side. For Pete to run by hand. */
async function realDollar(clientId: string): Promise<void> {
  if (clientId !== "100042041") {
    console.error("--real runs only against the dummy client 100042041.");
    process.exit(2);
  }
  const before = await readBalance(clientId);
  console.log(`\n(e) --real: a REAL $1.00 cash purchaseaccountcredit. Before ${money(before)}`);
  const out = await purchaseCredit({
    clientId,
    payment: { type: "Cash", amount: 1 },
    test: false,
  });
  const after = await readBalance(clientId);
  console.log(`  answer ${JSON.stringify(out)}`);
  console.log(
    `  balance before ${money(before)}, after ${money(after)}; expected ` +
      `${money(before === null ? null : Math.round((before + 1) * 100) / 100)}`,
  );
}

async function main() {
  const clientId = process.argv[2];
  const typed = !process.argv.includes("--no-typed");
  if (!clientId) {
    console.error("usage: probe-account-credit.ts <clientId> [--no-typed]");
    process.exit(2);
  }
  console.log(`target=${target()} client=${clientId}`);
  await creditLike();

  console.log("\n(b) the client's payment profile (clientPaymentProfile):");
  const profile = await clientPaymentProfile(clientId);
  console.log(
    "  ",
    JSON.stringify({
      balance: profile.balance,
      card: profile.card,
      email: profile.email ? "(on file)" : null,
    }),
  );
  const before = profile.balance;

  const tenders: { label: string; payment: CreditTender }[] = [
    { label: "Cash", payment: { type: "Cash", amount: AMOUNT } },
  ];
  if (profile.card && !profile.card.expired) {
    tenders.push({
      label: `StoredCard ...${profile.card.lastFour}`,
      payment: {
        type: "StoredCard",
        amount: AMOUNT,
        lastFour: profile.card.lastFour,
      },
    });
  } else {
    console.log(
      `  no current card on file (${profile.card ? "expired" : "none"}): StoredCard skipped`,
    );
  }
  if (typed) {
    tenders.push({
      label: "CreditCard 4111...1111 (test number)",
      payment: {
        type: "CreditCard",
        amount: AMOUNT,
        card: {
          number: "4111111111111111",
          expMonth: "12",
          expYear: "2030",
          cvv: "123",
          billingName: "Probe Test",
          postalCode: "98103",
          address: "",
          city: "",
          state: "",
          keep: false,
        },
      },
    });
  }

  /* T256: (c) is OFF unless asked for. On 2026-11-18 identical $1.00
   * Test bodies answered AmountPaid 1 and later 2, and a real $1.00 call
   * then booked TWO $1.00 lines (sale 428932): a Test call may leave a
   * pending line behind. Do not pass this flag until that is settled. */
  const testPurchase = process.argv.includes("--test-purchase");
  console.log(
    testPurchase
      ? `\n(c) purchaseaccountcredit, Test: true, ${money(AMOUNT)} each:`
      : "\n(c) skipped: purchaseaccountcredit, even Test: true, may leave a " +
          "pending line (T256). Pass --test-purchase to run it.",
  );
  for (const t of testPurchase ? tenders : []) {
    let line: string;
    try {
      const out = await purchaseCredit({
        clientId,
        payment: t.payment,
        test: true,
      });
      line = JSON.stringify(out);
    } catch (err) {
      line = `REFUSED: ${err instanceof Error ? err.message : String(err)}`;
    }
    const after = await readBalance(clientId);
    const moved =
      before === null || after === null
        ? "unknown"
        : Math.round(before * 100) === Math.round(after * 100)
          ? "no"
          : "YES";
    console.log(`  ${t.label}: ${line}`);
    console.log(
      `    balance before ${money(before)}, after ${money(after)}, moved: ${moved}`,
    );
    if (moved === "YES") {
      console.error(
        "\nSTOP: the balance moved after a Test: true purchase. Test is not " +
          "honoured on purchaseaccountcredit. Nothing else is asked.",
      );
      process.exit(1);
    }
  }
  await creditItemInCart(clientId);

  if (process.argv.includes("--real")) {
    /* T256: the main session ran this step's equivalent by hand on
     * 2026-11-18 and it booked TWO lines. Do not run it again until the
     * pending-line question is settled. */
    await realDollar(clientId);
    return;
  }
  console.log("\nDone. Nothing was sent with Test: false.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
