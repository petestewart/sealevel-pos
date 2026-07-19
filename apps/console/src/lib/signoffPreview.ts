/**
 * Pure signoff transforms (GH-66 personal signoff, GH-76 per-email
 * override), extracted from lib/approvals.ts so the approval card (a
 * client component) can preview them live. This module must stay
 * CLIENT-SAFE: no db, no env, no @ai-manager/core barrel import (the
 * barrel pulls in pg/redis/bullmq). approvals.ts re-exports everything
 * here, so the server decide path is unchanged.
 */

/**
 * The studio-wide default signoff for outgoing drafts. Mirrors
 * DEFAULT_SIGNOFF in @ai-manager/core (packages/core/src/db/settings.ts),
 * which cannot be imported client-side because the core barrel is
 * server-tainted. Keep the two literals identical.
 */
export const DEFAULT_SIGNOFF = "Sealevel Hot Yoga";

/**
 * Per-email signoff choice (GH-76). "default" keeps the draft as-is (the
 * studio signoff the model was instructed to end with), "name" inserts the
 * approver's name above it (applyPersonalSignoff), "none" strips it.
 */
export type SignoffMode = "default" | "name" | "none";

export interface SignoffChoice {
  mode: SignoffMode;
  /** Approver's signature name; only meaningful for mode "name". */
  name?: string;
}

/**
 * Remove the studio signoff for the "none" choice (GH-76). As conservative
 * as applyPersonalSignoff: only fires when the LAST non-empty line is
 * exactly the default signoff. It also removes an immediately preceding
 * short valediction line ("Warmly,", "Best regards,") that would otherwise
 * dangle with nothing under it, then trims trailing blank lines. Any other
 * body shape is returned unchanged.
 */
export function removeStudioSignoff(body: string): string {
  const normalize = (s: string) => s.trim().replace(/[.!]+$/, "").toLowerCase();
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (normalize(line) !== DEFAULT_SIGNOFF.toLowerCase()) return body;
    let end = i;
    // A dangling closer directly above ("Warmly," / "Best regards,")
    // reads wrong with no name under it; drop it with the signoff. Kept
    // deliberately narrow -- a short comma-terminated line of at most
    // three words -- so a real content sentence that happens to end in a
    // comma ("Hope to see you soon,") is never eaten.
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j]!.trim();
      if (prev.length === 0) continue;
      if (
        prev.endsWith(",") &&
        prev.length <= 30 &&
        prev.split(/\s+/).length <= 3
      ) {
        end = j;
      }
      break;
    }
    const kept = lines.slice(0, end);
    while (kept.length > 0 && kept[kept.length - 1]!.trim().length === 0) {
      kept.pop();
    }
    // Never gut the draft: a body that is nothing but the signoff (or
    // signoff + closer) stays unchanged, and the audit records no
    // signoff change -- shipping an empty email is worse than an
    // unwanted signoff.
    if (kept.every((l) => l.trim().length === 0)) return body;
    return kept.join("\n");
  }
  return body;
}

/**
 * Personal signoff (GH-66): insert the approver's name above the draft's
 * default "Sealevel Hot Yoga" signoff line:
 *
 *   ... see you soon!        ... see you soon!
 *   Sealevel Hot Yoga   ->   Pete
 *                            Sealevel Hot Yoga
 *
 * Deliberately conservative: it only fires when the LAST non-empty line
 * is exactly the default signoff (drafting instructs the model to end
 * every reply that way). Any other shape returns the body unchanged --
 * never guess at rewriting someone's prose.
 */
export function applyPersonalSignoff(body: string, name: string): string {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) return body;
  // Tolerate trailing punctuation on the signoff line ("Sealevel Hot
  // Yoga.") so the match isn't invisibly defeated by a period.
  const normalize = (s: string) => s.trim().replace(/[.!]+$/, "").toLowerCase();
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (normalize(line) !== DEFAULT_SIGNOFF.toLowerCase()) return body;
    // Already personally signed (e.g. the operator typed their name above
    // the studio signoff while editing): do not insert a duplicate.
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j]!.trim();
      if (prev.length === 0) continue;
      if (normalize(prev) === trimmedName.toLowerCase()) return body;
      break;
    }
    lines.splice(i, 0, trimmedName);
    return lines.join("\n");
  }
  return body;
}

/**
 * What decideItem() will produce for a given body + signoff choice: the
 * SAME normalization and guards (CRLF -> LF first; the name is collapsed
 * to one line; a "name" that IS the studio signoff is treated as
 * default). Display-only helper for the approval card's live preview; the
 * server still applies the real transform at decide time.
 */
export function previewSignoff(
  body: string,
  mode: SignoffMode,
  name: string | null | undefined,
): string {
  const base = body.replace(/\r\n/g, "\n");
  const safeName = name?.replace(/\s+/g, " ").trim();
  if (
    mode === "name" &&
    safeName &&
    safeName.toLowerCase() !== DEFAULT_SIGNOFF.toLowerCase()
  ) {
    return applyPersonalSignoff(base, safeName);
  }
  if (mode === "none") return removeStudioSignoff(base);
  return base;
}
