/**
 * Pure Gmail message parsing + reply-building (GH-95). No network, no env,
 * no side effects: everything here is a total function of its input, so it
 * is exhaustively smoke-testable (gmail/gmail.smoke.ts) without a mailbox.
 *
 * Two directions:
 *  - parseGmailMessage: a Gmail `users.messages.get` (format=full) resource
 *    -> the InboundEmailPayload the ingestion pipeline dispatches, carrying
 *    both the human-facing fields (from/subject/body) and the threading
 *    metadata a later reply needs (threadId, the RFC822 Message-ID, To/
 *    Reply-To). The threading metadata is kept OUT of the model's prompt
 *    and injected onto the item structurally (see emailDraft.ts), the same
 *    discipline as tags and KB sources.
 *  - buildRawReply: the fields of an approved reply -> a base64url RFC822
 *    message ready for `users.messages.send`, threaded to the original.
 */

/** Minimal shape of the Gmail message resource fields we read (format=full). */
export interface GmailMessageResource {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
}

/** The inbound email the pipeline works with, with threading metadata. */
export interface ParsedInboundEmail {
  /** RFC822 Message-ID header when present, else the Gmail internal id. */
  messageId: string;
  from?: string;
  subject?: string;
  body?: string;
  /** Gmail internal message id (stable; used for label/read mutations). */
  gmailId?: string;
  /** Gmail thread id, so a reply threads into the same conversation. */
  threadId?: string;
  /** Raw RFC822 Message-ID header, for In-Reply-To / References on a reply. */
  messageIdHeader?: string;
  /** Existing References header, extended when we reply. */
  references?: string;
  /** Reply-To header, if the sender set one (preferred reply recipient). */
  replyTo?: string;
  /** The To header of the inbound message (informational). */
  to?: string;
  /** Date header, if present. */
  date?: string;
  /**
   * Automated-mail signal headers (GH-115), captured for the layered
   * no-reply detector (brain/noReply.ts). Classification inputs only:
   * they never enter a model prompt or an outgoing reply.
   */
  /** Auto-Submitted header (RFC 3834), e.g. "auto-generated". */
  autoSubmitted?: string;
  /** Precedence header (bulk / list / auto_reply). */
  precedence?: string;
  /** List-Id header (list mail). */
  listId?: string;
  /** List-Unsubscribe header (bulk mail). */
  listUnsubscribe?: string;
}

/** Decode Gmail's base64url (RFC 4648, '-'/'_' , no padding) to a UTF-8 string. */
export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Encode a UTF-8 string to base64url with no padding (for message ids etc.). */
export function encodeBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** Case-insensitive header lookup over a part's headers. */
function header(part: GmailMessagePart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const h of part?.headers ?? []) {
    if (h.name?.toLowerCase() === lower && typeof h.value === "string") {
      return h.value;
    }
  }
  return undefined;
}

/** Very small HTML-to-text fallback for text/html-only messages. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the best plain-text body from a (possibly multipart) MIME tree.
 * Prefers the first text/plain part; falls back to a stripped text/html
 * part; returns "" when neither is found (e.g. attachment-only mail).
 * Skips parts with a filename (attachments) so an attached .txt is never
 * mistaken for the body.
 */
export function extractPlainBody(payload: GmailMessagePart | undefined): string {
  if (!payload) return "";

  const plain: string[] = [];
  const html: string[] = [];

  const walk = (part: GmailMessagePart): void => {
    const mime = part.mimeType ?? "";
    const isAttachment = Boolean(part.filename && part.filename.length > 0);
    if (!isAttachment && part.body?.data) {
      if (mime === "text/plain") plain.push(decodeBase64Url(part.body.data));
      else if (mime === "text/html") html.push(decodeBase64Url(part.body.data));
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  if (plain.length > 0) return plain.join("\n").trim();
  if (html.length > 0) return htmlToText(html.join("\n"));
  return "";
}

/**
 * Strip quoted reply history from an inbound body, returning ONLY the new
 * message the sender just wrote. A customer replying in-thread ("what times
 * are the weekend hot 26 classes?") carries the entire prior conversation
 * quoted beneath their new line; feeding that whole blob to the drafting
 * model made it answer the OLD quoted questions too. This cuts everything
 * from the first quote boundary onward.
 *
 * Boundaries recognized (the earliest one in the body wins):
 *  - an attribution line like `On <date...>, <name> wrote:` (Gmail/Apple
 *    Mail), whose "wrote:" may wrap across a line or two;
 *  - a run of lines beginning with ">";
 *  - an `-----Original Message-----` delimiter (Outlook);
 *  - a quoted header block: a `From:` line immediately followed by another
 *    quoted header (Sent:/Date:/To:/Subject:), so an ordinary sentence like
 *    "From: my point of view" is never mistaken for one.
 *
 * Conservative by design: this is used ONLY to shape what the model reads
 * (emailDraft.ts), never to alter the stored/threaded body (extractPlainBody
 * still returns the full body). If stripping would leave nothing (for
 * example a body that is entirely a top-quote), the ORIGINAL body is
 * returned so the model is never handed an empty message.
 */
export function stripQuotedReply(body: string): string {
  if (!body) return body;
  const lines = body.split(/\r?\n/);

  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trimStart();

    // A run of quoted lines (clients prefix quoted text with ">").
    if (t.startsWith(">")) {
      cut = i;
      break;
    }
    // Outlook "-----Original Message-----" delimiter.
    if (/^-{2,}\s*original message\s*-{2,}/i.test(t)) {
      cut = i;
      break;
    }
    // Attribution line: "On <date>, <name> wrote:". The "wrote:" may wrap
    // onto the next line or two, so inspect a small window.
    if (/^on\b/i.test(t)) {
      const window = lines.slice(i, i + 3).join(" ");
      if (/\bwrote:/i.test(window)) {
        cut = i;
        break;
      }
    }
    // Quoted header block: a "From:" line followed within a few lines by
    // another quoted header line.
    if (/^from:\s/i.test(t)) {
      const nextFew = lines.slice(i + 1, i + 5);
      if (nextFew.some((l) => /^\s*(sent|date|to|subject):\s/i.test(l))) {
        cut = i;
        break;
      }
    }
  }

  if (cut === -1) return body;
  const kept = lines.slice(0, cut).join("\n").trimEnd();
  return kept.trim().length > 0 ? kept : body;
}

/**
 * Parse a Gmail message resource into a ParsedInboundEmail. Total: missing
 * fields degrade to undefined, and `messageId` always resolves to a
 * non-empty stable key (Message-ID header, else Gmail id, else a synthetic
 * from the thread) so dedupe and the BullMQ jobId always have something.
 */
export function parseGmailMessage(
  msg: GmailMessageResource,
): ParsedInboundEmail {
  const p = msg.payload;
  const messageIdHeader = header(p, "Message-ID") ?? header(p, "Message-Id");
  const gmailId = msg.id;
  const messageId =
    (messageIdHeader && messageIdHeader.trim()) ||
    gmailId ||
    (msg.threadId ? `thread-${msg.threadId}` : "unknown");

  return {
    messageId,
    from: header(p, "From"),
    subject: header(p, "Subject"),
    body: extractPlainBody(p),
    gmailId,
    threadId: msg.threadId,
    messageIdHeader: messageIdHeader?.trim(),
    references: header(p, "References")?.trim(),
    replyTo: header(p, "Reply-To")?.trim(),
    to: header(p, "To")?.trim(),
    date: header(p, "Date")?.trim(),
    autoSubmitted: header(p, "Auto-Submitted")?.trim(),
    precedence: header(p, "Precedence")?.trim(),
    listId: header(p, "List-Id")?.trim(),
    listUnsubscribe: header(p, "List-Unsubscribe")?.trim(),
  };
}

/** Prefix a subject with "Re: " unless it already starts with one. */
export function replySubject(subject: string | undefined): string {
  const s = (subject ?? "").trim();
  if (s.length === 0) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** True when every character is printable ASCII (space..tilde), so the
 * value can sit on a raw header line without an RFC2047 encoded-word. A
 * newline is NOT printable ASCII, so any value carrying one fails this and
 * is forced through the encoded-word path (it cannot escape the line). */
function isAsciiPrintable(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** RFC2047 encoded-word for a header value containing non-ASCII characters. */
function encodeHeaderWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/**
 * Strip control characters (0x00-0x1F and 0x7F, which includes CR and LF)
 * from a value placed RAW on a header line. The recipient and threading
 * headers are derived from ATTACKER-CONTROLLED inbound headers (the
 * customer's own From / Reply-To / Message-ID), so a crafted value with an
 * embedded newline could otherwise inject additional headers into our
 * outgoing reply. Spaces, hyphens, angle brackets, "@", and "." are kept
 * (all legitimate in an address or a space-separated References chain).
 */
function stripHeaderControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c !== 0x7f) out += ch;
  }
  return out.trim();
}

/**
 * Encode a header value, RFC2047-wrapping only when it is not printable
 * ASCII. Control chars are collapsed to spaces first so an injected CRLF in
 * a model-produced subject can never escape the header line even on the
 * ASCII path.
 */
function encodeHeaderValue(text: string): string {
  let clean = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    clean += c < 0x20 || c === 0x7f ? " " : ch;
  }
  return isAsciiPrintable(clean) ? clean : encodeHeaderWord(clean);
}

/** Split a base64 payload into 76-char lines (RFC2045). */
function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

export interface ReplyFields {
  /** The From address the reply is sent as (the studio mailbox). */
  from: string;
  /** The recipient (the original sender / Reply-To). */
  to: string;
  subject: string;
  body: string;
  /** Original message's Message-ID header, for In-Reply-To + References. */
  inReplyTo?: string;
  /** Existing References chain to extend. */
  references?: string;
}

/**
 * Build a base64url-encoded RFC822 message for users.messages.send. The
 * body is sent as UTF-8 base64 (Content-Transfer-Encoding: base64) so any
 * content -- long lines, non-ASCII, emoji -- is transmitted losslessly and
 * within SMTP line limits. Threading headers (In-Reply-To, References) are
 * set from the original message so the reply lands in the same thread; the
 * caller also passes the Gmail threadId to send() for good measure.
 *
 * Every header value is hardened against injection: the subject is
 * encoded-word wrapped when non-ASCII (and control-collapsed either way),
 * and the raw-inserted values (from/to/threading) have control characters
 * stripped, so an attacker-controlled inbound header cannot smuggle extra
 * headers into the reply.
 */
export function buildRawReply(fields: ReplyFields): string {
  const from = stripHeaderControls(fields.from);
  const to = stripHeaderControls(fields.to);
  const inReplyTo = fields.inReplyTo
    ? stripHeaderControls(fields.inReplyTo)
    : undefined;
  const references = fields.references
    ? stripHeaderControls(fields.references)
    : undefined;

  const lines: string[] = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${encodeHeaderValue(fields.subject)}`);
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    // References = prior chain (if any) + the message being replied to.
    const refs = [references, inReplyTo]
      .filter((s): s is string => Boolean(s && s.trim()))
      .join(" ");
    if (refs) lines.push(`References: ${refs}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(wrap76(Buffer.from(fields.body, "utf8").toString("base64")));

  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/**
 * Best-effort extraction of a bare email address from a From/To header
 * value like `Jordan Lee <jordan@example.com>` -> `jordan@example.com`.
 * Returns the trimmed input when no angle-bracket address is present.
 */
export function extractAddress(headerValue: string | undefined): string {
  const v = (headerValue ?? "").trim();
  const m = v.match(/<([^>]+)>/);
  return (m?.[1] ?? v).trim();
}
