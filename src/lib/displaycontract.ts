/**
 * The contract scene's payload and its result (T205, Phase 2.5 item 6;
 * design docs/design/customer-display.md "Scene 4").
 *
 * The same two rules T202 put on the waiver, for the same reasons:
 *
 * 1. **The payload is built by the SERVER**, never forwarded from the
 *    teacher's browser: the contract's name, its terms as PLAIN TEXT
 *    (T99's helper, applied where the raw HTML is read), the start date
 *    in words, the first payment as the server's own `Test: true`
 *    rehearsal priced it, the autopay line in words, and the student's
 *    first name. The display is told neither the client id, nor the
 *    contract id, nor the terms' sha256: it has no use for any of them
 *    and a screen in a student's hands is the last place to put an
 *    identifier.
 * 2. **The result is a signature and a moment, and both are checked.**
 *    Byte for byte the waiver's rule, so the two scenes cannot drift
 *    apart: `readWaiverResult` is the one validator and this file names
 *    it rather than copying it.
 *
 * Nothing in this file calls Mindbody, and nothing in it may. It is
 * imported by the DISPLAY's own components as well as by the routes, so
 * it holds no node-only import.
 */

import { readWaiverResult } from "./displaywaiver";
import type { WaiverResult } from "./displaywaiver";

/** What the display renders. Every field is a STRING the server already
 *  worded: no amounts to format, no dates to parse, no ids. */
export interface ContractPayload {
  /** The membership's name, as Mindbody has it. */
  contractName: string;
  /** `AgreementTerms`, already reduced to plain text. */
  terms: string;
  /** "today", or "Tuesday, 6 October" -- the server's own wording. */
  startsOn: string;
  /** The first payment as the rehearsal priced it, in words:
   *  "$189.00 today". Null when the rehearsal had no figure (dry run,
   *  the write guard), in which case the screen says so instead of
   *  inventing one. */
  firstPayment: string | null;
  /** "then $189.00 every month", or null when nothing recurs. */
  autopay: string | null;
  /** For the greeting. Null when the client has no usable first name. */
  clientFirstName: string | null;
}

/** What the student hands back: the waiver's shape exactly. */
export type ContractResult = WaiverResult;

/** One bounded line of server-worded text. */
function line(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.trim().slice(0, max) : "";
}

/** The display's copy of the scene, built field by field. Anything else
 *  a caller put in is dropped rather than forwarded. */
export function readContractPayload(
  value: unknown,
): { ok: true; value: ContractPayload } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  const contractName = line(raw.contractName, 120);
  if (contractName.length === 0) {
    return { ok: false, error: "contractName is required" };
  }
  const terms = typeof raw.terms === "string" ? raw.terms.trim() : "";
  if (terms.length === 0) {
    /* A student must never be asked to agree to a blank screen. A
     * contract with no terms at all is a contract this screen cannot
     * collect a signature for, and the teacher's dialog says so. */
    return { ok: false, error: "terms are required" };
  }
  const startsOn = line(raw.startsOn, 80);
  if (startsOn.length === 0) {
    return { ok: false, error: "startsOn is required" };
  }
  const firstPayment = line(raw.firstPayment, 120);
  const autopay = line(raw.autopay, 200);
  const first = line(raw.clientFirstName, 40);
  return {
    ok: true,
    value: {
      contractName,
      terms,
      startsOn,
      firstPayment: firstPayment.length > 0 ? firstPayment : null,
      autopay: autopay.length > 0 ? autopay : null,
      clientFirstName: first.length > 0 ? first : null,
    },
  };
}

/**
 * The student's answer. One validator with the waiver (the PNG magic,
 * the 256KB cap, the one-hour `agreedAt` window), so a signature that
 * would be refused on one scene is refused on the other.
 */
export function readContractResult(
  value: unknown,
  now = Date.now(),
):
  | { ok: true; value: ContractResult; png: Buffer }
  | { ok: false; status: number; error: string } {
  return readWaiverResult(value, now);
}
