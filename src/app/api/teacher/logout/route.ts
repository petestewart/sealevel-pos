import { NextResponse } from "next/server";

import { teacherClearCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Clears the teacher cookie (T44): the "switch" tap in the header. No
 * session required, like /api/logout: clearing a dead cookie is a no-op.
 * The device session is untouched; the prompt, not the lock, follows.
 */
export async function POST(request: Request) {
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", teacherClearCookie(request));
  return response;
}
