import { NextResponse } from "next/server";

import { pairedDeviceId, readerEnv, readerMode, testReaderOnProdRefusal } from "@/lib/cardreader";
import { dbConfigured } from "@/lib/db";
import { readerGate } from "@/lib/readergate";

export const dynamic = "force-dynamic";

/**
 * T223: what the Card reader tile needs to draw itself: whether the
 * switch is on, the mode, whether the server has its Square settings
 * (variable NAMES when not), whether a Terminal is paired, and why a sale
 * would be refused. Answers with the switch off too (`enabled: false`),
 * which is how the tile knows not to draw. Calls nothing.
 */
export async function GET(request: Request) {
  const gate = await readerGate(request, { allowWhenOff: true });
  if (gate.denied) return gate.denied;
  const env = readerEnv();
  const deviceId = gate.enabled ? await pairedDeviceId() : null;
  const missing = "missing" in env ? env.missing : [];
  const why = !gate.enabled
    ? "Card reader is switched off."
    : missing.length > 0
      ? "Card reader is not set up."
      : !dbConfigured()
        ? "Card reader needs the database."
        : deviceId === null
          ? "Card reader is not connected."
          : testReaderOnProdRefusal();
  return NextResponse.json({
    enabled: gate.enabled,
    mode: readerMode(),
    missing,
    paired: deviceId !== null,
    /** The Terminal's serial, last four only, to tell two apart. */
    deviceTail: deviceId === null ? null : deviceId.slice(-4),
    ready: gate.enabled && why === null,
    why,
  });
}
