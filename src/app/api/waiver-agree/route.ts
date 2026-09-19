import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import {
  recordLiabilityRelease,
  updateClientNotes,
  uploadClientDocument,
} from "@/lib/clients";
import { insertWaiverReceipt } from "@/lib/db";
import {
  beginFinalisation,
  consumeRequest,
  loadRequest,
  releaseFinalisation,
} from "@/lib/display";
import { readWaiverResult, waiverDocumentName } from "@/lib/displaywaiver";
import { getWaiver } from "@/lib/waiver";

export const dynamic = "force-dynamic";

/**
 * Record a student's waiver agreement made at the counter (T18).
 *
 * Two writes, deliberately ordered:
 *
 * 1. The RELEASE: the surgical `LiabilityRelease: true` update (see
 *    recordLiabilityRelease in src/lib/clients.ts). Suppression by dry run
 *    or the write guard ends the request here and is reported as such --
 *    the dialog renders it as the amber notice, never success.
 *
 * 2. The RECEIPT, only after a real (non-suppressed) release, because
 *    Mindbody stores no waiver content or version: (a) one structured log
 *    line with the client id, timestamp and the sha256 of the exact text
 *    served (the dialog echoes the hash from /api/waiver; it is verified
 *    against the server's own copy before the release), (b) a row in
 *    waiver_receipts when a database is configured (T29) -- the durable
 *    record, with the full hash -- and (c) the same fact appended to the
 *    client's Mindbody Notes through the existing surgical notes write,
 *    so the receipt travels with the client where staff already look.
 *
 * The caller passes the row's current notes for the append. A stale value
 * loses at most a concurrent edit made from another surface in the same
 * moment, which is acceptable: the roster refetches notes on every load,
 * and the durable record is the waiver_receipts row (or, with no
 * database, the log line).
 *
 * A notes-append failure must NOT fail the agreement -- the release
 * already stands in Mindbody and un-standing it over a bookkeeping line
 * would be worse -- so it reports `{agreed: true, receiptNoted: false}`
 * with the reason, and the UI surfaces a quiet warning. The structured
 * log line has already been written by then, so the receipt is never
 * wholly lost.
 *
 * T49: both writes run as the signed-in teacher when there is one (the
 * schema says the release records `ReleasedBy` as the calling staff
 * member, which is the point), with the one loud fallback on the
 * release; the notes append reuses whichever actor the release landed
 * under.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read, so a
   * signed-out iPad hears only the 401 and never a validation detail
   * or a Mindbody read made on its behalf. */
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
  /* T115 review: the id this call is finalising, released in the
   * `finally` below whatever happens. */
  let claimed: string | null = null;
  try {
    const { clientId, notes, textSha256, displayRequestId } =
      await request.json();
    if (typeof clientId !== "string" || !clientId) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    /* T115: the display path names a REQUEST, and the hash comes from
     * the server's own record of what that request showed. The counter
     * path is unchanged and still echoes the hash it was served. */
    const signedOnDisplay =
      typeof displayRequestId === "string" && displayRequestId.trim().length > 0;
    if (!signedOnDisplay && (typeof textSha256 !== "string" || !/^[0-9a-f]{64}$/.test(textSha256))) {
      return NextResponse.json(
        { error: "textSha256 (64 hex chars, from /api/waiver) is required" },
        { status: 400 },
      );
    }
    if (notes !== null && notes !== undefined && typeof notes !== "string") {
      return NextResponse.json(
        { error: "notes must be the row's current notes string, or null" },
        { status: 400 },
      );
    }

    /* The hash the browser echoes back is proof of WHICH text the dialog
     * showed, and the server does not take a browser's word for a legal
     * receipt: it is verified against the server's own copy of the text
     * (src/lib/waiver.ts, the same cache /api/waiver serves from) BEFORE
     * anything is written. A mismatch means the wording changed since the
     * student read it, or the value was tampered with; either way no
     * release goes out, and the dialog is told to reopen. If the text
     * cannot be fetched to verify, this fails closed the same way. The
     * receipt below then records the server's hash, never the browser's. */
    const waiver = await getWaiver();

    /* T115: the display's half. The browser hands over a HANDLE and
     * nothing else: the signature is pulled from the server's own store,
     * never accepted from the teacher's browser, and every guard above
     * this point (device session, requireActor, T50's no sign-in no
     * write) has already run. */
    let signed:
      | { requestId: string; png: Buffer; sha256: string; agreedAt: string }
      | null = null;
    if (signedOnDisplay) {
      /* T115 review: `consumeRequest` runs LAST, after the release, the
       * row, the upload and the note, so two calls naming one signature
       * (the `completed` event replayed on an SSE reconnect, beside the
       * pending check the dialog makes on open) would otherwise both
       * pass their checks and both write. Claimed synchronously, before
       * the first await, so there is no window between the two. The
       * loser writes nothing and says so in a field the dialog reads as
       * "somebody else is already doing this", not as an error. */
      const id = String(displayRequestId).trim();
      if (!beginFinalisation(id)) {
        return NextResponse.json(
          { error: "That signature is already being recorded.", inFlight: true },
          { status: 409 },
        );
      }
      claimed = id;
      const held = await loadRequest(id);
      if (
        held === null ||
        held.kind !== "waiver" ||
        held.status !== "completed" ||
        held.consumedAt !== null ||
        Date.now() >= held.expiresAt
      ) {
        return NextResponse.json(
          {
            error:
              "That signature is no longer waiting. Ask them to sign again on the customer screen.",
          },
          { status: 409 },
        );
      }
      if (held.private.clientId !== clientId) {
        /* A handle is not a licence to write about somebody else. */
        return NextResponse.json(
          { error: "That signature belongs to a different client." },
          { status: 409 },
        );
      }
      /* The wording the student actually read, against the wording the
       * studio serves NOW. An edit in between means nobody agreed to
       * what is on file, so nothing is written. */
      if (held.private.textSha256 !== waiver.sha256) {
        return NextResponse.json(
          {
            error:
              "The waiver text changed while they were reading it. Ask them to read and sign it again.",
          },
          { status: 409 },
        );
      }
      const result = readWaiverResult(held.result ?? {}, Date.now() + 0);
      if (!result.ok) {
        return NextResponse.json(
          { error: `The signature could not be read (${result.error}).` },
          { status: 409 },
        );
      }
      signed = {
        requestId: held.id,
        png: result.png,
        /* Hashed from the BYTES, here, not read off the stored result:
         * the receipt's figure names what was actually filed. */
        sha256: createHash("sha256").update(result.png).digest("hex"),
        agreedAt: result.value.agreedAt,
      };
    } else if (textSha256 !== waiver.sha256) {
      return NextResponse.json(
        {
          error:
            "The waiver text has changed since it was read. Close the dialog and read it again.",
        },
        { status: 409 },
      );
    }

    const run = await runAsActor(session, "/api/waiver-agree", (actor) =>
      recordLiabilityRelease(clientId, actor),
    );
    const release = run.result;
    if (release.suppressed) {
      /* T115: the request is deliberately NOT consumed here. Nothing was
       * written, so the signature is still good; a real run later (dry
       * run off, or the client added to POS_WRITE_CLIENT_IDS) can still
       * spend it, and nothing was uploaded either. */
      return NextResponse.json({
        agreed: false,
        suppressed: release.suppressed,
        ...(signed === null ? {} : { signed: true }),
        ...actorFields(run),
      });
    }
    /* The actor the release actually landed under: the teacher, or the
     * service account after a fallback (or a dead token). */
    const noteActor =
      session && run.actorFallback === null && !run.staffSessionEnded
        ? { token: session.token, staffId: session.staffId, name: session.name }
        : null;

    /* The release is real. The structured receipt line goes out first:
     * even if the Notes append below fails, the server log holds the
     * client, the moment, and the hash of the exact wording agreed to. */
    /* Signed on the display: the moment is the student's tap, not this
     * server's clock, because that is when they agreed. */
    const at = signed?.agreedAt ?? new Date().toISOString();
    console.log(
      JSON.stringify({
        event: "waiver-agreed",
        clientId,
        at,
        textSha256: waiver.sha256,
        ...(signed === null
          ? {}
          : { via: "customer-display", signatureSha256: signed.sha256 }),
      }),
    );

    /* T29: the durable receipt row, with the FULL sha256 (Notes truncates
     * to 12 chars for staff readability). Only on a real release, like
     * everything below this point. Best effort by design: with no
     * database, or a failed insert, the helper returns false and the
     * behavior is exactly pre-T29 -- the log line above already holds the
     * receipt, and the Notes append still runs. receiptNoted keeps
     * meaning what it always meant: the Mindbody Notes copy. */
    await insertWaiverReceipt(
      clientId,
      at,
      waiver.sha256,
      /* T115: our artifact, captured on our screen. The row is the
       * ORIGINAL; the Mindbody document below is the copy. */
      signed === null ? null : { sha256: signed.sha256, png: signed.png },
    );

    /* T115: the copy, best effort exactly like the Notes append below.
     * A failed upload reports `documentFiled: false` with the reason and
     * the agreement STANDS: the release is real, the receipt row already
     * holds the image, and un-standing a release over a file transfer
     * would be worse than the missing copy. Suppression (dry run, the
     * write guard) is reported as itself, never as filed. */
    let documentFiled = false;
    let documentReason: string | null = null;
    if (signed !== null) {
      try {
        const up = await uploadClientDocument(
          clientId,
          {
            fileName: waiverDocumentName(at, signed.sha256),
            mediaType: "png",
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
        ? `Waiver agreed at the counter ${at}, text sha256:${waiver.sha256.slice(0, 12)}`
        : `Waiver signed on the customer screen ${at}, text sha256:${waiver.sha256.slice(0, 12)}, signature sha256:${signed.sha256.slice(0, 12)}`;
    const current = typeof notes === "string" ? notes : "";
    const newNotes = current ? `${current}\n${receiptLine}` : receiptLine;
    let receiptNoted = false;
    let receiptReason: string | null = null;
    try {
      const noted = await updateClientNotes(clientId, newNotes, noteActor);
      if (noted.suppressed) {
        /* Expected in rehearsal under the write guard; reported honestly
         * rather than as a landed note. */
        receiptReason = `notes append suppressed by ${noted.suppressed}`;
      } else {
        receiptNoted = true;
      }
    } catch (err) {
      receiptReason = err instanceof Error ? err.message : String(err);
    }

    /* The handle is spent LAST, after the release, the row, the upload
     * and the note: everything above may be retried from the same
     * signature, and nothing above can be undone by failing here. */
    if (signed !== null) await consumeRequest(signed.requestId);

    return NextResponse.json({
      agreed: true,
      receiptNoted,
      receiptReason,
      ...(signed === null
        ? {}
        : {
            signed: true,
            documentFiled,
            documentReason,
            signatureSha256: signed.sha256,
          }),
      /* The notes as written, so the row's local state can match what a
       * roster reload would show. Only meaningful when receiptNoted. */
      notes: receiptNoted ? newNotes : null,
      ...actorFields(run),
    });
  } catch (err) {
    /* T50 review: the teacher's token died under this write (the
     * session is already ended, nothing ran): 401 reason "staff", so
     * the gate comes back. */
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  } finally {
    if (claimed !== null) releaseFinalisation(claimed);
  }
}
