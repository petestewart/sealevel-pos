import type { FixtureEntry } from "./cases.js";

/**
 * Fixture-backed stand-in for the KB MCP server (tools/kb.ts).
 *
 * Rather than reimplementing the toolset, the harness intercepts global
 * fetch for one sentinel URL and answers the MCP JSON-RPC protocol from
 * the case's canned results. createKbToolset() then runs completely
 * unmodified: the real tool names, descriptions, schemas, source
 * logging, truncation and error handling are all exercised, and no
 * request ever leaves the process. Every other URL (in particular the
 * Anthropic API) passes through to the real fetch untouched.
 */

/** Sentinel KB endpoint; .invalid can never resolve, so a bug that lets a
 * request past the interceptor fails loudly instead of hitting a network. */
export const FIXTURE_KB_URL = "https://kb.evals.invalid/mcp";
export const FIXTURE_KB_TOKEN = "eval-fixture-token";

/** Serve the first matching fixture for one tool call. Exported for tests. */
export function fixtureResultFor(
  fixtures: FixtureEntry[],
  tool: string,
  args: Record<string, unknown>,
): string {
  const argsJson = JSON.stringify(args ?? {}).toLowerCase();
  for (const f of fixtures) {
    if (f.tool !== tool) continue;
    if (f.argsInclude && !argsJson.includes(f.argsInclude.toLowerCase())) {
      continue;
    }
    return f.result;
  }
  return "(no results)";
}

interface JsonRpcRequest {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function rpcResponse(id: number | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 0, result }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // KbClient requires a session id from initialize and echoes it back;
      // returning it on every response keeps the stub stateless.
      "mcp-session-id": "eval-fixture-session",
    },
  });
}

/**
 * Install the interceptor. Returns an uninstall function; always call it
 * (finally) so cases cannot leak fixtures into each other.
 */
export function installFixtureKb(fixtures: FixtureEntry[]): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url !== FIXTURE_KB_URL) return realFetch(input as never, init);
    const req = JSON.parse(String(init?.body ?? "{}")) as JsonRpcRequest;
    if (req.method === "initialize") {
      return rpcResponse(req.id, {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "eval-fixture-kb", version: "0" },
      });
    }
    if (req.method === "tools/call") {
      const text = fixtureResultFor(
        fixtures,
        req.params?.name ?? "",
        req.params?.arguments ?? {},
      );
      return rpcResponse(req.id, { content: [{ type: "text", text }] });
    }
    return rpcResponse(req.id, {});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/**
 * Apply the hermetic eval environment plus per-case overrides (null
 * deletes a variable). Returns a restore function. The KB endpoint is
 * pinned to the fixture sentinel and DATABASE_URL is removed so
 * loadRulesBlock/loadStudioInfoBlock degrade to empty blocks instantly;
 * a developer's local env can therefore never leak into a case.
 */
export function applyCaseEnv(
  overrides: Record<string, string | null> | undefined,
): () => void {
  const applied: Record<string, string | null> = {
    SEALEVEL_MCP_URL: FIXTURE_KB_URL,
    SEALEVEL_MCP_TOKEN: FIXTURE_KB_TOKEN,
    DATABASE_URL: null,
    SEALEVEL_BOOKING_URL: null,
    // Gmail creds are removed so gmailConfigured() is false in every
    // case: the sender-scoped search_email_history tool (GH-118) and its
    // prompt guidance are simply absent, which is that layer's designed
    // hermetic behavior, and a developer's local Gmail env can never
    // leak a real mailbox call into an eval run.
    GMAIL_CLIENT_ID: null,
    GMAIL_CLIENT_SECRET: null,
    GMAIL_REFRESH_TOKEN: null,
    GMAIL_USER: null,
    ...(overrides ?? {}),
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(applied)) {
    previous.set(key, process.env[key]);
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
