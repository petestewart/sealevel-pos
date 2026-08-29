import { createHash } from "node:crypto";

import { mindbody, mindbodyEnv } from "./mindbody";

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
 * by stripping markup to plain text: block-ish closers and <br> become
 * newlines, every other tag drops, the basic entities decode, and
 * whitespace collapses. Deliberately NOT rendered as HTML: the waiver
 * body is staff-editable remote content, and a counter app has no
 * business executing it.
 *
 * The sha256 stays over the RAW text exactly as Mindbody served it. The
 * raw text is the canonical artifact the receipt attests to; this
 * transform is deterministic code in the repo, so what was displayed can
 * always be re-derived from the hashed original.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n\n")
    .trim();
}

export async function getWaiver(): Promise<{ text: string; sha256: string }> {
  const siteId = mindbodyEnv().siteId;
  if (!cached || cached.siteId !== siteId) {
    const body = await mindbody("/site/liabilitywaiver");
    const raw = body?.LiabilityWaiver;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("Mindbody returned no waiver text.");
    }
    const text = stripHtml(raw);
    if (!text) throw new Error("Mindbody returned no waiver text.");
    cached = {
      siteId,
      text,
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    };
  }
  return { text: cached.text, sha256: cached.sha256 };
}
