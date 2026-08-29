import { NextResponse } from "next/server";

import { authRequired, isAuthenticated } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Tells the page whether to render the lock screen. Deliberately open and
 * deliberately tiny: {authRequired, authenticated} leaks nothing a visitor
 * could use (the lock's existence is visible anyway), and everything real
 * still 401s behind requireSession.
 */
export async function GET(request: Request) {
  return NextResponse.json({
    authRequired: authRequired(),
    authenticated: isAuthenticated(request),
  });
}
