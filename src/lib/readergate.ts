import { NextResponse } from "next/server";

import { requireActor } from "./actor";
import { requireSession } from "./auth";
import { cardReaderEnabled, READER_OFF_SENTENCE } from "./cardreader";
import type { StaffSession } from "./staffsession";

/**
 * T223: the door every /api/reader/* route goes through: the device
 * session, a signed-in teacher (T50, `requireActor`), and the card reader
 * switch. Off, the answer is 403 `reason: "reader-off"` with one sentence
 * and nothing is sent to Square. `allowWhenOff` is for the reads that
 * only REPORT (status) or only clean up (cancel), never for anything that
 * starts a sale or pairs a Terminal.
 */
export async function readerGate(
  request: Request,
  opts: { allowWhenOff?: boolean } = {},
): Promise<{ denied: NextResponse; session: null } | { denied: null; session: StaffSession; enabled: boolean }> {
  const denied = requireSession(request);
  if (denied) return { denied, session: null };
  const actor = await requireActor(request);
  if (actor.denied) return { denied: actor.denied, session: null };
  const sw = await cardReaderEnabled();
  if (!sw.on && opts.allowWhenOff !== true) {
    return {
      denied: NextResponse.json(
        { error: READER_OFF_SENTENCE, reason: "reader-off" },
        { status: 403 },
      ),
      session: null,
    };
  }
  return { denied: null, session: actor.session, enabled: sw.on };
}
