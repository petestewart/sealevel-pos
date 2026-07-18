import type { CheckSpec } from "./cases.js";

/**
 * Deterministic checks for the drafting eval suite: exact, cheap, and
 * zero API cost. They always run first; the (paid) judge only ever runs
 * on cases whose deterministic tier is fully green, so a regression that
 * a string match can catch never spends a judge token.
 */

export interface CheckResult {
  label: string;
  pass: boolean;
  detail?: string;
}

/**
 * Clock-time extraction for noInventedTimes. Matches "6:00 pm", "18:00",
 * "7.30am" is NOT matched (nonstandard), "6pm", "6 a.m.". Bare numbers
 * without a colon or meridiem ("Hot 26", "75 minutes") never match.
 */
const TIME_RE =
  /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?|\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/gi;

interface ClockTime {
  /** 12-hour hour (1-12). */
  h12: number;
  minute: number;
  /** undefined when the text gave no meridiem and the hour is ambiguous. */
  meridiem?: "am" | "pm";
  /** The matched source text, for failure messages. */
  text: string;
}

function normalizeMeridiem(raw: string | undefined): "am" | "pm" | undefined {
  if (!raw) return undefined;
  return raw.toLowerCase().startsWith("a") ? "am" : "pm";
}

/** Parse every clock time in a piece of text. Exported for unit tests. */
export function extractTimes(text: string): ClockTime[] {
  const out: ClockTime[] = [];
  for (const m of text.matchAll(TIME_RE)) {
    const hour = Number(m[1] ?? m[4]);
    const minute = m[2] !== undefined ? Number(m[2]) : 0;
    let meridiem = normalizeMeridiem(m[3] ?? m[5]);
    if (hour > 23 || minute > 59) continue; // not a clock time
    let h12 = hour;
    if (meridiem === undefined) {
      // 24-hour notation disambiguates itself; 13:00 can only be 1 pm.
      if (hour === 0) {
        h12 = 12;
        meridiem = "am";
      } else if (hour > 12) {
        h12 = hour - 12;
        meridiem = "pm";
      }
    } else if (hour > 12) {
      continue; // "18:00 pm" style junk; skip rather than guess
    }
    out.push({
      h12,
      minute,
      ...(meridiem ? { meridiem } : {}),
      text: m[0].trim(),
    });
  }
  return out;
}

/**
 * True when a draft time is backed by some fixture time: same hour and
 * minute, with meridiems required to agree only when both sides state
 * one (so a fixture "6:00 pm" backs a draft "6:00", and vice versa).
 */
function timeBacked(draft: ClockTime, fixture: ClockTime[]): boolean {
  return fixture.some(
    (f) =>
      f.h12 === draft.h12 &&
      f.minute === draft.minute &&
      (f.meridiem === undefined ||
        draft.meridiem === undefined ||
        f.meridiem === draft.meridiem),
  );
}

/**
 * Dollar-amount extraction for noInventedPrices. "$25", "$ 25.00" and
 * "$1,250" normalize to their numeric value so formatting differences
 * never cause a false mismatch. Amounts written without a dollar sign
 * are out of scope (they cannot be asserted without false positives on
 * ordinary numbers).
 */
const PRICE_RE = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;

/** Parse every $ amount in a piece of text. Exported for unit tests. */
export function extractPrices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    out.push(Number(m[1]!.replace(/,/g, "")));
  }
  return out;
}

function patternLabel(kind: string, pattern: string): string {
  const short = pattern.length > 40 ? `${pattern.slice(0, 37)}...` : pattern;
  return `${kind}(${short})`;
}

function matches(
  draft: string,
  spec: { pattern: string; regex?: boolean; flags?: string },
): boolean {
  if (spec.regex) {
    return new RegExp(spec.pattern, spec.flags ?? "i").test(draft);
  }
  // Plain patterns are case-insensitive substrings; use
  // mustContainVerbatim when the exact bytes matter (URLs).
  return draft.toLowerCase().includes(spec.pattern.toLowerCase());
}

function runCheck(
  spec: CheckSpec,
  draft: string,
  fixtures: string,
): CheckResult {
  switch (spec.kind) {
    case "mustContain": {
      const pass = matches(draft, spec);
      return {
        label: patternLabel(spec.kind, spec.pattern),
        pass,
        ...(pass ? {} : { detail: "draft does not contain it" }),
      };
    }
    case "mustNotContain": {
      const pass = !matches(draft, spec);
      return {
        label: patternLabel(spec.kind, spec.pattern),
        pass,
        ...(pass ? {} : { detail: "draft contains it" }),
      };
    }
    case "mustContainVerbatim": {
      const pass = draft.includes(spec.pattern);
      return {
        label: patternLabel(spec.kind, spec.pattern),
        pass,
        ...(pass ? {} : { detail: "exact string missing from draft" }),
      };
    }
    case "noEmDash": {
      const pass = !draft.includes("—");
      return {
        label: "noEmDash",
        pass,
        ...(pass ? {} : { detail: "draft contains an em dash" }),
      };
    }
    case "noInventedTimes": {
      const fixtureTimes = extractTimes(fixtures);
      const invented = extractTimes(draft).filter(
        (t) => !timeBacked(t, fixtureTimes),
      );
      return {
        label: "noInventedTimes",
        pass: invented.length === 0,
        ...(invented.length > 0
          ? {
              detail: `times not in fixtures: ${invented
                .map((t) => t.text)
                .join(", ")}`,
            }
          : {}),
      };
    }
    case "noInventedPrices": {
      const fixturePrices = new Set(extractPrices(fixtures));
      const invented = extractPrices(draft).filter(
        (p) => !fixturePrices.has(p),
      );
      return {
        label: "noInventedPrices",
        pass: invented.length === 0,
        ...(invented.length > 0
          ? {
              detail: `amounts not in fixtures: ${invented
                .map((p) => `$${p}`)
                .join(", ")}`,
            }
          : {}),
      };
    }
  }
}

/** Run every deterministic check for a case against the draft body. */
export function runChecks(
  checks: CheckSpec[],
  draftBody: string,
  fixtures: string,
): CheckResult[] {
  return checks.map((spec) => runCheck(spec, draftBody, fixtures));
}
