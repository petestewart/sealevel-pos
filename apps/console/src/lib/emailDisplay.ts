/**
 * Display helpers for rendering email_reply items as formatted email
 * (Console.dc.html approvals spec). Pure functions, shared by the
 * approvals page (server) and the approval card (client).
 */

/** Studio timezone; the console renders times as Seattle wall-clock. */
const TIME_ZONE = "America/Los_Angeles";

export interface Sender {
  name: string;
  email: string | null;
}

/** Turn an email local part like "jordan.p_smith" into "Jordan P Smith". */
function nameFromLocalPart(localPart: string): string {
  const words = localPart
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || localPart;
}

/**
 * Derive a display name from an email From value: `"Jane Doe" <j@x.com>`,
 * `Jane Doe <j@x.com>`, or a bare address. Falls back to a prettified
 * local part, then to the raw string.
 */
export function parseSender(from: string | undefined | null): Sender {
  if (!from || from.trim().length === 0) {
    return { name: "Unknown sender", email: null };
  }
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1]!.trim();
    const email = match[2]!.trim();
    return { name: name.length > 0 ? name : senderNameFromAddress(email), email };
  }
  const bare = from.trim();
  if (bare.includes("@")) {
    return { name: senderNameFromAddress(bare), email: bare };
  }
  return { name: bare, email: null };
}

function senderNameFromAddress(email: string): string {
  const localPart = email.split("@")[0] ?? email;
  return nameFromLocalPart(localPart);
}

/** First letters of the first two words, uppercased ("Devon Park" -> "DP"). */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
}

/** Split an email body into paragraphs on blank lines. */
export function paragraphsOf(body: string): string[] {
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** "8:52 AM" in studio time. */
export function formatTime(at: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(at);
}

/** "Jul 9, 2026 · 8:52 AM" in studio time. */
export function formatDateTime(at: Date): string {
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(at);
  return `${date} · ${formatTime(at)}`;
}

/** Time only when the moment is today (studio time), else date + time. */
export function formatDecidedAt(at: Date, now: Date = new Date()): string {
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: TIME_ZONE,
    }).format(d);
  return dayOf(at) === dayOf(now) ? formatTime(at) : formatDateTime(at);
}

/** "email_reply" -> "Email reply" (intent-chip fallback per GH-22). */
export function humanizeType(type: string): string {
  const words = type.split(/[_\-\s]+/).filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
