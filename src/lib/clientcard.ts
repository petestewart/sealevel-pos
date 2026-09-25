import { cardDigits, cardExpired, luhnOk } from "./cardrules";
import {
  CLIENT_ID_READ_LIMIT,
  ambiguousClientMessage,
  logClientPick,
  mismatchClientMessage,
  pickClientRecord,
} from "./clientrecord";
import { mindbody, type Actor } from "./mindbody";

/**
 * T84: a card on file, added or replaced from the counter (Pete: "we need
 * to add the ability to add a card on file").
 *
 * There is no add-card endpoint. The card rides `POST /client/updateclient`
 * as `Client.ClientCreditCard` (docs/mindbody-openapi/client.yml:5098 puts
 * the object on `ClientWithSuspensionInfo`, which is the schema
 * `UpdateClientRequest.Client` references; the model itself is at 7365:
 * Address, CardHolder, CardNumber, CardType, City, ExpMonth, ExpYear,
 * LastFour, PostalCode). There is NO CVV field in the model, so the form
 * does not ask for one; if Mindbody turns out to want one, its refusal
 * comes back in words and the field is added then, never stored.
 *
 * The number transits this module once, in the request it is sent in.
 * Nothing here keeps it: it is not returned, not logged (the call log
 * redacts it, src/lib/calllog.ts, and so do mindbody()'s suppression
 * lines), and never written to our database, which by charter holds no
 * copy of anything Mindbody owns.
 *
 * The write is surgical in the same way as every other updateclient call
 * in src/lib/clients.ts: the id, the one thing being changed, and
 * `CrossRegionalUpdate: false`. updateclient overwrites whatever the
 * payload carries, so a card save must not carry a name or a note.
 */

/** What the counter may know about a card on file: enough to name it and
 *  date it, never the number. Read from the same `/client/clients` row
 *  the profile and the stored-card tender already read. */
export interface CardOnFile {
  /** ClientCreditCard.LastFour (client.yml:7397). */
  lastFour: string;
  /** ClientCreditCard.CardType, e.g. "Visa" (client.yml:7377). */
  cardType: string | null;
  expMonth: string | null;
  expYear: string | null;
  /** True when the expiry has passed, or cannot be read. Same rule as
   *  the stored-card tender's (src/lib/sale.ts cardExpired): a card we
   *  cannot date counts as expired, because it must not be presented as
   *  chargeable. T93 moved the test itself into src/lib/cardrules.ts, so
   *  the modal, this module and the typed card all ask the one rule. */
  expired: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The `ClientCreditCard` on a `/client/clients` row, as the counter may
 *  see it. Null when the client has no card. */
export function cardOnFileOf(row: unknown, now = new Date()): CardOnFile | null {
  const cc = (row as { ClientCreditCard?: unknown } | null)?.ClientCreditCard;
  if (!cc || typeof cc !== "object") return null;
  const c = cc as Record<string, unknown>;
  const lastFour = str(c["LastFour"]);
  if (!lastFour) return null;
  const expMonth = str(c["ExpMonth"]);
  const expYear = str(c["ExpYear"]);
  return {
    lastFour,
    cardType: str(c["CardType"]),
    expMonth,
    expYear,
    expired: cardExpired(expMonth, expYear, now),
  };
}

/* T93: luhnOk, cardDigits and cardExpired moved to src/lib/cardrules.ts,
 * a pure module the browser can import too, and are re-exported here so
 * every T84 caller keeps its import. */
export { cardDigits, cardExpired, luhnOk };

/** The card the teacher typed. `number` is digits only by the time it
 *  gets here; the browser's spaces are stripped on both sides. */
export interface CardInput {
  number: string;
  expMonth: string;
  expYear: string;
  cardHolder: string;
  postalCode: string;
}

/** A card number's length range, wide enough for every network Mindbody
 *  takes (13 for old Visa, 19 for some Discover/UnionPay). */
const MIN_DIGITS = 13;
const MAX_DIGITS = 19;

/**
 * Validate what the browser sent. Runs on the SERVER: the modal checks
 * the same rules to keep a typo off the wire, and this is the rule.
 * The messages are teacher-facing, so they say what to fix.
 */
export function parseCardInput(
  raw: unknown,
  now = new Date(),
): { input: CardInput; error: null } | { input: null; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const number = cardDigits(typeof b["number"] === "string" ? b["number"] : "");
  if (number === "") return { input: null, error: "Card number is required." };
  if (
    !/^\d+$/.test(number) ||
    number.length < MIN_DIGITS ||
    number.length > MAX_DIGITS
  ) {
    return {
      input: null,
      error: `Card number must be ${MIN_DIGITS} to ${MAX_DIGITS} digits.`,
    };
  }
  if (!luhnOk(number)) {
    return { input: null, error: "That card number does not check out." };
  }
  const month = String(b["expMonth"] ?? "").trim();
  const year = String(b["expYear"] ?? "").trim();
  if (!/^\d{1,2}$/.test(month) || Number(month) < 1 || Number(month) > 12) {
    return { input: null, error: "Expiry month must be 1 to 12." };
  }
  if (!/^\d{4}$/.test(year)) {
    return { input: null, error: "Expiry year must be four digits." };
  }
  if (cardExpired(month, year, now)) {
    return { input: null, error: "That expiry date has already passed." };
  }
  const cardHolder = String(b["cardHolder"] ?? "").trim();
  if (cardHolder === "") {
    return { input: null, error: "Name on card is required." };
  }
  if (cardHolder.length > 100) {
    return { input: null, error: "Name on card is too long." };
  }
  const postalCode = String(b["postalCode"] ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/.test(postalCode)) {
    return { input: null, error: "Postal code does not look right." };
  }
  return {
    input: {
      number,
      /* Mindbody's ExpMonth is a string; two digits is what its own
       * screens show back. */
      expMonth: month.padStart(2, "0"),
      expYear: year,
      cardHolder,
      postalCode,
    },
    error: null,
  };
}

/** The card on file now, from one `/client/clients` read by id (the
 *  `clientIds=` repeated-param spelling the roster verified live). Used
 *  after a save, so the answer is what Mindbody holds rather than what
 *  the browser typed. */
export async function cardOnFileFor(
  clientId: string,
  now = new Date(),
  /** T114: the record's UniqueId when the caller has one; it decides
   *  between records sharing `clientId`. */
  uniqueId: number | null = null,
): Promise<CardOnFile | null> {
  /* T114: never `limit=1`, which let Mindbody choose between records
   * sharing the id. With no UniqueId and more than one record, this
   * throws rather than show one of them: the caller (saveClientCard)
   * then reports the card as taken but not shown back, which is true. */
  const body = await mindbody(
    `/client/clients?clientIds=${encodeURIComponent(clientId)}` +
      `&limit=${CLIENT_ID_READ_LIMIT}`,
  );
  const total = body?.PaginationResponse?.TotalResults;
  const pick = pickClientRecord<any>(
    body?.Clients ?? [],
    clientId,
    uniqueId,
    typeof total === "number" ? total : null,
  );
  logClientPick("card read-back", clientId, uniqueId, pick);
  if (pick.outcome === "ambiguous") {
    throw new Error(ambiguousClientMessage(clientId, pick.records));
  }
  if (pick.outcome === "mismatch" && uniqueId !== null) {
    throw new Error(mismatchClientMessage(clientId, uniqueId));
  }
  if (!pick.row) {
    throw new Error("Mindbody returned no client record for this id.");
  }
  return cardOnFileOf(pick.row, now);
}

/**
 * Save the card: one `POST /client/updateclient` carrying only the id and
 * `ClientCreditCard`, then a re-read so the answer is Mindbody's card and
 * not an echo of the form. The clientId rides mindbody()'s options for the
 * POS_WRITE_CLIENT_IDS guard (the body nests it under Client, where the
 * guard's body sniffing does not look).
 *
 * Suppression is reported, never dressed as success: under dry run or the
 * write guard there is no re-read and no card, because nothing was saved.
 *
 * The read-back CANNOT be allowed to fail the save (T84 review). It is a
 * second call, on the service account, after the card is already on file,
 * and letting its failure out of here made the write answer for it: a 403
 * on the read reached runAsActor as a refusal of the TEACHER and sent the
 * whole save again (two updateclient calls, seen in the harness), and a
 * 401 on the read ended the teacher's session and told them "Nothing was
 * written" about a card that was. So a failed read-back returns `card:
 * null` with the save still reported as done; the caller says Mindbody
 * took the card but did not show one back, which is exactly what
 * happened.
 */
export async function saveClientCard(
  clientId: string,
  input: CardInput,
  /** T49: the signed-in teacher whose token carries the write. */
  actor?: Actor | null,
  now = new Date(),
  /** T114: the record's UniqueId, for the READ-BACK only. The write is
   *  addressed by client id, as the endpoint requires, and Mindbody
   *  resolves it; this cannot steer which record gets the card. */
  uniqueId: number | null = null,
): Promise<{
  suppressed: "dry-run" | "write-guard" | null;
  card: CardOnFile | null;
}> {
  const res = await mindbody("/client/updateclient", {
    method: "POST",
    body: {
      Client: {
        Id: clientId,
        ClientCreditCard: {
          CardNumber: input.number,
          ExpMonth: input.expMonth,
          ExpYear: input.expYear,
          CardHolder: input.cardHolder,
          PostalCode: input.postalCode,
        },
      },
      CrossRegionalUpdate: false,
    },
    clientId,
    ...(actor ? { actor } : {}),
  });
  if (res?.DryRun) return { suppressed: "dry-run", card: null };
  if (res?.WriteSuppressed) return { suppressed: "write-guard", card: null };
  /* The card is on file from here on, whatever the read-back does. */
  try {
    return {
      suppressed: null,
      card: await cardOnFileFor(clientId, now, uniqueId),
    };
  } catch (err) {
    /* No card detail in this line: it is the read that failed, and the
     * exchange is in the call log with the number redacted. */
    console.warn(
      `[card] saved for client ${clientId}, but reading it back failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { suppressed: null, card: null };
  }
}
