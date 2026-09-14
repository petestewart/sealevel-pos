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
 *  T84 covered the card on file (`CardNumber`) and listed CVV against the
 *  day a field turned up, since Mindbody's ClientCreditCard model has
 *  none. T93 is that day: a typed card charged for one sale sends
 *  `CreditCardNumber` and `CVV` in the CreditCard payment's Metadata
 *  (sale.yml:2867), so both are named here, in either casing. */
const SECRET_KEY =
  /^(CardNumber|CreditCardNumber|CVV|CVC|CardCode|SecurityCode)$/i;

/**
 * A card number sitting where no card key names it: 13 to 19 digits,
 * optionally grouped by single spaces or dashes, not part of a longer run.
 *
 * Redacting by key name alone was not enough (T84 review). Mindbody's
 * refusals are free text and one of them names the card it refused --
 * "The credit card number 4111111111111111 is invalid." -- so the number
 * comes BACK under `Error.Message`, a key no card rule would look at, and
 * from there into this buffer and the drawer's copy-all. Anything shaped
 * like a card number is struck out on sight, in both directions,
 * whatever key it is under.
 *
 * The trade is deliberate: a 13-to-19-digit id in some other field is
 * struck out too. Nothing in this app's traffic has one (client, visit
 * and sale ids are nine digits or fewer, and dates and times carry
 * separators this pattern does not cross), and a lost id in a dev log is
 * worth far less than a card number that came to rest in one.
 */
const CARD_SHAPED = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

/** Any card-shaped run of digits in free text, struck out. */
export function scrubCardDigits(text: string): string {
  /* replace() with a global pattern resets lastIndex itself, so the
   * shared regex is safe to reuse here; a test() first would not be. */
  return text.replace(CARD_SHAPED, REDACTED);
}

/**
 * T83: a GIFT CARD number, which the digit pattern above cannot be
 * trusted to catch.
 *
 * A gift card is a bearer instrument -- the number alone spends the
 * balance -- so it is a secret exactly like a PAN. But Mindbody types
 * the barcode id as a plain string with no documented format
 * (sale.yml:361), so it may be shorter than thirteen characters and may
 * carry letters or dashes, which CARD_SHAPED matches none of. It is
 * struck out by WHERE IT SITS instead:
 *
 * - `?barcodeId=...`, the query of GET /sale/giftcardbalance. The number
 *   travels in the URL, and `path` is a call-log field of its own, so
 *   the body redaction never sees it.
 * - `"cardNumber": "..."` and `"barcodeId": "..."` inside a JSON string.
 *   The GiftCard payment's Metadata is a STRING of JSON (the spec's
 *   type), so the number is not an object value any key rule could
 *   reach, and Mindbody's refusals are free text that can quote it back.
 *
 * The key names are Mindbody's own, in either casing.
 */
const GIFT_IN_QUERY = /([?&](?:barcodeId|cardNumber|giftCardBarcodeId)=)[^&\s"'\\]+/gi;
const GIFT_IN_JSON =
  /("(?:cardNumber|barcodeId|giftCardBarcodeId)"\s*:\s*")[^"]*"/gi;
/* T83 review: the same pair of keys with their quotes ESCAPED, which is
 * how the GiftCard Metadata reads once it has been stringified INSIDE
 * another JSON document -- a response body echoing the payment back, for
 * instance. The rule above sees a quote where that text has a backslash
 * and matches nothing at all. */
const GIFT_IN_ESCAPED_JSON =
  /(\\"(?:cardNumber|barcodeId|giftCardBarcodeId)\\"\s*:\s*\\")(?:[^"\\]|\\[^"])*(\\")/gi;

/** Gift card numbers wherever text can carry one, struck out. */
export function scrubGiftCard(text: string): string {
  return text
    .replace(GIFT_IN_QUERY, `$1${REDACTED}`)
    .replace(GIFT_IN_JSON, `$1${REDACTED}"`)
    .replace(GIFT_IN_ESCAPED_JSON, `$1${REDACTED}$2`);
}

/**
 * T93: a CVV quoted in FREE TEXT, which is how Mindbody hands one back
 * ("The card was declined. (card 4111..., cvv 737)").
 *
 * A CVV is three or four digits, so it cannot be matched by shape: every
 * amount, id and year in a message looks like one, and striking those
 * would mangle the diagnostics this buffer exists for. It is matched by
 * CONTEXT instead -- the words that can introduce one, then a few
 * non-alphanumerics, then the digits -- which needs no knowledge of the
 * value and so covers a refusal as well as a request.
 */
const CVV_IN_TEXT =
  /((?:cvv|cvc|security\s*code|card\s*code)["'\s:=)\]}.,>-]{0,8})\d{3,4}(?!\d)/gi;

export function scrubCvv(text: string): string {
  return text.replace(CVV_IN_TEXT, `$1${REDACTED}`);
}

/** Every number-shaped secret this app's traffic can carry, in one
 *  pass: use THIS anywhere a string is about to be recorded or thrown,
 *  so a new endpoint carrying either kind is covered by default. */
export function scrubSecrets(text: string): string {
  return scrubCvv(scrubGiftCard(scrubCardDigits(text)));
}

/** Whether a TEXT body mentions a card at all, so that the 99% of
 *  records that do not are passed through untouched. */
const CARD_KEY_IN_TEXT =
  /"(ClientCreditCard|CardNumber|CreditCardNumber|CVV|CVC|CardCode|SecurityCode)"/i;

/** T83: keys whose VALUE is a gift card number, wherever they appear as
 *  an object key. Unlike SECRET_KEY this does not mark its object as a
 *  card object: the gift card balance answer is `{ BarcodeId,
 *  RemainingBalance }`, and the balance is the diagnostic half of it. */
const GIFT_KEY = /^(BarcodeId|GiftCardBarcodeId|cardNumber)$/i;

/** What survives from a card object, per direction. T93 added the four
 *  non-secret fields a CreditCard payment's Metadata carries besides the
 *  number and the CVV: without Amount in the request keep-list a typed
 *  card charge would record no figure at all, and the amount is the whole
 *  point of the record. None of them is a secret, and the expiry is what
 *  a refused card is diagnosed from. */
const REQUEST_CARD_KEEP = ["LastFour", "Amount", "ExpMonth", "ExpYear"];
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
  /* A string value anywhere: struck out if it is shaped like a number,
   * or if it carries a gift card number in a query or in JSON. The key
   * it sits under is deliberately not consulted -- except that a key
   * NAMING a gift card number strikes the whole value (below), since a
   * bare barcode id looks like nothing in particular. */
  if (typeof value === "string") {
    return key !== null && GIFT_KEY.test(key) ? REDACTED : scrubSecrets(value);
  }
  /* The key rides into an array, so a card object inside one is still
   * recognised as a card object. */
  if (Array.isArray(value)) return value.map((v) => redactCard(v, keep, key));
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (isCardObject(key, obj)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEY.test(k) || GIFT_KEY.test(k)) out[k] = REDACTED;
      else if (keep.includes(k)) out[k] = v;
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] =
      SECRET_KEY.test(k) || GIFT_KEY.test(k) ? REDACTED : redactCard(v, keep, k);
  }
  return out;
}

/** A body with every card field redacted, as an object or as text. Text
 *  bodies (Mindbody's raw answer) are parsed and rebuilt when they are
 *  JSON; when they are not, the one pattern that could carry a number is
 *  struck out of the text itself. */
export function redactBody(value: unknown, keep = RESPONSE_CARD_KEEP): unknown {
  if (typeof value === "string") {
    /* Every other record keeps its own formatting: a response with no
     * card field in it is not worth parsing and re-printing, which would
     * reflow every roster read in the drawer and eat into the clip limit
     * for nothing. It still goes through the digit scrub, which changes
     * nothing at all unless a number is sitting in it. */
    if (!CARD_KEY_IN_TEXT.test(value)) return scrubSecrets(value);
    try {
      return JSON.stringify(redactCard(JSON.parse(value), keep), null, 2);
    } catch {
      return scrubSecrets(
        value.replace(
          /("(?:CardNumber|CreditCardNumber|CVV|CVC|CardCode|SecurityCode)"\s*:\s*)"[^"]*"/gi,
          `$1"${REDACTED}"`,
        ),
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

/**
 * T83 review: the gift card numbers THIS call is known to carry.
 *
 * The rules above strike a number out by where it sits, and that covers
 * a request, whose shape we build. It cannot cover a REFUSAL: Mindbody
 * quotes the barcode back in free text ("The gift card number GC-9X7 is
 * invalid."), and a barcode need not be card-shaped, so the digit rule
 * misses it and no key rule reaches inside a sentence. But for one
 * record the number is not a guess: it went out in this very call's
 * query or body. Lift it from there and strike the literal out of
 * everything recorded, the response included.
 */
function knownSecrets(entry: CallInput): string[] {
  const found = new Set<string>();
  const fromText = (text: string) => {
    for (const m of text.matchAll(
      /[?&](?:barcodeId|cardNumber|giftCardBarcodeId)=([^&\s"'\\]+)/gi,
    )) {
      const raw = m[1] ?? "";
      found.add(raw);
      try {
        found.add(decodeURIComponent(raw));
      } catch {
        /* a half-escaped value is still covered by the raw form */
      }
    }
    for (const m of text.matchAll(
      /\\?"(?:cardNumber|creditCardNumber|barcodeId|giftCardBarcodeId)\\?"\s*:\s*\\?"([^"\\]*)/gi,
    )) {
      found.add(m[1] ?? "");
    }
  };
  fromText(entry.path);
  if (entry.requestBody !== null && entry.requestBody !== undefined) {
    try {
      fromText(
        typeof entry.requestBody === "string"
          ? entry.requestBody
          : JSON.stringify(entry.requestBody),
      );
    } catch {
      /* a body that will not stringify carries nothing to lift */
    }
  }
  /* T93: the CVV is deliberately NOT lifted here. It is three or four
   * digits, and striking every occurrence of "123" out of a record would
   * mangle amounts and ids for a value no processor echoes back; the key
   * rule above already redacts it in the request, which is the only place
   * this app puts one. The typed card NUMBER is lifted (the key list
   * above), on top of the card-shaped digit rule.
   *
   * Three characters is the floor: shorter is not a number anyone could
   * spend, and striking it would redact ordinary words. */
  return [...found].filter((n) => n.length >= 3);
}

/** Every string under `value`, with each known secret struck out. */
function strike(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") {
    let out = value;
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => strike(v, secrets));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = strike(v, secrets);
  }
  return out;
}

export function record(entry: CallInput): void {
  if (!devtoolsEnabled()) return;
  const secrets = knownSecrets(entry);
  state.entries.unshift({
    ...entry,
    id: state.nextId++,
    at: new Date().toISOString(),
    /* T83: the PATH is a secret too when it carries a gift card's
     * barcode id in its query. The record still shows which endpoint
     * was called and that a number went with it. */
    path: strike(scrubSecrets(entry.path), secrets) as string,
    /* T84: never the card number, in either direction. T83 review: and
     * never a number this call is known to carry, wherever it is quoted
     * back, which is how a refusal returns one. */
    requestBody: strike(
      clip(redactBody(entry.requestBody, REQUEST_CARD_KEEP)),
      secrets,
    ) as string | null,
    responseBody: strike(
      clip(redactBody(entry.responseBody, RESPONSE_CARD_KEEP)),
      secrets,
    ) as string | null,
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
