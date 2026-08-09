import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  ANALYTICS_TOOLS,
  analyticsBlackout,
  analyticsConfigured,
  analyticsToolCall,
  createAnalyticsToolset,
  pageSelect,
} from "./analytics.js";

/**
 * Offline smoke for the analytics service client (SEA-79). Everything is
 * served by a local mock MCP endpoint: no real MCP server, DB, or API key
 * is touched.
 *
 * Run: npm run smoke:analytics  (from packages/core)
 */

const ENV_VARS = [
  "SEALEVEL_MCP_URL",
  "SEALEVEL_MCP_ANALYTICS_TOKEN",
  "SEALEVEL_MCP_TOKEN",
] as const;

function withEnv<T>(
  values: Partial<Record<(typeof ENV_VARS)[number], string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = ENV_VARS.map((v) => [v, process.env[v]] as const);
  for (const v of ENV_VARS) {
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

/** Mock MCP server scripting run_sql-style text results per tools/call. */
function mockMcpServer(results: string[]): Promise<{
  server: Server;
  url: string;
  calls: Array<Record<string, unknown>>;
  auth: string[];
}> {
  const calls: Array<Record<string, unknown>> = [];
  const auth: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        method?: string;
        params?: { arguments?: Record<string, unknown> };
      };
      auth.push(req.headers["authorization"] ?? "");
      if (parsed.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "smoke-session",
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
        return;
      }
      calls.push(parsed.params?.arguments ?? {});
      const next =
        results.shift() ?? "no scripted response left for this call";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: next }] },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, calls, auth });
    });
  });
}

function sqlPage(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify(
    { row_count: rows.length, truncated: false, rows },
    null,
    2,
  );
}

async function testConfigGate(): Promise<void> {
  await withEnv({}, async () => {
    assert.equal(analyticsConfigured(), false);
    assert.deepEqual(createAnalyticsToolset().tools, []);
    await assert.rejects(
      () => analyticsToolCall("run_sql", { query: "SELECT 1" }),
      /SEALEVEL_MCP_ANALYTICS_TOKEN/,
    );
  });
  // The URL alone, or the DRAFTING token, is not enough: the analytics
  // toolset gates on its own credential.
  await withEnv(
    { SEALEVEL_MCP_URL: "https://mcp.example", SEALEVEL_MCP_TOKEN: "draft" },
    async () => {
      assert.equal(analyticsConfigured(), false);
      assert.deepEqual(createAnalyticsToolset().tools, []);
    },
  );
  await withEnv(
    {
      SEALEVEL_MCP_URL: "https://mcp.example",
      SEALEVEL_MCP_ANALYTICS_TOKEN: "tok",
    },
    async () => {
      assert.equal(analyticsConfigured(), true);
    },
  );
  console.log("[smoke] analytics: config gate (unset token = toolset absent)");
}

async function testToolsetShape(): Promise<void> {
  await withEnv(
    {
      SEALEVEL_MCP_URL: "https://mcp.example",
      SEALEVEL_MCP_ANALYTICS_TOKEN: "tok",
    },
    async () => {
      const { tools, log } = createAnalyticsToolset();
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        [...ANALYTICS_TOOLS].sort(),
      );
      assert.deepEqual(log, { sources: [], unavailable: false });
    },
  );
  console.log("[smoke] analytics: toolset exposes exactly the five tools");
}

async function testPagedSelect(): Promise<void> {
  const fullPage = Array.from({ length: 200 }, (_, i) => ({
    email: `client${i}@example.com`,
  }));
  const lastPage = Array.from({ length: 47 }, (_, i) => ({
    email: `tail${i}@example.com`,
  }));
  const { server, url, calls, auth } = await mockMcpServer([
    sqlPage(fullPage),
    sqlPage(lastPage),
  ]);
  try {
    await withEnv(
      { SEALEVEL_MCP_URL: url, SEALEVEL_MCP_ANALYTICS_TOKEN: "analytics-tok" },
      async () => {
        const collected: Array<Record<string, unknown>> = [];
        for await (const rows of pageSelect(
          "SELECT email FROM clients ORDER BY email;",
        )) {
          collected.push(...rows);
        }
        assert.equal(collected.length, 247);
        assert.equal(calls.length, 2);
        assert.match(
          String(calls[0]!["query"]),
          /ORDER BY email LIMIT 200 OFFSET 0$/,
        );
        assert.match(
          String(calls[1]!["query"]),
          /ORDER BY email LIMIT 200 OFFSET 200$/,
        );
        // Every request carried the ANALYTICS token, never the drafter's.
        assert.ok(auth.every((a) => a === "Bearer analytics-tok"));
      },
    );
  } finally {
    server.close();
  }
  console.log("[smoke] analytics: pageSelect pages a SELECT past the 200-row cap");
}

async function testPagedSelectGuards(): Promise<void> {
  await withEnv(
    {
      SEALEVEL_MCP_URL: "https://mcp.example",
      SEALEVEL_MCP_ANALYTICS_TOKEN: "tok",
    },
    async () => {
      await assert.rejects(
        () =>
          pageSelect("SELECT email FROM clients ORDER BY email LIMIT 5")
            .next(),
        /owns LIMIT/,
      );
      await assert.rejects(
        () => pageSelect("SELECT email FROM clients").next(),
        /ORDER BY/,
      );
    },
  );
  // A non-JSON body (the server's "not synced yet" notice, or a rejected
  // query) surfaces as an error rather than being mistaken for rows.
  const { server, url } = await mockMcpServer([
    "The Mindbody analytics data has not been synced into this server yet",
  ]);
  try {
    await withEnv(
      { SEALEVEL_MCP_URL: url, SEALEVEL_MCP_ANALYTICS_TOKEN: "tok" },
      async () => {
        await assert.rejects(
          () => pageSelect("SELECT email FROM clients ORDER BY email").next(),
          /did not return rows.*not been synced/s,
        );
      },
    );
  } finally {
    server.close();
  }
  console.log("[smoke] analytics: pageSelect guards (LIMIT, ORDER BY, non-JSON)");
}

async function testToolCallFailureDegrades(): Promise<void> {
  // A dead endpoint: the model-facing tool resolves to the unavailable
  // note (never throws into the tool loop) and the run log records it.
  const { server, url } = await mockMcpServer([]);
  server.close();
  await withEnv(
    { SEALEVEL_MCP_URL: url, SEALEVEL_MCP_ANALYTICS_TOKEN: "tok" },
    async () => {
      const { tools, log } = createAnalyticsToolset();
      const heatmap = tools.find((t) => t.name === "attendance_heatmap")!;
      const text = await (
        heatmap.run as (args: unknown) => Promise<string>
      )({});
      assert.match(text, /Analytics is unavailable/);
      assert.equal(log.unavailable, true);
      assert.equal(log.sources.length, 1);
    },
  );
  console.log("[smoke] analytics: tool failure degrades to the unavailable note");
}

function testBlackoutWindow(): void {
  // PDT (UTC-7): 09:30Z = 02:30 PT — mid-rebuild.
  assert.equal(analyticsBlackout(new Date("2026-08-08T09:30:00Z")), true);
  assert.equal(analyticsBlackout(new Date("2026-08-08T09:00:00Z")), true); // 02:00 inclusive
  assert.equal(analyticsBlackout(new Date("2026-08-08T08:59:00Z")), false); // 01:59
  assert.equal(analyticsBlackout(new Date("2026-08-08T10:30:00Z")), false); // 03:30 exclusive
  // PST (UTC-8): the same wall-clock window shifts in UTC.
  assert.equal(analyticsBlackout(new Date("2026-01-08T10:30:00Z")), true); // 02:30 PST
  assert.equal(analyticsBlackout(new Date("2026-01-08T09:30:00Z")), false); // 01:30 PST
  console.log("[smoke] analytics: blackout window tracks PT wall-clock across DST");
}

async function main(): Promise<void> {
  await testConfigGate();
  await testToolsetShape();
  await testPagedSelect();
  await testPagedSelectGuards();
  await testToolCallFailureDegrades();
  testBlackoutWindow();
  console.log("[smoke] analytics: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
