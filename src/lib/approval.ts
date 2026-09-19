import { readSetting } from "./db";

/**
 * T203 (Phase 2.5 item 4): "the customer approves each sale", as a
 * studio-wide SETTING and as the rule /api/checkout enforces.
 *
 * Design (docs/design/customer-display.md, "Scene 2 > The setting"): it is
 * global, not a per-iPad tunable, "because it is a studio policy": the
 * drawer's localStorage settings are for numbers that are wrong on one
 * iPad, and this one must be the same on every counter. So it lives in
 * `app_settings` under `customer_confirms_sale`, is edited from the
 * drawer's Settings tab by a teacher whose staff id is in
 * `POS_ADMIN_STAFF_IDS` (the T89 idiom, through
 * PUT /api/admin/customer-confirms), and is shown to everyone.
 *
 * With no database the environment decides, exactly as the banner and the
 * target do: `POS_CUSTOMER_CONFIRMS_SALE=true` (or `1`) turns it on.
 *
 * The direction this fails in is deliberate and is the opposite of T89's
 * target. A store that does not ANSWER falls back to the environment and
 * says so once, because the safe answer here is the one that asks for
 * MORE approval, not less: with the environment unset that is "off",
 * which is today's behaviour and charges nothing extra, and with it set
 * the counter keeps requiring approval. Either way the setting can only
 * ever add a precondition to Charge; it can never remove one. That is why
 * this control is allowed in the drawer at all (CLAUDE.md, "Settings
 * tab": the third recorded exception, and it only tightens).
 *
 * Nothing in this file calls Mindbody.
 */

/** The app_settings key. */
export const CONFIRM_SETTING_KEY = "customer_confirms_sale";

/** The environment fallback, for a deployment with no database. */
export const CONFIRM_ENV_VAR = "POS_CUSTOMER_CONFIRMS_SALE";

/** The comp-token purpose a teacher's PIN mints to approve a sale
 *  themselves (D1). Its own purpose, so a PIN typed to discount a sale,
 *  to overdraw an account or to override a pass does not approve one. It
 *  is defined in comp.ts, which the browser can import, and re-exported
 *  here so the server reads it beside the setting it belongs to. */
export { APPROVE_PURPOSE } from "./comp";

export interface ConfirmSetting {
  on: boolean;
  /** Where that answer came from, for /api/config and the drawer. */
  source: "setting" | "env";
}

function fromEnv(): boolean {
  const raw = (process.env[CONFIRM_ENV_VAR] ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1";
}

/* Complained about at most once a minute, like the target's own unread
 * warning: a counter whose database has gone quiet says so in the log
 * without filling it. */
let warnedUnreadAt = 0;

/**
 * Whether the customer must approve this sale, read per checkout. Bounded
 * by the pool's own query timeout and never throwing: a store that does
 * not answer means the environment decides, and the log says so once.
 */
export async function customerConfirmsSale(): Promise<ConfirmSetting> {
  const answer = await readSetting(CONFIRM_SETTING_KEY).catch(() => ({
    answered: false as const,
    value: null,
  }));
  if (!answer.answered) {
    const now = Date.now();
    if (now - warnedUnreadAt >= 60_000) {
      warnedUnreadAt = now;
      console.warn(
        `[customer-confirms] the stored setting could not be read; ` +
          `${CONFIRM_ENV_VAR} in the server environment decides ` +
          `(${fromEnv() ? "on" : "off"}).`,
      );
    }
    return { on: fromEnv(), source: "env" };
  }
  if (answer.value === "true") return { on: true, source: "setting" };
  if (answer.value === "false") return { on: false, source: "setting" };
  /* No row, or a row saying something else: the environment decides,
   * which is the T29 fallback rule and the only way back off a stored
   * value. */
  return { on: fromEnv(), source: "env" };
}

/**
 * The sentence filed on the client when a teacher approved a sale with
 * their own PIN instead of the customer's tap (D1, Pete: "Teacher
 * override, they must enter their PIN"). Filed the way T45/T62 file a
 * comp's reason, so the studio can find it months later.
 */
export function approvalOverrideLine(
  teacherName: string | null,
  saleId: string | null,
): string {
  const who =
    teacherName !== null && teacherName.trim().length > 0
      ? teacherName.trim()
      : "a teacher";
  return (
    `Sale approved by ${who} at the counter, customer screen not used.` +
    (saleId ? ` Sale ${saleId}.` : "")
  );
}
