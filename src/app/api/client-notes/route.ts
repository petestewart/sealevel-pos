import { NextResponse } from "next/server";

import { updateClientNotes } from "@/lib/clients";

export const dynamic = "force-dynamic";

/**
 * Save a client's staff notes: `POST /client/updateclient` with the
 * surgical `{Client: {Id, Notes}, CrossRegionalUpdate: false}` payload
 * (spec-verified in src/lib/clients.ts -- Id and Notes and nothing else,
 * because updateclient overwrites whatever fields the payload carries).
 *
 * The write goes through the mindbody() client, so dry run and the
 * POS_WRITE_CLIENT_IDS guard both apply; a suppressed save is reported as
 * such rather than pretending the note stuck.
 */
export async function POST(request: Request) {
  try {
    const { clientId, notes } = await request.json();
    if (typeof clientId !== "string" || !clientId) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    if (typeof notes !== "string") {
      return NextResponse.json(
        { error: "notes (string, may be empty) is required" },
        { status: 400 },
      );
    }
    const result = await updateClientNotes(clientId, notes);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
