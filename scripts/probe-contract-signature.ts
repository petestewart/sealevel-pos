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
 *     <clientId> <contractId> <cardLastFour>
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
import { STUDIO_LOCATION_ID } from "../src/lib/sale";

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
  const clientId = process.argv[2]?.trim();
  const contractId = Number(process.argv[3]);
  const lastFour = process.argv[4]?.trim();
  if (!clientId || !Number.isInteger(contractId) || !lastFour) {
    console.log(
      "Usage: npx tsx --env-file=.env scripts/probe-contract-signature.ts " +
        "<clientId> <contractId> <cardLastFour>",
    );
    process.exit(1);
  }
  const png = tinyPng();
  const base = {
    ContractId: contractId,
    ClientId: clientId,
    Test: true,
    LocationId: STUDIO_LOCATION_ID,
    FirstPaymentOccurs: "Instant",
    StoredCardInfo: { LastFour: lastFour },
    /* Deliberately false: a probe must not send anybody an email. */
    SendNotifications: false,
  };
  console.log(
    `\nProbe D-B2: client ${clientId}, contract ${contractId}, card ...${lastFour}` +
      `\nSignature: ${png.length} bytes of PNG, ${png.toString("base64").length} base64 chars`,
  );

  const without = await rehearse("WITHOUT ClientSignature", base, clientId);
  const with_ = await rehearse(
    "WITH ClientSignature",
    { ...base, ClientSignature: png.toString("base64") },
    clientId,
  );

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
