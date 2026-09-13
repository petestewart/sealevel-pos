/**
 * A ring buffer of recent Mindbody calls, for the dev drawer.
 *
 * This records on the SERVER, where the calls actually happen, so it shows
 * the real request body and the real response rather than what our own API
 * routes chose to pass on. That distinction is the whole point: most of the
 * time lost on this project went to guessing what Mindbody received and
 * what it said back.
 *
 * Off unless explicitly enabled. The entries contain client names, visit
 * ids and booking details, which is fine on a developer's laptop and not
 * fine sitting behind an unauthenticated endpoint at the counter.
 */

export interface CallRecord {
  id: number;
  at: string;
  method: string;
  path: string;
  /** HTTP status, or null when the call was suppressed before being sent. */
  status: number | null;
  ms: number;
  /** "sent", "dry-run", or "write-guard". */
  outcome: string;
  /** T49: the staff id whose token the call went out under, when a
   *  signed-in teacher's rather than the service account's; null for
   *  the service account and for suppressed calls. Never the token. */
  actor: number | null;
  requestBody: string | null;
  responseBody: string | null;
}

export function devtoolsEnabled(): boolean {
  return (
    process.env["POS_DEVTOOLS"] === "true" ||
    process.env.NODE_ENV === "development"
  );
}

/* 60 was too few to diagnose anything after the fact: by the time a
 * teacher reaches the drawer, the call that misbehaved has usually been
 * pushed out by the roster refreshes since (Pete, fifth live test, on a
 * search that rendered every row nameless and could not be chased). At
 * the clip below this is a few MB in the worst case and far less in
 * practice, on a dev-only buffer. */
const LIMIT = 300;
/** Bodies are truncated: a full client page is 200 records of JSON and
 *  nobody reads that in a drawer. */
const BODY_LIMIT = 6000;

/* The buffer lives on globalThis, not in module scope (Pete, 2026-09-02:
 * the drawer emptied after a browser refresh with no restart). In `next
 * dev` a route is compiled lazily on first hit and a recompile can
 * instantiate this module afresh, so a module-level array is a NEW empty
 * array for the next route that imports it. The global survives every
 * recompile for the life of the process, which is the lifetime the
 * drawer promises. Production bundles once and sees no difference. */
interface CallLogState {
  entries: CallRecord[];
  nextId: number;
}
const G = globalThis as typeof globalThis & { __posCallLog?: CallLogState };
const state: CallLogState = (G.__posCallLog ??= { entries: [], nextId: 1 });

/* T84: a card number passes through the server once, in the request that
 * saves it, and the drawer is the one place it could come to rest -- a
 * ring buffer in memory, copied to a clipboard by a `copy` button. So the
 * buffer never sees it. Redaction happens HERE rather than at the call
 * site, so any future endpoint carrying a card is covered by default:
 * forgetting to redact must not be possible.
 *
 * A card number is replaced by a marker rather than dropped, so the
 * record still shows that a card WAS sent and the shape Mindbody got. On
 * the way OUT (the request) nothing else about the card is kept beyond
 * LastFour: not the holder, not the billing address, not the expiry. On
 * the way BACK (Mindbody's answer, which cannot contain a PAN -- the
 * model returns LastFour) the descriptive fields the profile renders are
 * kept, because a card save that came back wrong is diagnosed from them.
 */
const REDACTED = "<redacted>";

/** Keys whose value is a secret in its own right, wherever they appear.
 *  CVV is not in Mindbody's ClientCreditCard model at all; it is listed
 *  so that a field added later cannot slip through unredacted. */
const SECRET_KEY = /^(CardNumber|CVV|CVC|CardCode|SecurityCode)$/i;

/** Whether a TEXT body mentions a card at all, so that the 99% of
 *  records that do not are passed through untouched. */
const CARD_KEY_IN_TEXT =
  /"(ClientCreditCard|CardNumber|CVV|CVC|CardCode|SecurityCode)"/i;

/** What survives from a card object, per direction. */
const REQUEST_CARD_KEEP = ["LastFour"];
const RESPONSE_CARD_KEEP = ["LastFour", "CardType", "ExpMonth", "ExpYear"];

function isCardObject(key: string | null, value: Record<string, unknown>): boolean {
  return (
    key === "ClientCreditCard" ||
    Object.keys(value).some((k) => SECRET_KEY.test(k))
  );
}

function redactCard(
  value: unknown,
  keep: string[],
  key: string | null = null,
): unknown {
  if (Array.isArray(value)) return value.map((v) => redactCard(v, keep));
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (isCardObject(key, obj)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEY.test(k)) out[k] = REDACTED;
      else if (keep.includes(k)) out[k] = v;
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redactCard(v, keep, k);
  }
  return out;
}

/** A body with every card field redacted, as an object or as text. Text
 *  bodies (Mindbody's raw answer) are parsed and rebuilt when they are
 *  JSON; when they are not, the one pattern that could carry a number is
 *  struck out of the text itself. */
export function redactBody(value: unknown, keep = RESPONSE_CARD_KEEP): unknown {
  if (typeof value === "string") {
    /* Every other record is left exactly as it arrived: a response with
     * no card field in it is not worth parsing and re-printing, which
     * would reflow every roster read in the drawer and eat into the
     * clip limit for nothing. */
    if (!CARD_KEY_IN_TEXT.test(value)) return value;
    try {
      return JSON.stringify(redactCard(JSON.parse(value), keep), null, 2);
    } catch {
      return value.replace(
        /("(?:CardNumber|CVV|CVC|CardCode|SecurityCode)"\s*:\s*)"[^"]*"/gi,
        `$1"${REDACTED}"`,
      );
    }
  }
  return redactCard(value, keep);
}

/** The request-body redaction, for the log lines mindbody() writes when a
 *  write is suppressed: those print the payload to the server log, which
 *  is no better a home for a card number than the drawer. */
export function redactRequest(value: unknown): unknown {
  return redactBody(value, REQUEST_CARD_KEEP);
}

function clip(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > BODY_LIMIT
    ? `${text.slice(0, BODY_LIMIT)}\n... [${text.length - BODY_LIMIT} more chars]`
    : text;
}

/** Bodies arrive as objects or text; clip() renders whichever. */
export interface CallInput extends Omit<CallRecord, "id" | "at" | "requestBody" | "responseBody"> {
  requestBody?: unknown;
  responseBody?: unknown;
}

export function record(entry: CallInput): void {
  if (!devtoolsEnabled()) return;
  state.entries.unshift({
    ...entry,
    id: state.nextId++,
    at: new Date().toISOString(),
    /* T84: never the card number, in either direction. */
    requestBody: clip(redactBody(entry.requestBody, REQUEST_CARD_KEEP)),
    responseBody: clip(redactBody(entry.responseBody, RESPONSE_CARD_KEEP)),
  });
  if (state.entries.length > LIMIT) state.entries = state.entries.slice(0, LIMIT);
}

/** Records newer than `since`, newest first. */
export function recent(since = 0): CallRecord[] {
  return state.entries.filter((e) => e.id > since);
}

export function clear(): void {
  state.entries = [];
}
