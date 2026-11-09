/**
 * Can this studio take Apple Pay through the API at all, and in what shape?
 *
 * Pete, 2026-11-09: "apple pay needs to be an available form of payment".
 *
 * What is already known, from the vendored spec (sale.yml) and the design
 * doc's "Apple Pay is real, and it is not a button at the counter":
 *
 *   - Apple Pay is an ALTERNATIVE payment. It never rides
 *     `checkoutshoppingcart`; it goes through
 *     `POST /sale/initiatecheckoutshoppingcart`, which answers a redirect
 *     URL the CUSTOMER opens on their own device, Mindbody sends them
 *     back to a `PaymentAuthenticationCallbackUrl` of ours, and
 *     `POST /sale/completecheckoutshoppingcart` (with the AccessToken
 *     from the first step) finishes the sale.
 *   - Those endpoints are for studios on Mindbody Payments with Stripe,
 *     and support ONLY the online store location (LocationId 98), so the
 *     sale books at the online store at the ONLINE price.
 *   - `GET /sale/alternativepaymentmethods` is the gate, and the only
 *     time it was ever called (Phase 0 probe) it answered HTTP 400. The
 *     likely cause is the missing `LocationId=98`; nobody has re-run it.
 *   - The spec does not say what a `Payments` entry for Apple Pay looks
 *     like (CheckoutPaymentInfo's Type list stops at Comp), which is the
 *     same hole CLAUDE.md warns about for every `Metadata` field.
 *
 * This probe answers the first two unknowns and, when asked, the third.
 *
 *   1. ALWAYS, read-only: the alternative payment methods at location 98,
 *      at location 1 (expected to refuse, which is worth seeing), and with
 *      no location at all (the call that answered 400 before).
 *   2. WITH `--initiate <clientId> <productId>`: a `Test: true`
 *      `initiatecheckoutshoppingcart` for one retail product at location
 *      98, once per candidate Payments shape, printing Mindbody's whole
 *      answer for each. Test mode validates and commits nothing, so no
 *      sale is made and nothing is charged. It is still a POST, so both
 *      rails must be open (MINDBODY_TARGET=prod, POS_DRY_RUN=false, and
 *      POS_WRITE_CLIENT_IDS naming the client), exactly as for the gift
 *      card probes. Use a test client.
 *
 * Usage:
 *
 *   MINDBODY_TARGET=prod npx tsx --env-file=.env scripts/probe-applepay.ts
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-applepay.ts \
 *     --initiate <clientId> <productId>
 *
 * What the answer decides. If the method list carries Apple Pay, the
 * account can take it, and the build is a QR on the customer screen (or a
 * link the customer opens on their phone) plus a public callback route,
 * which needs the deployed HTTPS address Phase 1.5 has not produced yet.
 * If the list is empty or refused, Apple Pay is not on through the API
 * for this account, and the conversation is with Mindbody, not code. The
 * initiate answers say which Payments shape Mindbody reads and what the
 * redirect looks like, which is everything the build needs before it
 * moves a cent.
 */
import { mindbody } from "../src/lib/mindbody";

const ONLINE_STORE = 98;
const STUDIO = 1;

function show(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Method {
  Id?: number;
  Name?: string;
}

async function listMethods(label: string, query: string): Promise<Method[]> {
  console.log(`\n=== alternative payment methods, ${label}`);
  try {
    const res: any = await mindbody(
      `/sale/alternativepaymentmethods${query}`,
    );
    const list: Method[] = Array.isArray(res?.PaymentMethods)
      ? res.PaymentMethods
      : [];
    if (list.length === 0) {
      console.log("  ANSWERED, with no methods. Whole answer:");
      console.log(show(res));
    }
    for (const m of list) console.log(`  id=${m?.Id}  ${m?.Name ?? ""}`);
    return list;
  } catch (err) {
    console.log(`  REFUSED: ${errText(err)}`);
    return [];
  }
}

async function initiate(
  label: string,
  clientId: string,
  productId: string,
  payment: Record<string, unknown>,
): Promise<void> {
  console.log(`\n  --- ${label}`);
  try {
    const res: any = await mindbody("/sale/initiatecheckoutshoppingcart", {
      method: "POST",
      clientId,
      body: {
        ClientId: clientId,
        Items: [
          {
            Item: { Type: "Product", Metadata: { Id: productId } },
            Quantity: 1,
          },
        ],
        Payments: [payment],
        /* Never visited in Test mode; Mindbody may still validate that
         * it is a URL. The real one is a route of ours on the deployed
         * HTTPS address. */
        PaymentAuthenticationCallbackUrl:
          "https://example.com/sealevel-pos/applepay-probe",
        Test: true,
        InStore: false,
        CalculateTax: true,
        SendEmail: false,
        LocationId: ONLINE_STORE,
      },
    });
    if (res?.DryRun === true || res?.WriteSuppressed === true) {
      console.log(
        "      SUPPRESSED. Mindbody never saw this call. Open both rails\n" +
          "      (POS_DRY_RUN=false, POS_WRITE_CLIENT_IDS=<clientId>) and run\n" +
          "      it again.",
      );
      return;
    }
    console.log("      ACCEPTED. Whole answer:");
    console.log(show(res));
  } catch (err) {
    console.log(`      REFUSED: ${errText(err)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--initiate");
  const clientId = at >= 0 ? args[at + 1] : undefined;
  const productId = at >= 0 ? args[at + 2] : undefined;
  if (at >= 0 && (!clientId || !productId)) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/probe-applepay.ts " +
        "[--initiate <clientId> <productId>]",
    );
    process.exit(1);
  }

  const online = await listMethods(
    `LocationId ${ONLINE_STORE} (the online store)`,
    `?request.locationId=${ONLINE_STORE}${clientId ? `&request.clientId=${clientId}` : ""}`,
  );
  await listMethods(`LocationId ${STUDIO} (the studio)`, `?request.locationId=${STUDIO}`);
  await listMethods("no location (the call that answered 400 in Phase 0)", "");

  const apple = online.find((m) => /apple/i.test(m?.Name ?? "")) ?? null;
  console.log(
    apple
      ? `\nApple Pay IS offered at the online store: id ${apple.Id}, "${apple.Name}".`
      : "\nApple Pay is NOT in the online store's list above.",
  );

  if (at < 0) {
    console.log(
      "\nRead-only run finished. Add --initiate <clientId> <productId> to\n" +
        "rehearse the checkout itself (Test: true, nothing sold).\n",
    );
    return;
  }

  console.log(
    `\n=== Test: true initiatecheckoutshoppingcart, client ${clientId}, ` +
      `product ${productId}, LocationId ${ONLINE_STORE}`,
  );
  console.log("=== Nothing is sold and nothing is charged.");
  /* The spec does not enumerate this payment's Type or Metadata, so each
   * plausible shape is asked once and Mindbody's own answer is printed.
   * The amount is a placeholder: the answer's totals are Mindbody's. */
  const amount = 1;
  const methodId = apple?.Id ?? 801;
  const candidates: [string, Record<string, unknown>][] = [
    [
      `A. Type "ApplePay"`,
      { Type: "ApplePay", Metadata: { Amount: amount } },
    ],
    [
      `B. Type "AlternativePayment", Id ${methodId}`,
      { Type: "AlternativePayment", Metadata: { Amount: amount, Id: methodId } },
    ],
    [
      `C. Type "AlternativePayment", PaymentMethodId ${methodId}`,
      {
        Type: "AlternativePayment",
        Metadata: { Amount: amount, PaymentMethodId: methodId },
      },
    ],
  ];
  if (apple?.Name && apple.Name !== "ApplePay") {
    candidates.push([
      `D. Type "${apple.Name}" (the listed name)`,
      { Type: apple.Name, Metadata: { Amount: amount } },
    ]);
  }
  for (const [label, payment] of candidates) {
    await initiate(label, clientId as string, productId as string, payment);
  }
  console.log(
    "\nNothing above was sold: every call was Test: true.\n" +
      "Paste this whole output back. An ACCEPTED answer names the shape the\n" +
      "build will send and shows whether Test mode hands back a redirect\n" +
      "URL; if all are refused, Mindbody's own sentences say why.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
