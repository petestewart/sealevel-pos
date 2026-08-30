import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { recordLiabilityRelease, updateClientNotes } from "@/lib/clients";
import { insertWaiverReceipt } from "@/lib/db";
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
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  try {
    const { clientId, notes, textSha256 } = await request.json();
    if (typeof clientId !== "string" || !clientId) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    if (typeof textSha256 !== "string" || !/^[0-9a-f]{64}$/.test(textSha256)) {
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
    if (textSha256 !== waiver.sha256) {
      return NextResponse.json(
        {
          error:
            "The waiver text has changed since it was read. Close the dialog and read it again.",
        },
        { status: 409 },
      );
    }

    const release = await recordLiabilityRelease(clientId);
    if (release.suppressed) {
      return NextResponse.json({
        agreed: false,
        suppressed: release.suppressed,
      });
    }

    /* The release is real. The structured receipt line goes out first:
     * even if the Notes append below fails, the server log holds the
     * client, the moment, and the hash of the exact wording agreed to. */
    const at = new Date().toISOString();
    console.log(
      JSON.stringify({
        event: "waiver-agreed",
        clientId,
        at,
        textSha256: waiver.sha256,
      }),
    );

    /* T29: the durable receipt row, with the FULL sha256 (Notes truncates
     * to 12 chars for staff readability). Only on a real release, like
     * everything below this point. Best effort by design: with no
     * database, or a failed insert, the helper returns false and the
     * behavior is exactly pre-T29 -- the log line above already holds the
     * receipt, and the Notes append still runs. receiptNoted keeps
     * meaning what it always meant: the Mindbody Notes copy. */
    await insertWaiverReceipt(clientId, at, waiver.sha256);

    const receiptLine = `Waiver agreed at the counter ${at}, text sha256:${waiver.sha256.slice(0, 12)}`;
    const current = typeof notes === "string" ? notes : "";
    const newNotes = current ? `${current}\n${receiptLine}` : receiptLine;
    let receiptNoted = false;
    let receiptReason: string | null = null;
    try {
      const noted = await updateClientNotes(clientId, newNotes);
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

    return NextResponse.json({
      agreed: true,
      receiptNoted,
      receiptReason,
      /* The notes as written, so the row's local state can match what a
       * roster reload would show. Only meaningful when receiptNoted. */
      notes: receiptNoted ? newNotes : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
