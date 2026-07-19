import assert from "node:assert/strict";

import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import { loadEnv } from "../env.js";
import type { GmailMessageResource } from "../gmail/parse.js";
import { emailDraft } from "../jobs/emailDraft.js";
import {
  createEmailHistoryToolset,
  EMAIL_HISTORY_BODY_MAX_CHARS,
  EMAIL_HISTORY_MAX_MESSAGES,
  emailHistoryAvailable,
  sanitizeEmailHistoryQuery,
  validHistorySender,
  type EmailHistoryClient,
} from "./emailHistory.js";
import type { KbRunLog } from "./kb.js";
import { TraceRecorder } from "./trace.js";

/**
 * Offline smoke for the sender-scoped search_email_history tool (GH-118).
 * Everything here is pure or mocked: the Gmail client is an injected
 * recording fake, config is driven through env vars restored afterwards,
 * and no mailbox, DB, or network is touched.
 *
 * The assertions cover the ticket's hard privacy constraint: the Gmail
 * query is ALWAYS bound to the server-side sender regardless of what the
 * model passes, the free-text query cannot smuggle Gmail operators, and
 * results are capped, quote-stripped, truncated, excluded of spam/trash/
 * drafts, and recorded on the run log + trace.
 *
 * Run: npm run smoke:emailhistory  (from packages/core)
 */

const SENDER = "jordan@example.com";

const GMAIL_VARS = [
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_USER",
] as const;

function withGmailEnv<T>(configured: boolean, fn: () => Promise<T>): Promise<T> {
  const saved = GMAIL_VARS.map((v) => [v, process.env[v]] as const);
  for (const v of GMAIL_VARS) {
    if (configured) process.env[v] = "smoke-placeholder";
    else delete process.env[v];
  }
  return fn().finally(() => {
    for (const [v, val] of saved) {
      if (val === undefined) delete process.env[v];
      else process.env[v] = val;
    }
  });
}

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function fakeMessage(
  id: string,
  opts?: { body?: string; labelIds?: string[]; subject?: string },
): GmailMessageResource {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: opts?.labelIds ?? ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `Jordan Lee <${SENDER}>` },
        { name: "Subject", value: opts?.subject ?? `Message ${id}` },
        { name: "Date", value: "Sat, 18 Jul 2026 10:00:00 -0700" },
      ],
      body: { data: b64url(opts?.body ?? `Body of ${id}`) },
    },
  };
}

interface Fake {
  client: EmailHistoryClient;
  queries: string[];
  fetched: string[];
}

function fakeClient(
  ids: string[],
  messages: Record<string, GmailMessageResource>,
): Fake {
  const queries: string[] = [];
  const fetched: string[] = [];
  return {
    queries,
    fetched,
    client: {
      async listMessageIds(query: string, max: number): Promise<string[]> {
        queries.push(query);
        return ids.slice(0, max);
      },
      async getMessage(id: string): Promise<GmailMessageResource> {
        fetched.push(id);
        const msg = messages[id];
        if (!msg) throw new Error(`no fake message ${id}`);
        return msg;
      },
    },
  };
}

function historyTool(
  tools: BetaRunnableTool<any>[],
): BetaRunnableTool<any> {
  const tool = tools.find((t) => t.name === "search_email_history");
  assert.ok(tool, "search_email_history tool present");
  return tool;
}

function emptyLog(): KbRunLog {
  return { sources: [], unavailable: false };
}

async function testUnconfiguredAbsent(): Promise<void> {
  await withGmailEnv(false, async () => {
    const { tools } = createEmailHistoryToolset(SENDER, emptyLog());
    assert.deepEqual(tools, [], "no tools when Gmail is unconfigured");
    assert.equal(emailHistoryAvailable(SENDER), false);
  });
  console.log("[smoke] email-history: absent when Gmail is unconfigured");
}

async function testInvalidSenderAbsent(): Promise<void> {
  await withGmailEnv(true, async () => {
    // A sender that could break out of the scope clause never gets a tool.
    const hostile = [
      "", // empty
      "no-at-sign",
      "a b@example.com", // whitespace
      'jordan"@example.com', // quote
      "jordan@example.com OR from:victim@example.com", // operator smuggling
      "jordan@example.com)", // paren
      "in:anywhere@x.com{", // brace
    ];
    for (const s of hostile) {
      assert.equal(validHistorySender(s), false, `rejects ${JSON.stringify(s)}`);
      const { tools } = createEmailHistoryToolset(s, emptyLog());
      assert.deepEqual(tools, [], `no tools for ${JSON.stringify(s)}`);
    }
    assert.equal(validHistorySender(SENDER), true);
    assert.equal(emailHistoryAvailable(SENDER), true);
  });
  console.log("[smoke] email-history: scope-unsafe sender means no tool at all");
}

async function testSenderBindingAndSanitization(): Promise<void> {
  await withGmailEnv(true, async () => {
    const fake = fakeClient(["m1"], { m1: fakeMessage("m1") });
    const log = emptyLog();
    const { tools } = createEmailHistoryToolset(SENDER, log, undefined, {
      client: fake.client,
    });
    const tool = historyTool(tools);

    // The model tries to smuggle a scope widener through the query.
    await tool.run({
      query: 'refund" OR from:victim@example.com (in:anywhere) {spam} -in:trash NOT hello',
    });
    assert.equal(fake.queries.length, 1);
    const q = fake.queries[0]!;
    assert.ok(
      q.startsWith(`(from:${SENDER} OR to:${SENDER}) -in:spam -in:trash -in:draft`),
      `query is scope-bound: ${q}`,
    );
    // No colon survives sanitization beyond our own operators, so no
    // field operator (from:/to:/in:) can be injected.
    const tail = q.slice(
      `(from:${SENDER} OR to:${SENDER}) -in:spam -in:trash -in:draft`.length,
    );
    assert.ok(!tail.includes(":"), `no operator colon in free text: ${tail}`);
    assert.ok(!tail.includes('"') && !tail.includes("(") && !tail.includes("{"));
    // Uppercase OR/AND/NOT are lowercased into plain terms.
    assert.ok(!/\b(OR|AND|NOT)\b/.test(tail), `no uppercase operators: ${tail}`);
    // Negation is disabled: no token in the free text starts with "-".
    assert.ok(
      tail.trim().split(/\s+/).every((t) => !t.startsWith("-")),
      `no negation tokens: ${tail}`,
    );

    // A queryless call is still scope-bound.
    await tool.run({});
    assert.ok(
      fake.queries[1]!.startsWith(`(from:${SENDER} OR to:${SENDER})`),
      "queryless call keeps the sender scope",
    );

    // Pure sanitizer checks.
    assert.equal(
      sanitizeEmailHistoryQuery('intro OFFER "special" (deal)'),
      "intro offer special deal",
    );
    assert.equal(sanitizeEmailHistoryQuery("-in:trash -secret"), "in trash secret");
    assert.equal(sanitizeEmailHistoryQuery("   "), "");
    assert.ok(sanitizeEmailHistoryQuery("x".repeat(500)).length <= 160);
  });
  console.log(
    "[smoke] email-history: sender bound server-side; query sanitized (no operators, no negation, capped)",
  );
}

async function testCapExclusionsTruncation(): Promise<void> {
  await withGmailEnv(true, async () => {
    const longBody =
      "New reply line before quoting.\n" +
      "A".repeat(EMAIL_HISTORY_BODY_MAX_CHARS + 400) +
      "\nOn Fri, 17 Jul 2026, Sealevel Hot Yoga wrote:\n> old quoted thread text";
    const messages: Record<string, GmailMessageResource> = {
      current: fakeMessage("current"),
      spam1: fakeMessage("spam1", { labelIds: ["SPAM"] }),
      trash1: fakeMessage("trash1", { labelIds: ["TRASH"] }),
      draft1: fakeMessage("draft1", { labelIds: ["DRAFT"] }),
      m1: fakeMessage("m1", { body: longBody, subject: "Long one" }),
      m2: fakeMessage("m2"),
      m3: fakeMessage("m3"),
      m4: fakeMessage("m4"),
      m5: fakeMessage("m5"),
      m6: fakeMessage("m6"),
    };
    // The current message id comes back first (newest); it must be
    // excluded WITHOUT an extra fetch, and the cap still fills from the
    // rest. spam/trash/draft come back too (as if the query operators
    // were ignored) and are dropped by the label check.
    const fake = fakeClient(
      ["current", "spam1", "trash1", "draft1", "m1", "m2", "m3", "m4", "m5", "m6"],
      messages,
    );
    const log = emptyLog();
    const recorder = new TraceRecorder();
    const { tools } = createEmailHistoryToolset(SENDER, log, recorder, {
      client: fake.client,
      excludeGmailId: "current",
    });
    const result = (await historyTool(tools).run({})) as string;

    assert.ok(!fake.fetched.includes("current"), "current message never fetched");
    assert.ok(!result.includes("Message current"), "current message not rendered");
    assert.ok(!result.includes("Message spam1"), "spam excluded");
    assert.ok(!result.includes("Message trash1"), "trash excluded");
    assert.ok(!result.includes("Message draft1"), "draft excluded");

    const rendered = (result.match(/^From: /gm) ?? []).length;
    assert.ok(
      rendered <= EMAIL_HISTORY_MAX_MESSAGES,
      `cap holds: ${rendered} <= ${EMAIL_HISTORY_MAX_MESSAGES}`,
    );
    assert.ok(result.includes("Subject: Long one"), "long message rendered");
    // Quote-stripping removed the quoted tail entirely.
    assert.ok(!result.includes("old quoted thread text"), "quoted reply stripped");
    // Truncation applied: the body was cut with the explicit marker.
    assert.ok(result.includes("[truncated:"), "over-budget body truncated");
    // Sources record the lookup and flag the truncation.
    assert.equal(log.sources.length, 1);
    assert.equal(log.sources[0]!.tool, "search_email_history");
    assert.equal(log.sources[0]!.ref, "(recent)");
    assert.equal(log.sources[0]!.truncated, true);
    // History failure semantics untouched: kb_unavailable stays false.
    assert.equal(log.unavailable, false);
    // Trace recorded like a KB call.
    const call = recorder.trace.calls.find((c) => c.tool === "search_email_history");
    assert.ok(call, "trace entry recorded");
    assert.equal(call.outcome, "ok");
    assert.ok((call.result_chars ?? 0) > 0);
  });
  console.log(
    "[smoke] email-history: cap, current/spam/trash/draft exclusion, quote-strip + truncation, sources + trace",
  );
}

async function testUnavailableDegradation(): Promise<void> {
  await withGmailEnv(true, async () => {
    const failing: EmailHistoryClient = {
      async listMessageIds(): Promise<string[]> {
        throw new Error("Gmail API GET /messages failed: HTTP 500");
      },
      async getMessage(): Promise<GmailMessageResource> {
        throw new Error("unreachable");
      },
    };
    const log = emptyLog();
    const recorder = new TraceRecorder();
    const { tools } = createEmailHistoryToolset(SENDER, log, recorder, {
      client: failing,
    });
    const result = (await historyTool(tools).run({ query: "intro offer" })) as string;
    assert.ok(
      result.includes("do not invent, assume, or reference any prior correspondence"),
      "unavailable note forbids invented history",
    );
    assert.ok(
      result.includes("Never reveal or reference this outage"),
      "unavailable note forbids gap narration",
    );
    assert.ok(!result.includes("—"), "no em dashes in the note");
    // The failed lookup is still recorded for the approving human.
    assert.equal(log.sources.length, 1);
    assert.equal(log.sources[0]!.ref, "intro offer");
    // kb_unavailable specifically means the KB failed; untouched here.
    assert.equal(log.unavailable, false);
    const call = recorder.trace.calls.find((c) => c.tool === "search_email_history");
    assert.ok(call, "trace entry recorded on failure");
    assert.equal(call.outcome, "error");
    assert.ok(recorder.trace.degraded.includes("email-history-unavailable"));
  });
  console.log(
    "[smoke] email-history: failure degrades to the no-narration unavailable note",
  );
}

async function testEmptyResult(): Promise<void> {
  await withGmailEnv(true, async () => {
    const fake = fakeClient([], {});
    const recorder = new TraceRecorder();
    const { tools } = createEmailHistoryToolset(SENDER, emptyLog(), recorder, {
      client: fake.client,
    });
    const result = (await historyTool(tools).run({})) as string;
    assert.equal(result, "(no prior email history found with this sender)");
    const call = recorder.trace.calls.find((c) => c.tool === "search_email_history");
    assert.equal(call?.outcome, "empty");
  });
  console.log("[smoke] email-history: empty history is an honest empty result");
}

async function testDraftJobWiring(): Promise<void> {
  await withGmailEnv(true, async () => {
    // The drafting job registers the tool (bound to the inbound sender)
    // when Gmail is configured; toolset construction is offline.
    const ctx = {
      payload: { from: `Jordan Lee <${SENDER}>`, gmailId: "gm-1" },
      runState: {},
    };
    const tools = emailDraft.runtimeTools!(ctx);
    assert.ok(
      tools.some((t) => t.name === "search_email_history"),
      "emailDraft runtimeTools includes search_email_history",
    );
    const recorder = (ctx.runState as Record<string, unknown>)["trace"];
    assert.ok(recorder instanceof TraceRecorder);
    assert.ok(
      recorder.trace.toolset.includes("search_email_history"),
      "trace toolset registers the history tool",
    );
  });
  await withGmailEnv(false, async () => {
    const ctx = { payload: { from: `Jordan Lee <${SENDER}>` }, runState: {} };
    const tools = emailDraft.runtimeTools!(ctx);
    assert.ok(
      !tools.some((t) => t.name === "search_email_history"),
      "no history tool when Gmail is unconfigured",
    );
  });
  console.log(
    "[smoke] email-history: emailDraft wiring registers the tool only when Gmail is configured",
  );
}

async function main(): Promise<void> {
  loadEnv();
  await testUnconfiguredAbsent();
  await testInvalidSenderAbsent();
  await testSenderBindingAndSanitization();
  await testCapExclusionsTruncation();
  await testUnavailableDegradation();
  await testEmptyResult();
  await testDraftJobWiring();
  console.log("[smoke] email-history: all offline assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
