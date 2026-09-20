import { runAsActor } from "./actor";
import type { ActorOutcome } from "./actor";
import {
  recordLiabilityRelease,
  updateClientNotes,
  uploadClientDocument,
} from "./clients";
import { insertWaiverReceipt } from "./db";
import { consumeRequest } from "./display";
import { waiverDocumentName } from "./displaywaiver";

import type { StaffSession } from "./staffsession";

/**
 * Recording a waiver agreement, in one place (T204).
 *
 * This is T18's and T202's finalisation lifted out of
 * /api/waiver-agree unchanged, because T204's sign-up finishes the SAME
 * waiver for a client who did not exist when the signature was taken:
 * /api/client-create creates them and then calls this, with no second
 * tap from the teacher. Two copies of a release, a receipt row, a
 * document upload and a Notes append would have drifted the first time
 * one of them was fixed.
 *
 * The order is deliberate and unchanged:
 *
 * 1. The RELEASE (`LiabilityRelease: true`) under the teacher's own
 *    token with the one loud fallback. Suppression by dry run or the
 *    write guard ENDS it here, reported as itself, and consumes
 *    nothing: nothing was written, so the signature is still good.
 * 2. The structured log line, then the `waiver_receipts` row (ours, the
 *    original), then the document copy to Mindbody (best effort), then
 *    the Notes receipt (best effort).
 * 3. The handle is spent LAST, after everything that could be retried
 *    from the same signature.
 *
 * The CALLER does the claiming (`beginFinalisation`) and the checking:
 * which request this is, that it is completed, unconsumed and for this
 * client, and that the wording has not changed since it was read. This
 * function is handed a signature it may trust and a client id it may
 * write to.
 */
export interface WaiverSignature {
  requestId: string;
  png: Buffer;
  sha256: string;
  agreedAt: string;
}

export interface WaiverFinaliseOutcome {
  agreed: boolean;
  suppressed: "dry-run" | "write-guard" | null;
  signed: boolean;
  documentFiled: boolean;
  documentReason: string | null;
  receiptNoted: boolean;
  receiptReason: string | null;
  signatureSha256: string | null;
  /** The notes as written, so a row's local state can match what a
   *  roster reload would show. Only meaningful when receiptNoted. */
  notes: string | null;
  agreedAt: string;
  /** The runAsActor result, so the calling route can add actorFields()
   *  and report a fallback in its own answer. */
  run: ActorOutcome<{ suppressed: "dry-run" | "write-guard" | null }>;
}

export async function finaliseWaiver(opts: {
  clientId: string;
  session: StaffSession | null;
  /** The route name runAsActor logs a fallback under. */
  route: string;
  /** The sha256 of the waiver text as the SERVER serves it now. */
  waiverSha256: string;
  /** The signature, when one was taken on the customer display; null is
   *  T18's counter path, where the teacher read it aloud. */
  signed: WaiverSignature | null;
  /** The client's notes as they stand, for the append. */
  currentNotes: string | null;
}): Promise<WaiverFinaliseOutcome> {
  const { clientId, session, signed, waiverSha256 } = opts;
  const run = await runAsActor(session, opts.route, (actor) =>
    recordLiabilityRelease(clientId, actor),
  );
  const release = run.result;
  const at = signed?.agreedAt ?? new Date().toISOString();
  if (release.suppressed) {
    return {
      agreed: false,
      suppressed: release.suppressed,
      signed: signed !== null,
      documentFiled: false,
      documentReason: null,
      receiptNoted: false,
      receiptReason: null,
      signatureSha256: signed?.sha256 ?? null,
      notes: null,
      agreedAt: at,
      run,
    };
  }
  /* The actor the release actually landed under: the teacher, or the
   * service account after a fallback (or a dead token). */
  const noteActor =
    session && run.actorFallback === null && !run.staffSessionEnded
      ? { token: session.token, staffId: session.staffId, name: session.name }
      : null;

  console.log(
    JSON.stringify({
      event: "waiver-agreed",
      clientId,
      at,
      textSha256: waiverSha256,
      ...(signed === null
        ? {}
        : { via: "customer-display", signatureSha256: signed.sha256 }),
    }),
  );

  await insertWaiverReceipt(
    clientId,
    at,
    waiverSha256,
    signed === null ? null : { sha256: signed.sha256, png: signed.png },
  );

  let documentFiled = false;
  let documentReason: string | null = null;
  if (signed !== null) {
    try {
      const up = await uploadClientDocument(
        clientId,
        {
          fileName: waiverDocumentName(at, signed.sha256),
          /* D-B1 (Pete, sandbox, 2026-09-20): the spec lists "png" and
           * Mindbody refuses it ("Media type png is invalid"), and
           * ".png", "PNG" and "Png" with it; "image/png" is the spelling
           * that passes the media-type check. A MIME type, not an
           * extension, whatever client.yml:7427 says. */
          mediaType: "image/png",
          buffer: signed.png,
        },
        noteActor,
      );
      if (up.suppressed) {
        documentReason = `document upload suppressed by ${up.suppressed}`;
      } else {
        documentFiled = true;
      }
    } catch (err) {
      documentReason = err instanceof Error ? err.message : String(err);
    }
  }

  const receiptLine =
    signed === null
      ? `Waiver agreed at the counter ${at}, text sha256:${waiverSha256.slice(0, 12)}`
      : `Waiver signed on the customer screen ${at}, text sha256:${waiverSha256.slice(0, 12)}, signature sha256:${signed.sha256.slice(0, 12)}`;
  const current = typeof opts.currentNotes === "string" ? opts.currentNotes : "";
  const newNotes = current ? `${current}\n${receiptLine}` : receiptLine;
  let receiptNoted = false;
  let receiptReason: string | null = null;
  try {
    const noted = await updateClientNotes(clientId, newNotes, noteActor);
    if (noted.suppressed) {
      receiptReason = `notes append suppressed by ${noted.suppressed}`;
    } else {
      receiptNoted = true;
    }
  } catch (err) {
    receiptReason = err instanceof Error ? err.message : String(err);
  }

  if (signed !== null) await consumeRequest(signed.requestId);

  return {
    agreed: true,
    suppressed: null,
    signed: signed !== null,
    documentFiled,
    documentReason,
    receiptNoted,
    receiptReason,
    signatureSha256: signed?.sha256 ?? null,
    notes: receiptNoted ? newNotes : null,
    agreedAt: at,
    run,
  };
}
