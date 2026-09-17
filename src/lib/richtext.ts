/**
 * T99: business-authored Mindbody text arrives as HTML.
 *
 * Pete, on the membership dialog: "i am seeing html tags in the modal
 * where the description and agreement are". A contract's AgreementTerms
 * (sale.yml:5555) and the site's liability waiver both come back with
 * markup and entities in them, because a studio owner writes them in
 * Mindbody's rich text editor.
 *
 * `plainText` is the ONE way this app shows any of it: markup becomes
 * line breaks and plain characters, and the result is rendered as TEXT.
 * It is never injected as HTML. `dangerouslySetInnerHTML` on remote,
 * staff-editable content would be a script-injection surface on a
 * counter iPad holding a staff session and a card reader, which is not a
 * trade this app makes for prettier terms text. The contents of
 * `<script>` and `<style>` are dropped whole, so a script's source can
 * never even appear as text in the middle of an agreement.
 *
 * Pure, synchronous and dependency-free on purpose: it runs on the
 * server (the catalog cleans a contract's terms before the browser ever
 * sees them) and is cheap enough to unit-test directly.
 */

/** The named entities that actually turn up in this text, plus the ones
 *  a rich text editor emits for punctuation. An unknown entity is left
 *  exactly as written rather than guessed at: "&foo;" on screen is
 *  honest, an invented character is not. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Decoded AFTER the tags are gone, never before: decoding first would
 *  turn "&lt;b&gt;" into a tag that the stripping step then deleted,
 *  silently eating text the author had escaped on purpose. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi,
    (whole: string, body: string): string => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        /* Surrogates and out-of-range code points are not characters;
         * leave the source text alone rather than throw. */
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
        if (code >= 0xd800 && code <= 0xdfff) return whole;
        return String.fromCodePoint(code);
      }
      const named = NAMED[body.toLowerCase()];
      return named ?? whole;
    },
  );
}

/** The block-level elements whose start and end are a paragraph break. */
const BLOCKS = "p|div|h[1-6]|tr|ul|ol|table|blockquote|section|article|header|footer";

/**
 * `html` as plain text: one string safe to render as text, with the
 * author's line structure kept.
 *
 * - `<script>` and `<style>` go entirely, contents included.
 * - `<br>` is a line break; a block element's start or end is a blank
 *   line; a list item starts a line with a bullet.
 * - Every other tag is dropped, and a comment with it.
 * - Entities decode (named and numeric).
 * - Runs of blank lines collapse to one, and each line is trimmed.
 *
 * Angle brackets that are not tags survive: "spots < 10" is arithmetic
 * an owner may well have typed, so only `<` followed by a letter or a
 * slash counts as markup.
 */
export function plainText(html: string | null | undefined): string {
  if (typeof html !== "string" || html === "") return "";
  let s = html.replace(/\r\n?/g, "\n");

  /* Contents and all. The `|$` arm covers an unclosed <script>, which
   * must not leave its body on screen just because the author never
   * closed it. */
  s = s.replace(
    /<\s*(script|style)\b[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi,
    "",
  );

  s = s.replace(/<\s*li\b[^>]*>/gi, "\n• ");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(new RegExp(`<\\s*/\\s*(?:${BLOCKS}|li)\\s*>`, "gi"), "\n\n");
  s = s.replace(new RegExp(`<\\s*(?:${BLOCKS})\\b[^>]*>`, "gi"), "\n\n");

  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  /* A tag truncated at the end of the string ("...terms <b"), which the
   * pattern above cannot match for want of its closing bracket. */
  s = s.replace(/<\/?[a-zA-Z][^<>]*$/, "");

  s = decodeEntities(s);

  return s
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
