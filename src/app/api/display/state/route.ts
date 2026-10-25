import { NextResponse } from "next/server";

import { claimDisplayPollAttempt, recordDisplayPollSuccess } from "@/lib/auth";
import {
  displayState,
  ensureDisplayLoaded,
  isPairedDisplay,
  newPairingCode,
  pairedDisplay,
  pollPairing,
} from "@/lib/display";
import {
  displayCookieDurable,
  displayCookieValue,
  displayIdFrom,
  displaySetCookie,
} from "@/lib/displayauth";

export const dynamic = "force-dynamic";

/**
 * The display's own poll (T200). Three answers, and no Mindbody call in
 * any of them:
 *
 * - With a valid `pos_display` cookie naming the paired display: paired,
 *   with the display's name. The idle screen renders from this and the
 *   stream carries everything after it.
 * - With no cookie and no code: a fresh six-digit code plus the SECRET
 *   this browser keeps in memory. The code goes on the screen; the
 *   secret never does.
 * - With `code` and `secret`: once a teacher has typed that code into
 *   the drawer, this is where the cookie is issued. A wrong code, or the
 *   right code with the wrong secret, is refused and counted by the
 *   pairing limiter (five, then 30 seconds), so the code cannot be
 *   guessed inside its five minutes and cannot be used by the browser
 *   that merely SAW it.
 *
 * No session of any kind guards this route, because an unpaired display
 * has none; what it can learn is a code it was just given and whether
 * that code has been paired.
 */
export async function GET(request: Request) {
  await ensureDisplayLoaded();
  /* Durable means a pairing actually SURVIVES a restart, which needs both
   * halves: a cookie key that can be derived again (POS_SESSION_SECRET)
   * and a row to derive it against (DATABASE_URL). Either missing and the
   * display says so on its own screen, rather than a teacher finding out
   * after a deploy. */
  const durable = displayCookieDurable() && (await displayState()).durable;
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") ?? "").trim();
  const secret = (url.searchParams.get("secret") ?? "").trim();

  const id = displayIdFrom(request);
  if (isPairedDisplay(id)) {
    const p = pairedDisplay();
    return NextResponse.json({
      paired: true,
      name: p?.name ?? null,
      durable,
      storage: (await displayState()).storage,
    });
  }

  if (code.length > 0 && secret.length > 0) {
    const poll = pollPairing(code, secret);
    if (poll.status === "waiting") {
      return NextResponse.json({ paired: false, waiting: true, durable });
    }
    if (poll.status === "paired") {
      recordDisplayPollSuccess();
      return NextResponse.json(
        { paired: true, name: poll.name, durable },
        {
          headers: {
            "set-cookie": displaySetCookie(displayCookieValue(poll.id)),
          },
        },
      );
    }
    /* Unknown or denied: this one counts. */
    const locked = claimDisplayPollAttempt();
    if (locked > 0) {
      return NextResponse.json(
        {
          paired: false,
          error: "Too many tries. Wait half a minute.",
          retryInMs: locked,
        },
        { status: 429 },
      );
    }
    return NextResponse.json(
      {
        paired: false,
        expired: true,
        error: "That code is no longer valid. Take a new one.",
      },
      { status: 404 },
    );
  }

  /* A display with a stale cookie (an older pairing, or a restart with
   * no POS_SESSION_SECRET) lands here and takes a new code, which is
   * exactly the re-pair the idle screen asks for. */
  const issued = newPairingCode();
  return NextResponse.json({
    paired: false,
    code: issued.code,
    secret: issued.secret,
    expiresAt: new Date(issued.expiresAt).toISOString(),
    durable,
  });
}
