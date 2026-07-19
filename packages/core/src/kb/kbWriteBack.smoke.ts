import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  detectKbUpdateProposal,
  kbUpdateDetectionEnabled,
  maybeProposeKbUpdate,
  type KbDetectorDeps,
} from "../brain/kbUpdate.js";
import {
  buildKbRevertPayload,
  buildKbUpdatePayload,
  kbProposalOf,
  kbWriteOf,
  sha256Hex,
  type KbWriteRecord,
} from "../db/kbItems.js";
import type { Item } from "../db/items.js";
import { loadEnv } from "../env.js";
import { kbWriteJobId } from "../queue/enqueue.js";
import { KbClient } from "../tools/kb.js";
import { writeApprovedKbUpdate } from "./write.js";

/**
 * Offline smoke for the KB write-back loop (GH-111/GH-112/GH-113).
 * Everything here is pure, injected, or served by a local mock MCP
 * endpoint: no API key, DB, Redis, or real MCP server is touched.
 *
 * Run: npm run smoke:kbwriteback  (from packages/core)
 */

const KB_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "SEALEVEL_MCP_URL",
  "SEALEVEL_MCP_TOKEN",
  "SEALEVEL_MCP_KB_WRITER_TOKEN",
] as const;

function withEnv<T>(
  values: Partial<Record<(typeof KB_ENV_VARS)[number], string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = KB_ENV_VARS.map((v) => [v, process.env[v]] as const);
  for (const v of KB_ENV_VARS) {
    const value = values[v];
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
  return fn().finally(() => {
    for (const [v, val] of saved) {
      if (val === undefined) delete process.env[v];
      else process.env[v] = val;
    }
  });
}

/** Scripted detector deps: each runTool call shifts the next response. */
function scriptedDeps(
  toolResponses: Array<Record<string, unknown> | Error>,
  kbReads: Record<string, string | Error>,
): KbDetectorDeps & { toolCalls: string[]; kbCalls: string[] } {
  const toolCalls: string[] = [];
  const kbCalls: string[] = [];
  return {
    toolCalls,
    kbCalls,
    runTool: async (req) => {
      toolCalls.push(req.toolName);
      const next = toolResponses.shift();
      if (next === undefined) throw new Error("no scripted response left");
      if (next instanceof Error) throw next;
      return next;
    },
    kbRead: async (tool, args) => {
      const key = `${tool}:${String(args["query"] ?? args["name"] ?? "")}`;
      kbCalls.push(key);
      const result = kbReads[key] ?? kbReads[tool];
      if (result === undefined) throw new Error(`no scripted kb read for ${key}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const EMAIL = {
  from: "Pete Stewart <pete@sealevelhotyoga.com>",
  subject: "Parking correction",
  body: "The lot behind the studio is now free for students for 2 hours.",
  messageId: "<msg-1@mail.example>",
  gmailId: "gm-1",
  threadId: "th-1",
};

async function testDetectionGate(): Promise<void> {
  // Without key/KB env the detector is simply absent.
  await withEnv({}, async () => {
    assert.equal(kbUpdateDetectionEnabled(), false);
    assert.equal(await maybeProposeKbUpdate(EMAIL, "42"), null);
  });
  // Key alone is not enough: the detector needs the KB read connection.
  await withEnv({ ANTHROPIC_API_KEY: "sk-smoke" }, async () => {
    assert.equal(kbUpdateDetectionEnabled(), false);
  });
  await withEnv(
    {
      ANTHROPIC_API_KEY: "sk-smoke",
      SEALEVEL_MCP_URL: "https://kb.example",
      SEALEVEL_MCP_TOKEN: "tok",
    },
    async () => {
      assert.equal(kbUpdateDetectionEnabled(), true);
    },
  );
  console.log("[smoke] kb-detect: config gate (key AND KB connection required)");
}

async function testDetectorFailureIsHarmless(): Promise<void> {
  // A detector whose model call explodes must resolve null, never throw:
  // the email draft (already filed when the hook runs) is unaffected.
  const deps = scriptedDeps([new Error("api down")], {});
  const result = await maybeProposeKbUpdate(EMAIL, "42", undefined, deps);
  assert.equal(result, null);
  // Same for a KB outage mid-chain.
  const deps2 = scriptedDeps(
    [
      {
        found: true,
        confidence: 0.95,
        fact: "Parking behind the studio is free for 2 hours.",
        search_query: "parking",
      },
    ],
    { search_wiki: new Error("kb down") },
  );
  assert.equal(await maybeProposeKbUpdate(EMAIL, "42", undefined, deps2), null);
  console.log(
    "[smoke] kb-detect: chain failures resolve to no proposal (draft unaffected)",
  );
}

async function testDetectorNegativesAndGuards(): Promise<void> {
  // found=false ends after ONE call: the common case costs one screen.
  const notFound = scriptedDeps(
    [{ found: false, confidence: 0.1, fact: "", search_query: "" }],
    {},
  );
  assert.equal(await detectKbUpdateProposal(EMAIL, notFound), null);
  assert.deepEqual(notFound.toolCalls, ["flag_kb_update"]);
  assert.deepEqual(notFound.kbCalls, [], "no KB reads on a negative");

  // Below the confidence floor: precision over recall.
  const lowConf = scriptedDeps(
    [{ found: true, confidence: 0.5, fact: "x", search_query: "x" }],
    {},
  );
  assert.equal(await detectKbUpdateProposal(EMAIL, lowConf), null);

  // Denylist: a proposal targeting a schedule/pricing page is dropped
  // client-side (the server would refuse it again at write time).
  const denylisted = scriptedDeps(
    [
      { found: true, confidence: 0.9, fact: "f", search_query: "q" },
      { target_page: "class-pricing-notes", change_kind: "edit" },
    ],
    { search_wiki: "pages: class-pricing-notes" },
  );
  assert.equal(await detectKbUpdateProposal(EMAIL, denylisted), null);
  console.log(
    "[smoke] kb-detect: negative, low-confidence, and denylisted targets file nothing",
  );
}

async function testDetectorHappyPaths(): Promise<void> {
  const base = "# Parking\n\nPaid parking only.\n";
  const proposed = "# Parking\n\nThe lot behind the studio is free for 2 hours.\n";
  const editDeps = scriptedDeps(
    [
      {
        found: true,
        confidence: 0.92,
        fact: "Parking behind the studio is free for students for 2 hours.",
        search_query: "parking",
      },
      { target_page: "Parking.md", change_kind: "edit" },
      {
        proposed_content: proposed,
        summary: "Update parking to note the free 2 hour lot",
        rationale: "Pete stated the new parking rule in his email.",
      },
    ],
    { "search_wiki:parking": "## parking\nPaid parking only.", "read_wiki_page:parking": base },
  );
  const detection = await detectKbUpdateProposal(EMAIL, editDeps);
  assert.ok(detection, "edit proposal produced");
  assert.equal(detection.proposal.target_page, "parking", "normalized name");
  assert.equal(detection.proposal.change_kind, "edit");
  assert.equal(detection.proposal.base_content, base);
  assert.equal(detection.proposal.base_hash, sha256Hex(base), "base hash");
  assert.equal(detection.proposal.proposed_content, proposed);
  assert.equal(detection.confidence, 0.92);

  // New page: empty base, empty hash (the server then requires the page
  // not to exist, so a stale read can never clobber an existing page).
  const newDeps = scriptedDeps(
    [
      { found: true, confidence: 0.9, fact: "f", search_query: "towels" },
      { target_page: "towel-service", change_kind: "new_page" },
      { proposed_content: "# Towels\n\nTowels rent for $2.\n", summary: "s", rationale: "r" },
    ],
    { search_wiki: "(no results)" },
  );
  const created = await detectKbUpdateProposal(EMAIL, newDeps);
  assert.ok(created);
  assert.equal(created.proposal.change_kind, "new_page");
  assert.equal(created.proposal.base_content, "");
  assert.equal(created.proposal.base_hash, "");

  // An "edit" whose page read comes back empty downgrades to new_page.
  const missingDeps = scriptedDeps(
    [
      { found: true, confidence: 0.9, fact: "f", search_query: "q" },
      { target_page: "mat-rental", change_kind: "edit" },
      { proposed_content: "# Mats\n", summary: "s", rationale: "r" },
    ],
    { search_wiki: "x", read_wiki_page: "" },
  );
  const downgraded = await detectKbUpdateProposal(EMAIL, missingDeps);
  assert.ok(downgraded);
  assert.equal(downgraded.proposal.change_kind, "new_page");
  assert.equal(downgraded.proposal.base_hash, "");

  // No-change edits are dropped: nothing for a human to review.
  const sameDeps = scriptedDeps(
    [
      { found: true, confidence: 0.9, fact: "f", search_query: "q" },
      { target_page: "parking", change_kind: "edit" },
      { proposed_content: base, summary: "s", rationale: "r" },
    ],
    { search_wiki: "x", read_wiki_page: base },
  );
  assert.equal(await detectKbUpdateProposal(EMAIL, sameDeps), null);

  // Oversized base: refuse rather than propose over a truncated page.
  const bigBase = "line\n".repeat(6000);
  const bigDeps = scriptedDeps(
    [
      { found: true, confidence: 0.9, fact: "f", search_query: "q" },
      { target_page: "history", change_kind: "edit" },
    ],
    { search_wiki: "x", read_wiki_page: bigBase },
  );
  assert.equal(await detectKbUpdateProposal(EMAIL, bigDeps), null);
  console.log(
    "[smoke] kb-detect: edit/new-page/downgrade proposals form correctly; no-change and oversized bases refuse",
  );
}

function testProposalPayloadShape(): void {
  const base = "# Parking\nold\n";
  const payload = buildKbUpdatePayload({
    proposal: {
      target_page: "Parking.md",
      change_kind: "edit",
      base_content: base,
      base_hash: sha256Hex(base),
      proposed_content: "# Parking\nnew\n",
      summary: "Update parking",
      rationale: "Pete said so.",
    },
    source: {
      item_id: "42",
      message_id: "<msg-1@mail.example>",
      gmail_id: "gm-1",
      thread_id: "th-1",
      from: EMAIL.from,
      subject: EMAIL.subject,
    },
    confidence: 0.92,
    now: "2026-07-19T00:00:00.000Z",
  });
  assert.equal(payload["target_page"], "parking", "name normalized");
  assert.equal(payload["visibility_intent"], "internal", "fail-closed default");
  const source = payload["source"] as Record<string, unknown>;
  assert.equal(source["item_id"], "42", "source item stamped structurally");
  assert.equal(source["message_id"], "<msg-1@mail.example>");
  const detector = payload["detector"] as Record<string, unknown>;
  assert.equal(detector["confidence"], 0.92);
  assert.ok("generated_by" in payload, "version stamp present");
  assert.ok(!("decision" in payload), "born undecided");
  assert.ok(!("kb_write" in payload), "born unwritten");
  // Round-trips through the validator both sides read.
  const proposal = kbProposalOf(payload);
  assert.ok(proposal);
  assert.equal(proposal.base_hash, sha256Hex(base));
  // Malformed payloads validate to null, never crash.
  assert.equal(kbProposalOf({}), null);
  assert.equal(
    kbProposalOf({ ...payload, proposed_content: "" }),
    null,
    "empty content refuses",
  );
  assert.equal(kbWriteOf(payload), null, "no kb_write yet");
  console.log("[smoke] kb-items: proposal payload shape + validators");
}

/** A resolved, approved kb_update item fixture for the write job. */
function approvedItem(
  overrides: Partial<Record<string, unknown>> = {},
): Item {
  const base = "# Parking\nold\n";
  return {
    id: "77",
    type: "kb_update",
    domain: "knowledge",
    status: "resolved",
    audience: null,
    assignee: null,
    created_at: new Date("2026-07-19T00:00:00Z"),
    resolved_at: new Date("2026-07-19T01:00:00Z"),
    payload: {
      target_page: "parking",
      change_kind: "edit",
      base_content: base,
      base_hash: sha256Hex(base),
      proposed_content: "# Parking\nnew\n",
      summary: "Update parking",
      rationale: "Pete said so.",
      visibility_intent: "internal",
      source: { item_id: "42", message_id: "<msg-1@mail.example>" },
      decision: {
        action: "approved",
        by: { id: "user_1", name: "Pete" },
        at: "2026-07-19T01:00:00.000Z",
        edited: false,
      },
      kb_write: { status: "queued", at: "2026-07-19T01:00:01.000Z" },
      ...overrides,
    },
  } as Item;
}

/**
 * Minimal mock MCP endpoint speaking just enough Streamable HTTP for
 * KbClient: initialize returns a session id; each tools/call pops the
 * next scripted result payload.
 */
function mockMcpServer(results: Array<Record<string, unknown>>): Promise<{
  server: Server;
  url: string;
  calls: Array<Record<string, unknown>>;
}> {
  const calls: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        method?: string;
        params?: { arguments?: Record<string, unknown> };
      };
      if (parsed.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "smoke-session",
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
        return;
      }
      calls.push(parsed.params?.arguments ?? {});
      const next = results.shift() ?? { status: "error", error: "no script" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [{ type: "text", text: JSON.stringify(next, null, 2) }],
          },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, calls });
    });
  });
}

async function testWriteJobAgainstMockedServer(): Promise<void> {
  const newHash = sha256Hex("# Parking\nnew\n");

  // SUCCESS: the server reports written; the item records written + hash,
  // and the tool call carried the proposal + provenance from the row.
  {
    const { server, url, calls } = await mockMcpServer([
      { status: "written", page: "parking", hash: newHash },
    ]);
    const recorded: Array<Omit<KbWriteRecord, "at">> = [];
    const client = new KbClient(url, "writer-tok");
    const result = await writeApprovedKbUpdate("77", {
      configured: true,
      loadItem: async () => approvedItem(),
      record: async (_id, rec) => void recorded.push(rec),
      callTool: (name, args) => client.callTool(name, args),
    });
    server.close();
    assert.equal(result.status, "written");
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0], { status: "written", new_hash: newHash });
    const args = calls[0]!;
    assert.equal(args["name"], "parking");
    assert.equal(args["base_hash"], sha256Hex("# Parking\nold\n"));
    const provenance = args["provenance"] as Record<string, unknown>;
    assert.equal(provenance["approved_by"], "Pete (user_1)");
    assert.ok(
      String(provenance["source_ref"]).includes("kb_update item 77"),
      "provenance carries the item id",
    );
    assert.ok(
      String(provenance["source_ref"]).includes("<msg-1@mail.example>"),
      "provenance carries the source email",
    );
  }

  // STALE: a conflict records an honest stale outcome and does not throw
  // (a retry would hit the same guard; recovery is a fresh proposal).
  {
    const { server, url } = await mockMcpServer([
      { status: "conflict", page: "parking", error: "Stale base_hash", current_hash: "abc" },
    ]);
    const recorded: Array<Omit<KbWriteRecord, "at">> = [];
    const client = new KbClient(url, "writer-tok");
    const result = await writeApprovedKbUpdate("77", {
      configured: true,
      loadItem: async () => approvedItem(),
      record: async (_id, rec) => void recorded.push(rec),
      callTool: (name, args) => client.callTool(name, args),
    });
    server.close();
    assert.equal(result.status, "stale");
    assert.equal(recorded[0]?.status, "stale");
    assert.ok(recorded[0]?.error?.includes("Stale"));
  }

  // DENIED: protected page / identity refusal records denied, no throw.
  {
    const { server, url } = await mockMcpServer([
      { status: "denied", error: "Schedule and pricing pages cannot be written" },
    ]);
    const recorded: Array<Omit<KbWriteRecord, "at">> = [];
    const client = new KbClient(url, "writer-tok");
    const result = await writeApprovedKbUpdate("77", {
      configured: true,
      loadItem: async () => approvedItem(),
      record: async (_id, rec) => void recorded.push(rec),
      callTool: (name, args) => client.callTool(name, args),
    });
    server.close();
    assert.equal(result.status, "denied");
    assert.equal(recorded[0]?.status, "denied");
  }

  // SERVER ERROR: records failed and THROWS so BullMQ retries.
  {
    const { server, url } = await mockMcpServer([
      { status: "error", error: "wiki_pages table is missing" },
    ]);
    const recorded: Array<Omit<KbWriteRecord, "at">> = [];
    const client = new KbClient(url, "writer-tok");
    await assert.rejects(
      writeApprovedKbUpdate("77", {
        configured: true,
        loadItem: async () => approvedItem(),
        record: async (_id, rec) => void recorded.push(rec),
        callTool: (name, args) => client.callTool(name, args),
      }),
      /wiki_pages table is missing/,
    );
    server.close();
    assert.equal(recorded[0]?.status, "failed");
  }

  console.log(
    "[smoke] kb-write: written/stale/denied recorded honestly; server errors throw for retry",
  );
}

async function testWriteJobGates(): Promise<void> {
  // Unconfigured writer: the decision stands, the item records an honest
  // skipped, and NO tool call happens.
  const recorded: Array<Omit<KbWriteRecord, "at">> = [];
  const result = await writeApprovedKbUpdate("77", {
    configured: false,
    loadItem: async () => approvedItem(),
    record: async (_id, rec) => void recorded.push(rec),
    callTool: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(result.status, "skipped");
  assert.equal(recorded[0]?.status, "skipped");
  assert.ok(recorded[0]?.error?.includes("SEALEVEL_MCP_KB_WRITER_TOKEN"));

  // Already written: idempotent no-op (a BullMQ retry after success).
  const already = await writeApprovedKbUpdate("77", {
    configured: true,
    loadItem: async () =>
      approvedItem({
        kb_write: { status: "written", at: "x", new_hash: "h" },
      }),
    record: async () => {
      throw new Error("must not re-record");
    },
    callTool: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(already.status, "already_written");

  // Reopened/rejected since enqueue: nothing to write, nothing recorded.
  const reopened = await writeApprovedKbUpdate("77", {
    configured: true,
    loadItem: async () => ({ ...approvedItem(), status: "pending_approval" }),
    record: async () => {
      throw new Error("must not record");
    },
    callTool: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(reopened.status, "not_writable");
  console.log(
    "[smoke] kb-write: unconfigured skips honestly; written/reopened items are never re-written",
  );
}

function testRevertProposal(): void {
  const written = approvedItem({
    kb_write: {
      status: "written",
      at: "2026-07-19T01:00:02.000Z",
      new_hash: sha256Hex("# Parking\nnew\n"),
    },
  });
  const payload = buildKbRevertPayload(written, "2026-07-19T02:00:00.000Z");
  assert.ok(payload, "revert payload produced");
  const proposal = kbProposalOf(payload);
  assert.ok(proposal);
  assert.equal(proposal.target_page, "parking");
  assert.equal(proposal.change_kind, "edit");
  // The revert diffs against what the write committed and proposes the
  // prior content back.
  assert.equal(proposal.base_content, "# Parking\nnew\n");
  assert.equal(proposal.base_hash, sha256Hex("# Parking\nnew\n"));
  assert.equal(proposal.proposed_content, "# Parking\nold\n");
  const source = payload["source"] as Record<string, unknown>;
  assert.equal(source["revert_of_item_id"], "77", "provenance chains to the write");
  assert.ok(!("decision" in payload), "revert is born undecided");

  // Not revertable: never written, or the page did not exist before.
  assert.equal(buildKbRevertPayload(approvedItem()), null, "queued != written");
  assert.equal(
    buildKbRevertPayload(
      approvedItem({
        base_content: "",
        base_hash: "",
        change_kind: "new_page",
        kb_write: { status: "written", at: "x" },
      }),
    ),
    null,
    "a created page has no prior content to restore",
  );
  assert.equal(
    buildKbRevertPayload({ ...approvedItem(), type: "email_reply" } as Item),
    null,
  );
  console.log(
    "[smoke] kb-revert: proposal restores prior content through the same gate; non-writes refuse",
  );
}

function testJobId(): void {
  assert.equal(kbWriteJobId("77"), "kbwrite-77");
  assert.equal(kbWriteJobId("77"), kbWriteJobId("77"), "deterministic");
  assert.notEqual(kbWriteJobId("78"), kbWriteJobId("77"));
  assert.ok(!kbWriteJobId("77").includes(":"), "BullMQ-safe");
  console.log("[smoke] kb-write: deterministic jobId");
}

async function main(): Promise<void> {
  loadEnv();
  await testDetectionGate();
  await testDetectorFailureIsHarmless();
  await testDetectorNegativesAndGuards();
  await testDetectorHappyPaths();
  testProposalPayloadShape();
  await testWriteJobAgainstMockedServer();
  await testWriteJobGates();
  testRevertProposal();
  testJobId();
  console.log("[smoke] kb-write-back: all offline assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
