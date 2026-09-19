/**
 * T112: overriding a pass Mindbody's own rules refused.
 *
 * Pete, 2026-09-19, reading the T100 notice on the ticket:
 *
 * > "'New Student 2 Week Unlimited was removed from the sale: Only new
 * > clients qualify for this intro series.' this needs to have the
 * > ability to override, like other things in the app. teacher PIN and
 * > reason can be given. in addition to 'Sell as gift card' add an
 * > 'Override' button."
 *
 * THE HONEST PART FIRST. That sentence is Mindbody's business rule, not
 * ours, and nobody has established that any token escapes it. What is
 * known: `priceCart` (and so the checkout rehearsal) runs on the SERVICE
 * ACCOUNT by design, a checkout WRITE has run under the signed-in
 * teacher's own token since T49, and the one probe that produced this
 * sentence (`scripts/probe-restricted.ts`, 2026-09-17) only ever asked
 * the service account. The refusal names the CLIENT, not a permission,
 * so it may well be a rule no token escapes; the permissions that sound
 * relevant (OverrideAssignedPricing, EditSalePriceCountOnRetailScreen,
 * ApplyCustomDiscountsOnRetailScreen) are about PRICE, not eligibility.
 * That probe now asks BOTH halves side by side (T112); until somebody
 * runs it with live credentials the answer is unknown.
 *
 * So the override is built to be honest either way: it is an ATTEMPT,
 * never a promise. What the flag means, and the whole of what it may
 * ever mean:
 *
 *   attempt this line under the TEACHER'S OWN token, and do not
 *   pre-refuse it from our own copy of the rule.
 *
 * It may NEVER set a price, skip a rehearsal, skip the total assertion
 * (T75), skip the basket assertion (T103) or turn any money rail off.
 * Everything in T22-T24 holds unchanged: one explicit fresh tap, single
 * flight, the server's rehearsal authoritative, browser numbers never
 * charged, suppression never success, no auto-retry.
 *
 * The authorization is T48's, not a second path: the teacher's own PIN
 * through /api/teacher/verify, which signs a one-shot token for a stated
 * PURPOSE (T94 review). "override" is its own purpose, so a PIN typed to
 * discount a sale cannot authorize this and the reverse.
 *
 * No React and no server-only imports: the sale screen and three routes
 * all read this module.
 */

import {
  COMP_DETAIL_MAX,
  COMP_DETAIL_MIN,
  compHeadline,
  compNeedsDetail,
  isCompKind,
  type CompReason,
} from "./comp";

/** The `purpose` a PIN is verified under for an override. Its own value,
 *  so verifyCompToken refuses a comp's or an overdraft's token here. */
export const OVERRIDE_PURPOSE = "override" as const;

/**
 * The two things an override can be, and they are not the same thing.
 *
 * - "attempt": the refused pass itself, asked again under the teacher's
 *   own token. It may simply be refused again, and then it says so.
 * - "substitute": Pete's fallback for when it is ("if that doesn't work
 *   then we can use the 'Returning Student 2-week unlimited' item and
 *   discount it to be at the standard 2-week special price behind the
 *   scenes"). A DIFFERENT pass is sold, discounted to the refused pass's
 *   own live price, and no Mindbody rule is overridden at all: the
 *   substitute prices normally. The PIN authorizes the discount, which is
 *   what a discount has needed since T48.
 *
 * The browser names the mode and the REFUSED pass. It never names the
 * substitute or either price: the server resolves those from the stored
 * mapping and the live catalog (src/lib/substitute.ts), so a browser
 * cannot pick which product gets sold or what it costs.
 */
export type OverrideMode = "attempt" | "substitute";

export function isOverrideMode(value: unknown): value is OverrideMode {
  return value === "attempt" || value === "substitute";
}

/** The refused pass's name and Mindbody's sentence are what the RECORD
 *  reads, and both come from the browser, exactly as a discount's item
 *  names do (T45's compItems). They are bounded and they decide nothing:
 *  no rail reads them, and the id below is the only field any Mindbody
 *  call is built from. */
export const OVERRIDE_TEXT_MAX = 300;

export interface OverrideAsk {
  /** The one-shot token /api/teacher/verify signed for purpose
   *  "override". Verified before any Mindbody call; never logged. */
  token: string;
  /** T43/T45/T67's reason, the same kinds and the same note rules. No
   *  new kind: an override is a thing done for a reason the studio
   *  already counts. */
  reason: CompReason;
  /** The refused pass, by the id its cart line carries (a Service
   *  ProductId). The only field a Mindbody call is built from. */
  metadataId: string;
  /** For the record only: what the screen called the pass. */
  pass: string;
  /** For the record only: the sentence the screen showed, Mindbody's
   *  own words as /api/price-cart reported them. */
  refusal: string;
  /** Which of the two things this is; see OverrideMode. */
  mode: OverrideMode;
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, OVERRIDE_TEXT_MAX) : "";
}

/** Mindbody's sentence already ends in a full stop, so quoting it inside
 *  ours must not produce ".". */
function quoted(sentence: string): string {
  return `"${sentence}"${/[.!?]"?$/.test(sentence) ? "" : "."}`;
}

/**
 * Validate an untrusted override envelope. A string return is the 400
 * reason. Shape only: whether the TOKEN is any good is verifyCompToken's
 * question, asked by each route after this.
 */
export function parseOverride(raw: unknown): OverrideAsk | string {
  if (raw === null || typeof raw !== "object") {
    return "override must be an object with a token, a reason and the pass";
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.token !== "string" || o.token.length === 0) {
    return "an override needs the teacher's PIN token";
  }
  const metadataId =
    typeof o.metadataId === "string"
      ? o.metadataId.trim()
      : typeof o.metadataId === "number"
        ? String(o.metadataId)
        : "";
  if (!/^[0-9]{1,12}$/.test(metadataId)) {
    return "an override needs the refused pass's id";
  }
  const reasonRaw = o.reason;
  if (reasonRaw === null || typeof reasonRaw !== "object") {
    return "an override needs a reason";
  }
  const kind = (reasonRaw as Record<string, unknown>).kind;
  if (!isCompKind(kind)) {
    return "override.reason.kind must be one of the stored reasons";
  }
  const detailRaw = (reasonRaw as Record<string, unknown>).detail;
  const detail = typeof detailRaw === "string" ? detailRaw.trim() : "";
  if (detail.length > COMP_DETAIL_MAX) {
    return `a reason note is at most ${COMP_DETAIL_MAX} characters`;
  }
  /* T67's rule, unchanged and not re-decided here: Trade and Other say
   * nothing on their own, so they carry the note. */
  if (compNeedsDetail(kind) && detail.length < COMP_DETAIL_MIN) {
    return `that reason needs a note of at least ${COMP_DETAIL_MIN} characters`;
  }
  /* An absent mode reads as "attempt", which is the only thing an
   * override was before the substitution existed and the weaker of the
   * two: it sells the pass that was asked for or nothing at all. */
  const mode = o.mode === undefined ? "attempt" : o.mode;
  if (!isOverrideMode(mode)) {
    return "override.mode must be attempt or substitute";
  }
  return {
    token: o.token,
    reason: { kind, detail },
    metadataId,
    pass: text(o.pass),
    refusal: text(o.refusal),
    mode,
  };
}

/**
 * THE record's wording, the one place it lives (the `[override]` log
 * line and the note filed on the client both print this):
 *
 *   Override: New Student 2 Week Unlimited sold past Mindbody's refusal
 *   "Only new clients qualify for this intro series." Reason: Trade,
 *   massage swap. Authorized by Kim Farrell. Sale 4711.
 *
 * An override is exactly what the studio will want to find months later,
 * so the pass, the rule it went past, the reason and the teacher are all
 * in one sentence rather than spread over a log nobody keeps.
 */
export function overrideRecordLine(r: {
  ask: OverrideAsk;
  teacherName: string | null;
  saleId: string | null;
  /** T112: the substitution's whole story, when that is what happened.
   *  Both prices are the server's own figures from the live catalog. */
  substitute?: {
    name: string;
    price: number;
    sellAt: number;
    discount: number;
  } | null;
}): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const why = r.ask.reason.detail
    ? `${compHeadline(r.ask.reason)}, ${r.ask.reason.detail}`
    : compHeadline(r.ask.reason);
  const pass = r.ask.pass || `pricing option ${r.ask.metadataId}`;
  const refused = r.ask.refusal
    ? `Substitution: Mindbody refused ${pass}: ${quoted(r.ask.refusal)}`
    : `Substitution: Mindbody refused ${pass}.`;
  const head =
    r.substitute == null
      ? `Override: ${pass}${refusedClause(r.ask)}`
      : `${refused} Sold ${r.substitute.name} instead at ` +
        `${usd(r.substitute.sellAt)}` +
        (r.substitute.discount > 0
          ? ` (${usd(r.substitute.price)} less a ${usd(r.substitute.discount)} discount).`
          : ".");
  return (
    `${head} Reason: ${why}.` +
    (r.teacherName ? ` Authorized by ${r.teacherName}.` : "") +
    (r.saleId ? ` Sale ${r.saleId}.` : "")
  );
}

function refusedClause(ask: OverrideAsk): string {
  return ask.refusal
    ? ` sold past Mindbody's refusal ${quoted(ask.refusal)}`
    : " sold past a Mindbody rule that refused it.";
}

/**
 * What the screen says when Mindbody refuses the pass AGAIN, under the
 * teacher's own token. It must not imply the teacher did anything wrong
 * and must not leave them tapping a button hoping for a different
 * answer, so it names whose rule it is and what the two ways through
 * actually are. Mindbody's own sentence is shown above this, word for
 * word, by the caller.
 */
export const OVERRIDE_REFUSED_ADVICE =
  "That is Mindbody's own rule, not this app's, and it refused the pass " +
  "under your login as well as the studio's, so trying again will get the " +
  "same answer. Nothing was charged and your PIN was not used.";

/** Added to the sentence above when no substitution is configured or the
 *  catalog cannot price one: the two ways through that always exist. */
export const OVERRIDE_REFUSED_WAYS_OUT =
  "The ways through it are to fix the client's record in Mindbody, to buy " +
  "the pass for a client who qualifies, or to sell it as a gift card.";
