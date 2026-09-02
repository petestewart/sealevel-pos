import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import {
  EDITABLE_CLIENT_FIELDS,
  updateClientField,
  type EditableClientField,
} from "@/lib/clients";

export const dynamic = "force-dynamic";

/**
 * Save ONE free-text field on a client record: `POST /client/updateclient`
 * with the surgical `{Client: {Id, <field>}, CrossRegionalUpdate: false}`
 * payload (spec-verified in src/lib/clients.ts -- Id and the one field and
 * nothing else, because updateclient overwrites whatever fields the
 * payload carries).
 *
 * The field whitelist -- exactly Notes | RedAlert | YellowAlert -- is
 * enforced HERE, server-side: a browser cannot name any other field, so
 * this route can never be steered into a Liability write or a rename.
 *
 * The write goes through the mindbody() client, so dry run and the
 * POS_WRITE_CLIENT_IDS guard both apply; a suppressed save is reported as
 * such rather than pretending the edit stuck.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* A Mindbody write like the rest: behind the device session (T44
   * review put a teacher gate here too; T48 removed that layer). */
  try {
    const { clientId, field, value } = await request.json();
    if (typeof clientId !== "string" || !clientId) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    if (
      typeof field !== "string" ||
      !(EDITABLE_CLIENT_FIELDS as readonly string[]).includes(field)
    ) {
      return NextResponse.json(
        {
          error: `field must be one of: ${EDITABLE_CLIENT_FIELDS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (typeof value !== "string") {
      return NextResponse.json(
        { error: "value (string, may be empty) is required" },
        { status: 400 },
      );
    }
    const result = await updateClientField(
      clientId,
      field as EditableClientField,
      value,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
