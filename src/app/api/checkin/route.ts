import { NextResponse } from "next/server";

import { requireSession, requireTeacher } from "@/lib/auth";

import { setSignedIn } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * The only write this app performs in Phase 1. It moves no money, it is
 * idempotent (setting SignedIn to a value it already holds is harmless),
 * and it reverses, which is what makes the undo in the UI real rather
 * than a race against a delayed send.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const gate = requireTeacher(request);
  if (!gate.ok) return gate.denied;
  try {
    const { visitId, signedIn, clientId } = await request.json();
    if (typeof visitId !== "number") {
      return NextResponse.json(
        { error: "visitId (number) is required" },
        { status: 400 },
      );
    }
    const { suppressed } = await setSignedIn(
      visitId,
      signedIn !== false,
      typeof clientId === "string" ? clientId : undefined,
    );
    /* `suppressed` says the write never reached Mindbody (dry run or the
     * write guard). Still ok:true -- the guards working is not an error
     * -- but the caller must not chain anything that assumes a session
     * was really consumed (T26's renewal offer). */
    return NextResponse.json({ ok: true, suppressed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
