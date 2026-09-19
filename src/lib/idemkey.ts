/**
 * T113: the idempotency key for one Charge tap, minted in the browser.
 *
 * Split out from the server's store (idemstore.ts) on purpose: this file
 * is imported by the screens, and a module holding the store's Map would
 * drag it into the client bundle.
 *
 * The key rides as an HTTP HEADER, not a body field. Two reasons:
 *  - It is metadata about the ATTEMPT, not part of the ticket, and the
 *    ticket is exactly what gets fingerprinted. In the body it would need
 *    a carve-out from that fingerprint, and a carve-out is a hole.
 *  - Every transport-level retry of one fetch resends the same headers
 *    and the same body, which is the case this gate exists for.
 */

/** The header name. Lower case: that is how `Headers` reports it. */
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** Longest key the server will store. A key is our own 32 hex characters;
 *  the bound is only so a hostile or broken caller cannot grow the store
 *  one entry at a time. */
export const IDEMPOTENCY_KEY_MAX = 200;

/**
 * A fresh key for ONE tap. Called from the charge gesture, never per
 * render: two taps are two keys and one tap is one key, however many
 * times its request reaches the server.
 *
 * `crypto.randomUUID` is deliberately not used. It needs a secure
 * context, and the counter iPad runs this app over plain
 * `http://<lan-ip>:3000` (the same reason the drawer's clipboard falls
 * back to a textarea). `crypto.getRandomValues` has no such restriction;
 * the Math.random tail is for a browser that somehow has neither, where a
 * slightly weaker key is still enormously better than no key.
 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  const c: Crypto | undefined =
    typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
