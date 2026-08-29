import { NextResponse } from "next/server";

import {
  authRequired,
  issueToken,
  lockoutRemainingMs,
  pinMatches,
  recordLoginFailure,
  recordLoginSuccess,
  sessionSetCookie,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Takes {pin}, answers with a session cookie or a 401. Deliberately open
 * (it IS the door), rate-limited in-memory: five straight failures buy a
 * 30 second lockout. The PIN itself never leaves the server; the client
 * only ever posts what was typed.
 */
export async function POST(request: Request) {
  if (!authRequired()) {
    /* No PIN configured: there is nothing to log into. The page never
     * shows the lock screen in this state, so reaching here is a stray
     * call, not a flow. */
    return NextResponse.json({ error: "auth is disabled" }, { status: 400 });
  }

  const lockedFor = lockoutRemainingMs();
  if (lockedFor > 0) {
    return NextResponse.json(
      {
        error: "too many attempts",
        retryAfterSeconds: Math.ceil(lockedFor / 1000),
      },
      { status: 429 },
    );
  }

  let pin: unknown;
  try {
    ({ pin } = await request.json());
  } catch {
    return NextResponse.json({ error: "pin is required" }, { status: 400 });
  }
  if (typeof pin !== "string" || pin.length === 0) {
    return NextResponse.json({ error: "pin is required" }, { status: 400 });
  }

  if (!pinMatches(pin)) {
    recordLoginFailure();
    return NextResponse.json({ error: "wrong PIN" }, { status: 401 });
  }

  recordLoginSuccess();
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", sessionSetCookie(issueToken()));
  return response;
}
