import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";

import { truncateForPrompt } from "../brain/budget.js";
import { gmailClient } from "../gmail/client.js";
import { gmailConfigured } from "../gmail/config.js";
import {
  parseGmailMessage,
  stripQuotedReply,
  type GmailMessageResource,
} from "../gmail/parse.js";
import type { KbRunLog, KbSource } from "./kb.js";
import type { TraceRecorder } from "./trace.js";

/**
 * Sender-scoped email history tool for the drafting job (GH-118).
 *
 * The mailbox holds other customers' PII and internal business mail, so an
 * open inbox search from the drafting model could leak customer A's details
 * into customer B's reply. The privacy design is therefore structural, not
 * prompt-hope:
 *
 * - The tool takes NO recipient/sender input of any kind. The sender
 *   identity is bound here, server-side, from the inbound email being
 *   drafted (the closure over `sender`); the model can only pass an
 *   optional free-text query.
 * - Every Gmail query this module issues starts with the bound scope
 *   clause `(from:<sender> OR to:<sender>)`, so results are restricted to
 *   correspondence with that one address. Nothing else is searchable.
 * - The free-text query is sanitized so it cannot break out of that scope:
 *   it is lowercased (Gmail's OR/AND/NOT operators only bind uppercase, so
 *   they become plain search terms) and stripped to a conservative
 *   character set (letters, digits, spaces, and . , ' @) that excludes
 *   every Gmail operator/grouping character (: " ( ) { } -). Token-leading
 *   hyphens are also dropped so negation is disabled outright. A term can
 *   therefore only NARROW the sender-scoped result set, never widen it.
 * - The sender itself is validated against a strict address shape before
 *   any tool is built; a From header crafted to smuggle operators through
 *   the scope clause fails validation and the toolset is simply absent.
 * - Spam, trash, and drafts are excluded, both in the query (-in:spam
 *   -in:trash -in:draft) and by label check on each fetched message.
 *
 * Config-gated on gmailConfigured() and gracefully degrading exactly like
 * the KB toolset (tools/kb.ts): absent when Gmail is unconfigured, and a
 * runtime failure returns an "unavailable" note that tells the model not
 * to invent history and never to narrate the outage (the #123/#129
 * posture). Every call is recorded in the shared run log (payload.sources,
 * shown to the approving human) and on the GH-122 trace recorder.
 */

/** Max prior messages returned per lookup. */
export const EMAIL_HISTORY_MAX_MESSAGES = 5;

/** Per-message body budget after quote-stripping (~150 tokens). */
export const EMAIL_HISTORY_BODY_MAX_CHARS = 600;

/** Cap on the sanitized free-text query passed into the Gmail search. */
export const EMAIL_HISTORY_QUERY_MAX_CHARS = 160;

/**
 * Strict shape a sender address must match before any history tool is
 * built. Deliberately narrower than RFC 5322: no whitespace, quotes,
 * colons, parens, or braces means the address cannot terminate or extend
 * the `(from:... OR to:...)` scope clause it is interpolated into.
 */
const SENDER_RE = /^[A-Za-z0-9._%+='/-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** True when `sender` is safe to bind into a Gmail scope clause. */
export function validHistorySender(sender: string | undefined): boolean {
  return typeof sender === "string" && SENDER_RE.test(sender);
}

/**
 * Whether search_email_history will be available for a run: Gmail is
 * configured AND the inbound sender address is scope-safe. Used by the
 * drafting job to gate the prompt guidance alongside the toolset.
 */
export function emailHistoryAvailable(sender: string | undefined): boolean {
  return gmailConfigured() && validHistorySender(sender);
}

/**
 * Sanitize the model's free-text query for safe inclusion in the Gmail
 * search. Conservative by design (documented in the module header):
 * lowercase; keep only letters, digits, spaces, and . , ' @ ; drop
 * token-leading hyphens; collapse whitespace; cap the length. Everything
 * a Gmail operator needs (colon, quotes, parens, braces, uppercase
 * OR/AND/NOT, negation) is removed, so the result can only add plain
 * AND-ed search terms inside the sender scope.
 */
export function sanitizeEmailHistoryQuery(query: string): string {
  const kept = query
    .toLowerCase()
    .replace(/[^a-z0-9 .,'@-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^-+/, ""))
    .filter((token) => token.length > 0)
    .join(" ");
  return kept.slice(0, EMAIL_HISTORY_QUERY_MAX_CHARS).trim();
}

/** The Gmail surface this module needs; injectable for offline smokes. */
export interface EmailHistoryClient {
  listMessageIds(query: string, max: number): Promise<string[]>;
  getMessage(id: string): Promise<GmailMessageResource>;
}

/** Optional knobs for one run's toolset. */
export interface EmailHistoryOptions {
  /** Gmail id of the inbound message being drafted; excluded from results. */
  excludeGmailId?: string;
  /** Client override for tests; defaults to the shared gmailClient(). */
  client?: EmailHistoryClient;
}

/** Labels that disqualify a fetched message (belt and braces vs the query). */
const EXCLUDED_LABELS = new Set(["SPAM", "TRASH", "DRAFT"]);

const UNAVAILABLE_NOTE =
  "Prior email history is unavailable right now. Draft from the inbound email itself; do not invent, assume, or reference any prior correspondence, promises, or history with this sender. Never reveal or reference this outage to the customer: no mention of systems, tools, records, or your own knowledge or access, and no promises to follow up. Answer what the inbound email and your other sources support, and nothing more.";

/** Render one prior message as a compact text block. */
function renderMessage(msg: GmailMessageResource): {
  text: string;
  truncated: boolean;
} {
  const parsed = parseGmailMessage(msg);
  const rawBody = stripQuotedReply(parsed.body ?? "");
  const body = truncateForPrompt(
    rawBody,
    EMAIL_HISTORY_BODY_MAX_CHARS,
    "email history message body",
  );
  const text = [
    `From: ${parsed.from ?? "(unknown)"}`,
    `Date: ${parsed.date ?? "(unknown date)"}`,
    `Subject: ${parsed.subject ?? "(no subject)"}`,
    "",
    body.length > 0 ? body : "(empty body)",
  ].join("\n");
  return { text, truncated: rawBody.length > EMAIL_HISTORY_BODY_MAX_CHARS };
}

/**
 * Build the per-run email history toolset, bound to `sender`. Returns no
 * tools when Gmail is unconfigured or the sender fails scope validation.
 * Lookups are recorded into the SHARED run log (the same KbRunLog the KB
 * toolset writes), so payload.sources shows the approving human exactly
 * what history informed the draft. A failed lookup degrades to the
 * unavailable note and flags the trace ("email-history-unavailable"); it
 * does NOT set log.unavailable, which specifically means "a knowledge
 * base call failed" (payload.kb_unavailable).
 */
export function createEmailHistoryToolset(
  sender: string,
  log: KbRunLog,
  recorder?: TraceRecorder,
  options?: EmailHistoryOptions,
): { tools: BetaRunnableTool<any>[] } {
  if (!gmailConfigured() || !validHistorySender(sender)) return { tools: [] };

  const run = async (query?: string): Promise<string> => {
    const sanitized = query ? sanitizeEmailHistoryQuery(query) : "";
    const ref = sanitized.length > 0 ? sanitized : "(recent)";
    // Recorded on the shared run log structurally (rides the tool call,
    // never the prompt), exactly like a KB lookup. The bound sender is
    // deliberately NOT recorded here: sources land on the item payload
    // and the address is already visible in original_email.
    const source: KbSource = {
      tool: "search_email_history",
      ref,
      at: new Date().toISOString(),
    };
    log.sources.push(source);
    console.log(`[email-history] search: ${ref}`);
    const started = Date.now();
    try {
      // The scope clause comes first and is ANDed with everything after
      // it; the sanitized free text can only narrow the result set.
      let q = `(from:${sender} OR to:${sender}) -in:spam -in:trash -in:draft`;
      if (sanitized.length > 0) q += ` ${sanitized}`;

      const client = options?.client ?? gmailClient();
      // Headroom on the id list so excluding the current message (a free
      // id comparison, no extra fetch) still leaves a full result set.
      const ids = (await client.listMessageIds(q, EMAIL_HISTORY_MAX_MESSAGES + 3))
        .filter((id) => id !== options?.excludeGmailId);

      const blocks: string[] = [];
      let anyTruncated = false;
      for (const id of ids) {
        if (blocks.length >= EMAIL_HISTORY_MAX_MESSAGES) break;
        const msg = await client.getMessage(id);
        // Belt and braces: the query already excludes spam/trash/drafts,
        // but a label check on the fetched resource makes the exclusion
        // hold even if the query operator is ever ignored.
        if ((msg.labelIds ?? []).some((l) => EXCLUDED_LABELS.has(l))) continue;
        const rendered = renderMessage(msg);
        blocks.push(rendered.text);
        anyTruncated ||= rendered.truncated;
      }

      const result =
        blocks.length === 0
          ? "(no prior email history found with this sender)"
          : [
              `Prior correspondence with this sender (newest first, up to ${EMAIL_HISTORY_MAX_MESSAGES} messages, bodies may be shortened):`,
              ...blocks,
            ].join("\n---\n");
      if (anyTruncated) source.truncated = true;
      try {
        recorder?.record({
          tool: "search_email_history",
          ref,
          // Args (GH-128): the sanitized free text only. The bound sender
          // is deliberately not recorded, same as the run-log note above.
          // Eval capture never replays this tool (privacy exclusion), so
          // the args are purely diagnostic.
          args: sanitized.length > 0 ? { query: sanitized } : {},
          outcome: blocks.length === 0 ? "empty" : "ok",
          resultChars: result.length,
          durationMs: Date.now() - started,
        });
      } catch {
        // Trace capture must never fail the lookup.
      }
      return result;
    } catch (err) {
      try {
        recorder?.record({
          tool: "search_email_history",
          ref,
          args: sanitized.length > 0 ? { query: sanitized } : {},
          outcome: "error",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        });
        recorder?.degrade("email-history-unavailable");
      } catch {
        // Trace capture must never fail the lookup.
      }
      console.warn(
        `[email-history] search failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return UNAVAILABLE_NOTE;
    }
  };

  const searchEmailHistory = betaZodTool({
    name: "search_email_history",
    description:
      "Search prior email correspondence between the studio and the sender of the email you are drafting a reply to. Scoped to this one sender; it can never return other people's mail. Returns up to 5 recent messages (newest first) with from/date/subject and a shortened body. Use it to stay consistent with what was previously told to this sender; optionally narrow with a few plain search words.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Optional plain search words to narrow the history, e.g. 'intro offer' or 'refund'. Leave empty for the most recent correspondence.",
        ),
    }),
    run: ({ query }) => run(query),
  });

  return { tools: [searchEmailHistory] };
}

/**
 * Guidance appended to the drafting instructions when the history tool is
 * available (gated with emailHistoryAvailable, like KB_PROMPT_GUIDANCE).
 */
export const EMAIL_HISTORY_PROMPT_GUIDANCE = `
You also have a search_email_history tool: prior email correspondence between the studio and THIS sender only.
- Use it when past correspondence could matter: a returning customer, a reference to an earlier conversation, or anything the studio may already have told them. Stay consistent with what was previously said to this sender.
- It is strictly scoped to this one sender. Never quote or reference other customers or other conversations in a reply.
- If it returns nothing, draft from the inbound email alone and do not mention having checked, searched, or looked anything up.`;
