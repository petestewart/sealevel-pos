import { NextResponse } from "next/server";

import { readerEnv, storePairedDeviceId } from "@/lib/cardreader";
import { readerGate } from "@/lib/readergate";
import { square, SquareError, squareKey, type SquareDeviceCode } from "@/lib/square";

export const dynamic = "force-dynamic";

/**
 * T225: "Connect card reader". POST asks Square for a device code for the
 * studio's location; the screen shows it large with a five minute
 * countdown, and the teacher types it on the Terminal's sign-in page
 * ("Device Code", not "Sign in", which is Square's own POS app). GET
 * ?id=<code id> is the poll: PAIRED stores the device id for this mode and
 * answers `paired: true`. Any signed-in teacher, with the switch on; the
 * log names who. Square's sandbox has no Devices API, so this is driven
 * against the fake and the real Terminal only.
 */
export async function POST(request: Request) {
  const gate = await readerGate(request);
  if (gate.denied) return gate.denied;
  const env = readerEnv();
  if ("missing" in env) {
    return NextResponse.json(
      { error: `The card reader is not set up: missing ${env.missing.join(", ")}.`, reason: "not-set-up" },
      { status: 503 },
    );
  }
  try {
    const r = await square<{ device_code: SquareDeviceCode }>(
      "/v2/devices/codes",
      {
        method: "POST",
        body: {
          idempotency_key: squareKey("pair", String(gate.session.staffId), String(Date.now())),
          device_code: {
            name: "Sealevel counter",
            product_type: "TERMINAL_API",
            location_id: env.locationId,
          },
        },
      },
      env,
    );
    const dc = r.device_code;
    console.log(`[reader] pairing code issued id=${dc.id} by staff=${gate.session.staffId}`);
    return NextResponse.json({ id: dc.id, code: dc.code, pairBy: dc.pair_by ?? null, status: dc.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), reason: "square" },
      { status: 502 },
    );
  }
}

export async function GET(request: Request) {
  const gate = await readerGate(request);
  if (gate.denied) return gate.denied;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const env = readerEnv();
  if ("missing" in env) {
    return NextResponse.json({ error: "The card reader is not set up.", reason: "not-set-up" }, { status: 503 });
  }
  try {
    const r = await square<{ device_code: SquareDeviceCode }>(
      `/v2/devices/codes/${encodeURIComponent(id)}`,
      {},
      env,
    );
    const dc = r.device_code;
    if (dc.status === "PAIRED" && dc.device_id) {
      const stored = await storePairedDeviceId(dc.device_id);
      if (!stored) {
        return NextResponse.json(
          {
            error: "The Terminal paired, but the database did not keep it. Try again.",
            reason: "database",
          },
          { status: 503 },
        );
      }
      console.log(
        `[reader] paired device=...${dc.device_id.slice(-4)} by staff=${gate.session.staffId}`,
      );
      return NextResponse.json({ status: "PAIRED", paired: true, deviceTail: dc.device_id.slice(-4) });
    }
    return NextResponse.json({ status: dc.status, paired: false, pairBy: dc.pair_by ?? null });
  } catch (err) {
    /* Square stops returning an EXPIRED code at all: a 4xx here is that.
     * Anything else is Square not answering, which is not an expiry. */
    if (err instanceof SquareError && err.status !== null && err.status < 500) {
      return NextResponse.json({ status: "EXPIRED", paired: false });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), reason: "square" },
      { status: 502 },
    );
  }
}
