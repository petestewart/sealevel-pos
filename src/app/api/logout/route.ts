import { NextResponse } from "next/server";

import { sessionClearCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Clears the session cookie. No session required to call it: logging out
 * an already-dead session is a no-op, not an error.
 */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", sessionClearCookie());
  return response;
}
