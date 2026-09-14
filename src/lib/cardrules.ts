/**
 * The card rules both sides of the wire need: Luhn, the expiry test, and
 * stripping a typed number to digits.
 *
 * They were written in src/lib/clientcard.ts (T84) and copied by hand
 * into CardModal, because clientcard.ts imports mindbody() and nothing
 * server-side belongs in the browser bundle. T93 needs the same three in
 * a third place (the typed card charged for one sale), so they live here
 * instead: a PURE module, no mindbody, no database, no logging, safe for
 * the browser to import. clientcard.ts re-exports them, so every T84
 * caller is unchanged.
 *
 * One copy matters: the modal greys its own button by these rules and the
 * route refuses by them, and a browser's validation is a courtesy while
 * the server's is the rule. Two copies that drifted would mean a form
 * that accepts what the route refuses.
 */

/** The Luhn check digit. */
export function luhnOk(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Spaces, dashes and non-breaking spaces out; nothing else changed, so
 *  a letter in the box still fails the digits test. */
export function cardDigits(value: string): string {
  return value.replace(/[\s -]/g, "");
}

/** Is an ExpMonth/ExpYear pair in the past? Unparseable counts as past: a
 *  card we cannot date must not be presented as chargeable. */
export function cardExpired(
  expMonth: string | null,
  expYear: string | null,
  now = new Date(),
): boolean {
  const month = Number(expMonth);
  const year = Number(expYear);
  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(year) ||
    year < 2000
  ) {
    return true;
  }
  /* Valid through the last moment of the expiry month. */
  return now.getTime() >= new Date(year, month, 1).getTime();
}
