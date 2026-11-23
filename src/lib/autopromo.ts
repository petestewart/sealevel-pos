/**
 * T298: a promotion code put on every ticket automatically, for a run of
 * days (Pete, 2026-11-23: "add a new feature where we can have a promo
 * code automatically applied to all carts. starting today i want BLACK26
 * promo code to be entered for all purchases, thru 11/30").
 *
 * The code is an ordinary Mindbody promotion code, and Mindbody alone
 * decides what it is worth and what it applies to (T220): the Cart
 * screen and the roster's pay dialog put it in their code field as if a
 * teacher had typed it, and everything T220 built (the Test pricing, the
 * rehearsal, the refusal that refuses the sale, the one-discount rule)
 * applies unchanged. Nothing here moves money or calls Mindbody.
 *
 * Where it lives: `app_settings.auto_promo` as JSON `{code, from, until}`
 * (studio dates, both days included), set by an admin in the drawer; with
 * no database, `POS_AUTO_PROMO` as `CODE,YYYY-MM-DD,YYYY-MM-DD`. Outside
 * its dates it is simply not offered.
 */
import { getSetting, readSetting, setSetting } from "./db";
import { parsePromotionCode } from "./promocode";
import { studioWall } from "./roster";

export const AUTO_PROMO_SETTING_KEY = "auto_promo";
export const AUTO_PROMO_ENV_VAR = "POS_AUTO_PROMO";

export interface AutoPromo {
  code: string;
  /** First studio day it runs, YYYY-MM-DD. */
  from: string;
  /** Last studio day it runs, YYYY-MM-DD, included. */
  until: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function realDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The rule, or a refusal in words. */
export function parseAutoPromo(raw: unknown): AutoPromo | { error: string } {
  const r = raw as { code?: unknown; from?: unknown; until?: unknown } | null;
  const parsed = parsePromotionCode(r?.code);
  if ("error" in parsed) return { error: parsed.error };
  if (parsed.code === null) return { error: "Type the promotion code." };
  const from = typeof r?.from === "string" ? r.from.trim() : "";
  const until = typeof r?.until === "string" ? r.until.trim() : "";
  if (!realDay(from) || !realDay(until)) {
    return { error: "Both dates are needed, as a day each." };
  }
  if (until < from) return { error: "The last day is before the first." };
  return { code: parsed.code, from, until };
}

function fromEnv(): AutoPromo | null {
  const raw = (process.env[AUTO_PROMO_ENV_VAR] ?? "").trim();
  if (raw === "") return null;
  const [code, from, until] = raw.split(",").map((s) => s.trim());
  const p = parseAutoPromo({ code, from, until });
  if ("error" in p) {
    console.warn(`[auto-promo] ${AUTO_PROMO_ENV_VAR} ignored: ${p.error}`);
    return null;
  }
  return p;
}

/** The stored rule, else the environment's, and which one answered. */
export async function autoPromoRule(): Promise<{
  rule: AutoPromo | null;
  source: "setting" | "env" | "none";
}> {
  const stored = await getSetting(AUTO_PROMO_SETTING_KEY);
  if (stored !== null) {
    try {
      const p = parseAutoPromo(JSON.parse(stored));
      if (!("error" in p)) return { rule: p, source: "setting" };
      console.warn(`[auto-promo] stored rule ignored: ${p.error}`);
    } catch {
      console.warn("[auto-promo] stored rule is not JSON; ignored");
    }
  }
  const env = fromEnv();
  return env ? { rule: env, source: "env" } : { rule: null, source: "none" };
}

/** The studio's day now, YYYY-MM-DD. */
export function studioToday(now = new Date()): string {
  return studioWall(now).slice(0, 10);
}

/** Whether the rule runs today. */
export function autoPromoRunsOn(rule: AutoPromo, today: string): boolean {
  return rule.from <= today && today <= rule.until;
}

/** The code every ticket gets right now, or null. */
export async function activeAutoPromoCode(now = new Date()): Promise<string | null> {
  const { rule } = await autoPromoRule();
  return rule && autoPromoRunsOn(rule, studioToday(now)) ? rule.code : null;
}

/** Store a rule, or clear it with null. False when the store refused. */
export async function storeAutoPromo(rule: AutoPromo | null): Promise<boolean> {
  return setSetting(AUTO_PROMO_SETTING_KEY, rule === null ? null : JSON.stringify(rule));
}

/** Whether the store answered at all (for the drawer's words). */
export async function autoPromoStoreAnswers(): Promise<boolean> {
  return (await readSetting(AUTO_PROMO_SETTING_KEY)).answered;
}
