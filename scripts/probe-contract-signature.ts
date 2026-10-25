/**
 * Probe D-B2 (docs/PLAN.md, Phase 2.5): does
 * `POST /sale/purchasecontract` ACCEPT `ClientSignature`, and does the
 * field change the rehearsed Total?
 *
 * T205 sends the customer's signature, captured on the customer display,
 * as `ClientSignature` on the LIVE purchase: a Base64 PNG that Mindbody
 * files under the client's documents as
 * `clientContractSignature-{clientContractId}-{name}-{startDate}.{ext}`
 * (docs/mindbody-openapi/sale.yml:6246). Two things about that are worth
 * knowing before a real card is charged:
 *
 * 1. that a request carrying the field is accepted at all (an unknown or
 *    malformed field could refuse the whole purchase), and
 * 2. that it does not move the money. The counter shows the figure the
 *    `Test: true` rehearsal priced, and that rehearsal deliberately
 *    carries NO signature (src/lib/sale.ts, purchaseContract). If the
 *    field changed the Total, the screen would be showing one number and
 *    the card would take another.
 *
 * So this runs the SAME rehearsal twice, without the field and with it,
 * and prints both answers and whether the Totals agree to the cent.
 *
 * It does NOT commit anything: both calls are `Test: true`, which
 * "validates input information, but does not commit it"
 * (sale.yml:6219). It still reaches the sandbox, so it runs against the
 * SANDBOX and against a client id given on the command line, and under
 * dry run it prints the suppression instead (itself a check of the
 * guard). The PNG is generated here, 8x8 pixels, so the probe carries no
 * fixture.
 *
 * Usage, against the sandbox:
 *
 *   MINDBODY_TARGET=sandbox POS_DRY_RUN=false \
 *     npx tsx --env-file=.env scripts/probe-contract-signature.ts \
 *     [clientId] [contractId]
 *
 * With no arguments it finds both itself: it lists the sandbox's
 * contracts (`GET /sale/contracts`, the read the counter's contract list
 * makes) and takes the first, and it walks the sandbox's clients looking
 * for one with a stored card, because a contract rehearsal prices
 * against `StoredCardInfo {LastFour}` and a client with no card cannot
 * rehearse. The card's last four are read from the client record, never
 * typed. A production client id does not exist on site -99, which is why
 * it does not ask for one.
 *
 * Read the output for three things: whether the second call was accepted
 * at all, whether the two Totals match, and whether the answer carries
 * any field about the signature that the vendored spec does not
 * document. If the two Totals DISAGREE, T205 must not ship as it stands:
 * the rehearsal would have to carry the signature too, so the figure on
 * the screen is the figure charged.
 */
import { crc32, deflateSync } from "node:zlib";

import { mindbody } from "../src/lib/mindbody";
import { STUDIO_LOCATION_ID, contractsFor, storedCardFor } from "../src/lib/sale";

/** A tiny valid PNG, built here so the probe carries no fixture: an 8x8
 *  square, written chunk by chunk. Real enough that Mindbody's own
 *  validation, if it has any, sees a PNG rather than eight bytes of
 *  magic and noise. */
function tinyPng(): Buffer {
  const w = 8;
  const h = 8;
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; /* bit depth */
  ihdr[9] = 2; /* colour type: truecolour */
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    raw[y * (1 + w * 3)] = 0; /* filter: none */
    for (let x = 0; x < w; x += 1) {
      const at = y * (1 + w * 3) + 1 + x * 3;
      raw[at] = 16;
      raw[at + 1] = 16;
      raw[at + 2] = 16;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function totalOf(res: any): number | null {
  const n = Number(res?.Totals?.Total);
  return Number.isFinite(n) ? n : null;
}

async function rehearse(
  label: string,
  body: Record<string, unknown>,
  clientId: string,
): Promise<any | null> {
  console.log(`\n=== ${label}`);
  console.log(
    `    POST /sale/purchasecontract  Test: true  fields: ${Object.keys(body).join(", ")}`,
  );
  try {
    const res = await mindbody("/sale/purchasecontract", {
      method: "POST",
      body,
      clientId,
    });
    console.log("    RAW ANSWER:");
    console.log(JSON.stringify(res, null, 2));
    if (res?.DryRun) {
      console.log(
        "    Suppressed by dry run. Re-run with POS_DRY_RUN=false to actually ask.",
      );
      return null;
    }
    if (res?.WriteSuppressed) {
      console.log(
        "    Suppressed by the write guard. Put this client id in POS_WRITE_CLIENT_IDS.",
      );
      return null;
    }
    return res;
  } catch (err) {
    console.log(
      `    FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(
      "    A complaint naming ClientSignature IS the answer this probe is for: record the exact wording.",
    );
    return null;
  }
}

async function main(): Promise<void> {
  let clientId = process.argv[2]?.trim() ?? "";
  let contractId = Number(process.argv[3]);

  /* Pete's run of 2026-09-20: "Contract 354 cannot be purchased at
   * location 1". A contract carries LocationPurchaseRestrictionIds
   * (sale.yml:5540, null means anywhere), and the studio's LocationId 1
   * is a constant for site 471, not for the sandbox. So the probe reads
   * the raw contracts and the site's locations, and tries each contract
   * at a location it allows until one prices. */
  console.log("\n=== GET /site/locations");
  const locs = await mindbody("/site/locations");
  const locationIds: number[] = (locs?.Locations ?? [])
    .map((l: any) => Number(l?.Id))
    .filter((n: number) => Number.isInteger(n));
  for (const l of locs?.Locations ?? []) console.log(`    ${l?.Id}  ${l?.Name ?? ""}`);
  if (locationIds.length === 0) locationIds.push(STUDIO_LOCATION_ID);

  /* GET /sale/contracts REQUIRES request.locationId (Pete's run:
   * "LocationId is a required parameter"), so the list is per location
   * and everything it returns for a location is sellable there. Ask
   * once per location and try each contract where it was listed. */
  type Candidate = { id: number; name: string; location: number };
  const candidates: Candidate[] = [];
  for (const loc of locationIds) {
    console.log(`\n=== GET /sale/contracts?request.locationId=${loc}`);
    try {
      const raw = await mindbody(`/sale/contracts?request.locationId=${loc}`);
      for (const c of raw?.Contracts ?? []) {
        const id = Number(c?.Id);
        if (!Number.isInteger(id)) continue;
        console.log(`    ${id}  ${c?.Name ?? ""}`);
        candidates.push({ id, name: String(c?.Name ?? ""), location: loc });
      }
    } catch (err) {
      console.log(`    FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const tryContracts: Candidate[] = Number.isInteger(contractId)
    ? candidates.filter((c) => c.id === contractId)
    : candidates;
  if (tryContracts.length === 0) {
    console.log("    No contract to try; pass a contract id this site lists.");
    process.exit(1);
  }

  /* Payment for the rehearsal, in order of preference: the client's
   * stored card (what the counter sends); the client's account credit
   * (a `Test: true` rehearsal against a zero balance may still price);
   * and, for the sandbox only, a test card in CreditCardInfo. Pete's
   * run of 2026-09-20 found no stored card on any of the sandbox's first
   * 50 clients, which is why the last two exist. Nothing here reaches a
   * real card or a real charge: every call is Test: true on site -99. */
  let payment: Record<string, unknown> | null = null;
  let paymentLabel = "";
  if (clientId) {
    const card = await storedCardFor(clientId);
    if (card) {
      payment = { StoredCardInfo: { LastFour: card.lastFour } };
      paymentLabel = `stored card ...${card.lastFour}`;
    }
  } else {
    console.log("\n=== GET /client/clients (finding a sandbox client, ideally with a stored card)");
    const list = await mindbody("/client/clients?limit=50");
    const rows: any[] = list?.Clients ?? [];
    for (const c of rows) {
      const lf = c?.ClientCreditCard?.LastFour;
      if (typeof lf === "string" && lf.length === 4) {
        clientId = String(c?.Id ?? "");
        payment = { StoredCardInfo: { LastFour: lf } };
        paymentLabel = `stored card ...${lf}`;
        console.log(`    ${clientId}  ${c?.FirstName ?? ""} ${c?.LastName ?? ""}  card ...${lf}`);
        break;
      }
    }
    if (!clientId) {
      clientId = String(rows[0]?.Id ?? "");
      console.log(
        `    None of the first ${rows.length} sandbox clients has a stored card; ` +
          `using ${clientId} with the card-free fallbacks.`,
      );
    }
    if (!clientId) {
      console.log("    No clients on this site; pass a client id instead.");
      process.exit(1);
    }
    console.log(`    Using client ${clientId}.`);
  }
  const target = (process.env.MINDBODY_TARGET ?? "sandbox").trim();
  const fallbacks: { label: string; fields: Record<string, unknown> }[] = [
    ...(payment ? [{ label: paymentLabel, fields: payment }] : []),
    { label: "account credit (UseAccountCredit)", fields: { UseAccountCredit: true } },
    ...(target === "sandbox"
      ? [
          {
            label: "sandbox test card 4111...1111 (CreditCardInfo)",
            fields: {
              CreditCardInfo: {
                CreditCardNumber: "4111111111111111",
                ExpMonth: "12",
                ExpYear: "2030",
                BillingName: "Probe Card",
                BillingAddress: "1 Probe Street",
                BillingCity: "Seattle",
                BillingState: "WA",
                BillingPostalCode: "98103",
                SaveInfo: false,
              },
            },
          },
        ]
      : []),
  ];
  const png = tinyPng();
  let without: any = null;
  let with_: any = null;
  outer: for (const c of tryContracts) {
    for (const loc of [c.location]) {
      for (const fb of fallbacks) {
        const base = {
          ContractId: c.id,
          ClientId: clientId,
          Test: true,
          LocationId: loc,
          FirstPaymentOccurs: "Instant",
          ...fb.fields,
          /* Deliberately false: a probe must not send anybody an email. */
          SendNotifications: false,
        };
        console.log(
          `\nProbe D-B2: client ${clientId}, contract ${c.id} (${c.name}), location ${loc}, paying with ${fb.label}` +
            `\nSignature: ${png.length} bytes of PNG, ${png.toString("base64").length} base64 chars`,
        );
        without = await rehearse("WITHOUT ClientSignature", base, clientId);
        if (without === null) {
          console.log("    Did not price; trying the next combination.");
          continue;
        }
        contractId = c.id;
        with_ = await rehearse(
          "WITH ClientSignature",
          { ...base, ClientSignature: png.toString("base64") },
          clientId,
        );
        break outer;
      }
    }
  }

  console.log("\n=== VERDICT");
  if (without === null || with_ === null) {
    console.log(
      "    One of the two calls did not answer (suppressed, or refused above).",
    );
    console.log("    D-B2 is NOT answered by this run.");
    return;
  }
  const a = totalOf(without);
  const b = totalOf(with_);
  console.log(`    Total without: ${a === null ? "none" : a.toFixed(2)}`);
  console.log(`    Total with:    ${b === null ? "none" : b.toFixed(2)}`);
  if (a === null || b === null) {
    console.log(
      "    A rehearsal with no Total cannot answer the second half of D-B2.",
    );
  } else if (Math.round(a * 100) === Math.round(b * 100)) {
    console.log(
      "    ACCEPTED and the Total did not move. T205 ships as it stands: the " +
        "rehearsal carries no signature and the purchase does.",
    );
  } else {
    console.log(
      "    THE TOTAL MOVED. Do not ship as it stands: the rehearsal must carry " +
        "the signature too, or the screen shows one number and the card takes " +
        "another.",
    );
  }
  console.log(
    "\n    Also worth recording: any field in the answers above that the " +
      "vendored spec does not document, and whether a document appears on " +
      "the client's Documents page after a REAL (non-Test) purchase.",
  );
}

void main();
