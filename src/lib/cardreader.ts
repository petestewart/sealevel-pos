import { getSetting, readSetting, setSetting } from "./db";
import { allowedWriteClientIds, target } from "./mindbody";

/**
 * Phase 4 (T223): the studio's own Square Terminal, and the two things
 * that decide whether the app may use it at all.
 *
 * 1. **The switch** (Pete, 2026-11-22: "the square functionality should
 *    be behind a flag"). `card_reader` in app_settings, DEFAULT OFF, with
 *    `POS_CARD_READER` as the fallback for a counter with no database
 *    (only `true` or `1` turn it on). Off, every reader route refuses with
 *    one sentence and nothing is sent to Square, and the tile is not drawn.
 *    A store that goes QUIET keeps the last answer it gave (T207's and
 *    T249's idiom); the environment decides only when this process has
 *    never had an answer, and the environment's default is the safe one.
 *    Turning it off with a hold open strands nothing: the sweep in
 *    readerpayment.ts still releases or completes holds, because that is
 *    cleaning up, not starting a sale.
 *
 * 2. **The mode**: which Square, test or live.
 *      Mindbody target sandbox               -> Square's sandbox, always.
 *      Mindbody target prod, POS_READER_LIVE unset -> Square's sandbox, and
 *        a reader sale is refused unless POS_WRITE_CLIENT_IDS narrows
 *        writes to a list (a simulated tap must never hand a real student
 *        a real pass).
 *      Mindbody target prod, POS_READER_LIVE=true -> production Square: a
 *        deliberate deploy, like POS_DRY_RUN=false.
 *    The production token is never read outside the live mode. Nothing
 *    about the mode is settable from a browser.
 *
 * Nothing in this file calls Square or Mindbody.
 */

export const CARD_READER_SETTING_KEY = "card_reader";
export const CARD_READER_ENV_VAR = "POS_CARD_READER";

export type ReaderMode = "sandbox" | "production";

function switchFromEnv(): boolean {
  const raw = (process.env[CARD_READER_ENV_VAR] ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1";
}

let lastAnswered: boolean | null = null;
let warnedAt = 0;

/** Whether the card reader is switched on, read per request, bounded,
 *  never throwing. */
export async function cardReaderEnabled(): Promise<{
  on: boolean;
  source: "setting" | "env";
}> {
  const answer = await readSetting(CARD_READER_SETTING_KEY).catch(() => ({
    answered: false as const,
    value: null,
  }));
  if (!answer.answered) {
    const now = Date.now();
    if (now - warnedAt >= 60_000) {
      warnedAt = now;
      console.warn(
        "[card-reader] the stored switch could not be read; " +
          (lastAnswered !== null
            ? `keeping the last stored value (${lastAnswered ? "on" : "off"}).`
            : `${CARD_READER_ENV_VAR} decides (${switchFromEnv() ? "on" : "off"}).`),
      );
    }
    return lastAnswered !== null
      ? { on: lastAnswered, source: "setting" }
      : { on: switchFromEnv(), source: "env" };
  }
  if (answer.value === "true") {
    lastAnswered = true;
    return { on: true, source: "setting" };
  }
  if (answer.value === "false") {
    lastAnswered = false;
    return { on: false, source: "setting" };
  }
  lastAnswered = null;
  return { on: switchFromEnv(), source: "env" };
}

export async function setCardReaderEnabled(on: boolean): Promise<boolean> {
  const ok = await setSetting(CARD_READER_SETTING_KEY, on ? "true" : "false");
  if (ok) lastAnswered = on;
  return ok;
}

/** The sentence every reader route answers while the switch is off. */
export const READER_OFF_SENTENCE =
  "The card reader is switched off on this counter. An admin can turn it " +
  "on in Settings. Nothing was sent to Square.";

/* --- Mode and configuration --------------------------------------------- */

export function readerMode(): ReaderMode {
  if (target() === "sandbox") return "sandbox";
  return (process.env["POS_READER_LIVE"] ?? "").trim().toLowerCase() === "true"
    ? "production"
    : "sandbox";
}

export interface ReaderEnv {
  mode: ReaderMode;
  baseUrl: string;
  token: string;
  locationId: string;
  /** The Mindbody custom payment method the sale is recorded under (P7),
   *  for the Mindbody target in use, not the Square mode. */
  mindbodyPaymentId: string;
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * The Square credentials for the current mode, and the Mindbody payment
 * method for the current Mindbody target. Names only in errors, never
 * values. `SQUARE_API_BASE_URL` points everything at the fake.
 */
export function readerEnv(): ReaderEnv | { missing: string[] } {
  const mode = readerMode();
  const prefix = mode === "production" ? "SQUARE_PROD_" : "SQUARE_SANDBOX_";
  const tokenName = `${prefix}ACCESS_TOKEN`;
  const locationName = `${prefix}LOCATION_ID`;
  const mbName =
    target() === "sandbox"
      ? "MINDBODY_SANDBOX_READER_PAYMENT_ID"
      : "MINDBODY_PROD_READER_PAYMENT_ID";
  const missing = [tokenName, locationName, mbName].filter((n) => env(n) === "");
  if (missing.length > 0) return { missing };
  const override = env("SQUARE_API_BASE_URL");
  return {
    mode,
    baseUrl:
      override !== ""
        ? override.replace(/\/+$/, "")
        : mode === "production"
          ? "https://connect.squareup.com"
          : "https://connect.squareupsandbox.com",
    token: env(tokenName),
    locationId: env(locationName),
    mindbodyPaymentId: env(mbName),
  };
}

/**
 * Prod Mindbody with a TEST reader: a simulated tap would sell a real pass
 * for no money. Refused unless the write guard narrows writes to a list,
 * which is how a dummy client is exercised. Null when the sale may go on.
 */
export function testReaderOnProdRefusal(): string | null {
  if (target() !== "prod" || readerMode() !== "sandbox") return null;
  if (allowedWriteClientIds().size > 0) return null;
  return (
    "The card reader is in TEST mode on the live studio, and a test tap " +
    "takes no money, so it may only sell to the dummy clients the write " +
    "guard names. Nothing was sent to Square."
  );
}

/* --- The paired Terminal ------------------------------------------------- */

function deviceKey(mode: ReaderMode): string {
  return `square_device_id_${mode}`;
}

/** The paired Terminal's device id for the current mode: the stored one,
 *  else `SQUARE_DEVICE_ID`; null for none. */
export async function pairedDeviceId(): Promise<string | null> {
  const stored = await getSetting(deviceKey(readerMode())).catch(() => null);
  if (stored && stored.trim() !== "") return stored.trim();
  const fallback = env("SQUARE_DEVICE_ID");
  return fallback === "" ? null : fallback;
}

export async function storePairedDeviceId(deviceId: string): Promise<boolean> {
  return setSetting(deviceKey(readerMode()), deviceId);
}
