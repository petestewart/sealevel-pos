import { createHash } from "node:crypto";

import { mindbody, mindbodyEnv } from "./mindbody";
import { plainText } from "./richtext";

/**
 * The studio's liability waiver text, with a sha256 of the EXACT text
 * served: `GET /site/liabilitywaiver` returns `{LiabilityWaiver: string}`
 * per the vendored spec (docs/mindbody-openapi/site.yml,
 * `GetLiabilityWaiverResponse` -- one property, `LiabilityWaiver`).
 *
 * Lives here rather than in the /api/waiver route so that BOTH sides of
 * the agreement flow read the same copy: /api/waiver serves it to the
 * dialog, and /api/waiver-agree verifies the hash the browser echoes back
 * against this server-side value before anything is written. The receipt
 * must record what the SERVER served, not what a browser claims it saw.
 *
 * Cached for the process lifetime, keyed by site id so a target switch
 * cannot serve the sandbox's waiver as production's: the text changes
 * roughly never, and the alternative is a metered call every time the
 * dialog opens. A failed fetch caches nothing, so the next request
 * retries.
 */
let cached: { siteId: string; text: string; sha256: string } | null = null;

/**
 * The stored waiver is HTML (the sandbox's arrived wrapped in a <div>,
 * and Mindbody's own dialog renders it), so the display copy is derived
 * by stripping markup to plain text. Deliberately NOT rendered as HTML:
 * the waiver body is staff-editable remote content, and a counter app
 * has no business executing it. T99 moved the transform itself to
 * src/lib/richtext.ts `plainText`, which the contract agreement uses
 * too: one reading of this text for the whole app, tested directly.
 *
 * The sha256 stays over the RAW text exactly as Mindbody served it. The
 * raw text is the canonical artifact the receipt attests to; this
 * transform is deterministic code in the repo, so what was displayed can
 * always be re-derived from the hashed original.
 */

export async function getWaiver(): Promise<{ text: string; sha256: string }> {
  const siteId = mindbodyEnv().siteId;
  if (!cached || cached.siteId !== siteId) {
    const body = await mindbody("/site/liabilitywaiver");
    const raw = body?.LiabilityWaiver;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("Mindbody returned no waiver text.");
    }
    const text = plainText(raw);
    if (!text) throw new Error("Mindbody returned no waiver text.");
    cached = {
      siteId,
      text,
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    };
  }
  return { text: cached.text, sha256: cached.sha256 };
}
