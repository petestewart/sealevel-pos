/**
 * Probe D-B1 (docs/PLAN.md, Phase 2.5): does
 * `POST /client/uploadclientdocument` take the encoding the vendored
 * spec describes, and does the file land where staff can see it?
 *
 * The waiver signature (T202) is copied to Mindbody as a client
 * document, because a waiver has no signature field anywhere on the
 * client (only a contract does). The shape here is the spec's and
 * nothing else: `UploadClientDocumentRequest` is `{ClientId, File}` and
 * `ClientDocument` is `{FileName, MediaType, Buffer}`, where MediaType
 * is the bare extension ("png") and Buffer is a Base64 string of the
 * file's bytes (docs/mindbody-openapi/client.yml:3633 and :7417, 4MB
 * cap). The answer documents `{FileSize, FileName}`; this prints it raw,
 * because an undocumented extra field is exactly what a probe is for.
 *
 * It WRITES: a document is filed on a real client's profile. So it runs
 * against the SANDBOX, on a client id given on the command line, and
 * POS_DRY_RUN must be false for it to reach Mindbody at all (a dry run
 * prints the suppression, which is itself a useful check of the guard).
 * The PNG is generated here, 8x8 pixels, so nothing outside this file is
 * needed and nothing real is uploaded.
 *
 * Usage, against the sandbox:
 *
 *   MINDBODY_TARGET=sandbox POS_DRY_RUN=false \
 *     npx tsx --env-file=.env scripts/probe-upload-document.ts <clientId>
 *
 * Then open that client in Mindbody and look at their Documents page:
 * the question this probe cannot answer from its own output is whether
 * the file is VISIBLE to staff, which is half of what D-B1 asks.
 */
import { deflateSync } from "node:zlib";
import { crc32 } from "node:zlib";

import { mindbody } from "../src/lib/mindbody";

/** A tiny valid PNG, built here so the probe carries no fixture: an 8x8
 *  opaque square, written chunk by chunk (signature, IHDR, IDAT, IEND).
 *  Real enough that Mindbody's own validation, if it has any, sees a
 *  PNG rather than eight bytes of magic and noise. */
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
      raw[at] = 32;
      raw[at + 1] = 32;
      raw[at + 2] = 32;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  const clientId = process.argv[2]?.trim();
  if (!clientId) {
    console.log(
      "Usage: npx tsx --env-file=.env scripts/probe-upload-document.ts <clientId>",
    );
    process.exit(1);
  }
  const png = tinyPng();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  /* Pete's first run (2026-09-20, sandbox client 100041622): the spec's
   * own listed value, "png", was refused with "Media type png is
   * invalid". So the probe now tries the plausible spellings in order and
   * stops at the first one the sandbox accepts; the accepted spelling is
   * what src/lib/clients.ts uploadClientDocument must send. Each try is
   * its own tiny file so a refusal cannot be a duplicate-name complaint. */
  const candidates = ["png", ".png", "image/png", "PNG", "Png"];
  for (const mediaType of candidates) {
    const fileName = `probe-waiver-${stamp}-${candidates.indexOf(mediaType)}.png`;
    const body = {
      ClientId: clientId,
      File: {
        FileName: fileName,
        MediaType: mediaType,
        Buffer: png.toString("base64"),
      },
    };
    console.log(`\n=== POST /client/uploadclientdocument`);
    console.log(`    client ${clientId}`);
    console.log(`    ${fileName}, ${png.length} bytes, MediaType ${JSON.stringify(mediaType)}`);
    console.log(
      `    Buffer: ${body.File.Buffer.length} base64 chars, starts ${body.File.Buffer.slice(0, 16)}\n`,
    );
    try {
      const res = await mindbody("/client/uploadclientdocument", {
        method: "POST",
        body,
        clientId,
      });
      console.log("    RAW ANSWER:");
      console.log(JSON.stringify(res, null, 2));
      if (res?.DryRun) {
        console.log(
          "\n    Suppressed by dry run. Re-run with POS_DRY_RUN=false to actually ask.",
        );
        return;
      }
      if (res?.WriteSuppressed) {
        console.log(
          "\n    Suppressed by the write guard. Put this client id in POS_WRITE_CLIENT_IDS.",
        );
        return;
      }
      console.log(
        `\n    ACCEPTED with MediaType ${JSON.stringify(mediaType)}. That spelling is the answer; ` +
          "now open that client's Documents page in Mindbody: the other half of D-B1 is whether staff can SEE it.",
      );
      return;
    } catch (err) {
      console.log(
        `    REFUSED with MediaType ${JSON.stringify(mediaType)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(
    "\n    Every spelling was refused. Record each wording above; the next guess is the field's meaning, not its spelling.",
  );
}

void main();
