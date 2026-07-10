/**
 * Inbound-email display utilities (GH-34): quoted-reply detection,
 * HTML-to-text extraction, and long-body clamping. Pure functions over
 * strings; they never mutate the stored payload and never produce markup.
 * The only rendering sink is React text nodes (no dangerouslySetInnerHTML
 * anywhere in the console), so nothing here can introduce an XSS surface.
 */

/** Result of splitting a body into new content vs. quoted/threaded tail. */
export interface QuotedSplit {
  /** New content the sender actually wrote. */
  main: string;
  /** Quoted reply / forwarded tail, or null when none was detected. */
  quoted: string | null;
}

/**
 * Heuristic: does this body look like HTML rather than plain text?
 * Matches a leading tag or the common structural tags anywhere. Plain
 * text like "< body of water" can false-positive; the cost is only that
 * the text-extraction pass runs over it (display-quality, never safety,
 * since rendering stays a React text node either way).
 */
export function looksLikeHtml(body: string): boolean {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("<")) return true;
  return /<\s*(html|div|p|br|body|table|span)\b/i.test(body);
}

/** Named entities we decode (after tags are gone, so decoding is safe). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

// A numeric character reference is only decodable if it is a valid Unicode
// scalar value: in range and NOT a lone UTF-16 surrogate. Surrogates
// (0xD800-0xDFFF) survive String.fromCodePoint but serialize differently on
// server (U+FFFD) vs client (raw surrogate), causing a hydration mismatch, so
// they fall back to the literal entity text like any other out-of-range input.
function decodableCodePoint(code: number): boolean {
  return (
    Number.isInteger(code) &&
    code >= 0 &&
    code <= 0x10ffff &&
    !(code >= 0xd800 && code <= 0xdfff)
  );
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (whole, entity: string) => {
      // Runs over untrusted email bodies, so any code point that isn't a
      // valid Unicode scalar value falls back to the literal entity text
      // instead of crashing the render or breaking hydration.
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = parseInt(entity.slice(2), 16);
        return decodableCodePoint(code) ? String.fromCodePoint(code) : whole;
      }
      if (entity.startsWith("#")) {
        const code = parseInt(entity.slice(1), 10);
        return decodableCodePoint(code) ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    },
  );
}

/**
 * Extract readable text from an HTML email body. Tag stripping happens on
 * the server-rendered string only; the output is displayed exclusively as
 * a React text node, so even a failed strip renders as inert text, never
 * as markup. Entity decoding runs AFTER tag removal, so an encoded
 * `&lt;script&gt;` decodes into visible text, not into a tag.
 */
export function htmlToText(html: string): string {
  let text = html;
  // Drop non-content elements wholesale (script/style/head payloads).
  text = text.replace(
    /<(script|style|head|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " ",
  );
  // Comments.
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  // Block-level closers and <br> become line breaks so structure survives.
  text = text.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  text = text.replace(
    /<\/\s*(p|div|tr|li|h[1-6]|blockquote|table|section|article)\s*>/gi,
    "\n",
  );
  // Every remaining tag goes away entirely.
  text = text.replace(/<[^>]*>/g, "");
  // Any stray angle brackets left by malformed markup stay as literal
  // characters; React escapes them on render.
  text = decodeEntities(text);
  // Tidy whitespace: collapse runs of blank lines, trim line edges.
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

/** Line-level markers that begin a quoted or forwarded tail. */
function isQuoteBoundary(line: string, nextLine: string | undefined): boolean {
  const t = line.trim();
  if (t.startsWith(">")) return true;
  // "On Mon, Jul 6, 2026 at 9:12 AM Jane Doe <jane@x.com> wrote:"
  // (possibly wrapped onto the next line, so also accept a trailing
  // fragment that the next line finishes with "wrote:").
  if (/^On .{1,200}wrote:\s*$/.test(t)) return true;
  if (/^On .{1,200}$/.test(t) && nextLine !== undefined && /wrote:\s*$/.test(nextLine.trim())) {
    return true;
  }
  // Forwarded-message headers.
  if (/^-{2,}\s*Forwarded message\s*-{2,}$/i.test(t)) return true;
  if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) return true;
  if (/^Begin forwarded message:?$/i.test(t)) return true;
  if (/^_{10,}$/.test(t)) return true; // Outlook divider
  return false;
}

/**
 * Split a plain-text body into new content and the quoted/threaded tail.
 * Everything from the first quote boundary onward counts as quoted; if
 * the whole message is quoted (boundary on line one), main stays empty
 * and the caller decides how to present it.
 */
export function splitQuoted(body: string): QuotedSplit {
  const lines = body.split("\n");
  let boundary = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isQuoteBoundary(lines[i]!, lines[i + 1])) {
      boundary = i;
      break;
    }
  }
  if (boundary === -1) return { main: body, quoted: null };
  const main = lines.slice(0, boundary).join("\n").trimEnd();
  const quoted = lines.slice(boundary).join("\n").trim();
  if (quoted.length === 0) return { main: body, quoted: null };
  return { main, quoted };
}

/** Bodies longer than this many lines clamp behind "Show full message". */
export const CLAMP_LINES = 200;

/** First `CLAMP_LINES` lines, or null when no clamp is needed. */
export function clampLines(text: string): {
  clamped: string | null;
  totalLines: number;
} {
  const lines = text.split("\n");
  if (lines.length <= CLAMP_LINES) {
    return { clamped: null, totalLines: lines.length };
  }
  return {
    clamped: lines.slice(0, CLAMP_LINES).join("\n"),
    totalLines: lines.length,
  };
}

/** Attachment descriptor as future ingestion will store it (GH-34). */
export interface AttachmentInfo {
  name: string;
  /** Size in bytes when known. */
  size?: number;
}

/**
 * Normalize an unknown payload.original_email.attachments value into a
 * list of attachment descriptors. Absent / malformed input yields [].
 */
export function parseAttachments(value: unknown): AttachmentInfo[] {
  if (!Array.isArray(value)) return [];
  const out: AttachmentInfo[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push({ name: entry });
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === "string"
    ) {
      const size = (entry as { size?: unknown }).size;
      out.push({
        name: (entry as { name: string }).name,
        size: typeof size === "number" && size >= 0 ? size : undefined,
      });
    }
  }
  return out;
}
