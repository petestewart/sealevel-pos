/**
 * T58: who wrote a note. Pete: "whatever teacher is signed in has their
 * name auto appended to any note or alert that they add. we can use an
 * identifier so that the app knows that it was added by them and
 * display it in a way that looks good (put the name in a lighter/
 * different font next to the note, etc.)"
 *
 * `Notes`, `RedAlert` and `YellowAlert` are free text on the Mindbody
 * client record, and front-desk staff also edit them in Mindbody's own
 * web app, so the attribution has to be plain text that reads well
 * there too. The marker is a trailing tag on an entry's last line:
 *
 *     Knee: no deep lunges [by Pete Stewart, 9/3/26]
 *
 * ASCII, a space before it, the studio's wall-clock date as M/D/YY. An
 * ENTRY is a block of text separated from the next by a blank line; a
 * line that ends with the tag also closes its entry, because the waiver
 * receipt (waiver-agree route) appends its line with a single newline
 * and would otherwise fold a signed note and an unsigned receipt into
 * one unsigned block with a raw tag in the middle of it.
 *
 * Signing happens on the server with the staff session's name, never a
 * name the browser sent; this module is shared with the browser only so
 * the editor can strip the tags and the reading views can render them
 * apart from the text. No Mindbody knowledge lives here; it is a text
 * format, one place, both sides.
 */

const SIGNATURE_RE = /\s*\[by ([^\]\n]+?), (\d{1,2}\/\d{1,2}\/\d{2,4})\]\s*$/;

export interface NoteEntry {
  /** The entry's own text, trailing whitespace and the tag removed. */
  text: string;
  /** Who signed it; null for an unsigned entry (typed in Mindbody's web
   *  app, or written before T58). */
  by: string | null;
  /** The M/D/YY the signature carries; null with `by`. */
  on: string | null;
}

/**
 * Split a raw field into entries. Blank lines separate entries; a line
 * ending in a signature tag closes one too (see the module note).
 * Empty entries (runs of blank lines, a tag with no text) are dropped,
 * so `parseEntries("")` is `[]`.
 */
export function parseEntries(text: string | null | undefined): NoteEntry[] {
  const out: NoteEntry[] = [];
  let lines: string[] = [];
  const close = (by: string | null, on: string | null): void => {
    const body = lines.join("\n").trim();
    lines = [];
    if (body) out.push({ text: body, by, on });
  };
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = SIGNATURE_RE.exec(raw);
    if (m) {
      lines.push(raw.slice(0, m.index));
      close(m[1] ?? null, m[2] ?? null);
    } else if (raw.trim() === "") {
      close(null, null);
    } else {
      lines.push(raw);
    }
  }
  close(null, null);
  return out;
}

/** The raw field text for a list of entries: each entry's text with its
 *  tag on the last line when signed, entries separated by a blank line. */
export function joinEntries(entries: readonly NoteEntry[]): string {
  return entries
    .map((e) => (e.by ? `${e.text} [by ${e.by}, ${e.on ?? ""}]` : e.text))
    .join("\n\n");
}

/** The field as a teacher edits it: the entries' texts, no tags. */
export function stripSignatures(text: string | null | undefined): string {
  return parseEntries(text)
    .map((e) => e.text)
    .join("\n\n");
}

/**
 * Sign an edited field. `value` is the draft as the editor showed it
 * (tags stripped); `previous` is the raw text the edit started from.
 * An entry of the draft whose text matches an entry of `previous`
 * keeps that entry's signature, or its lack of one: an old note is not
 * re-attributed to whoever happened to add the next one. Every other
 * entry, new or reworded, is signed `by` on `on`. Returns the raw text
 * to write; empty when the draft is empty, which clears the field.
 */
export function signEntries(
  value: string,
  previous: string | null | undefined,
  by: string,
  on: string,
): string {
  const kept = parseEntries(previous);
  const used = new Set<number>();
  const signed = parseEntries(value).map((entry): NoteEntry => {
    const i = kept.findIndex((k, idx) => !used.has(idx) && k.text === entry.text);
    if (i >= 0) {
      used.add(i);
      const k = kept[i];
      return { text: entry.text, by: k?.by ?? null, on: k?.on ?? null };
    }
    return { text: entry.text, by, on };
  });
  return joinEntries(signed);
}

/** The studio's timezone, the same constant roster.ts and page.tsx
 *  carry: one physical studio, in Seattle, and "today" on a signature
 *  is its day, not the server's (a container commonly runs on UTC). */
const STUDIO_TZ = "America/Los_Angeles";

/** `at` as the studio's calendar date, M/D/YY, the form the tag uses. */
export function studioDate(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    year: "2-digit",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")}/${get("year")}`;
}
