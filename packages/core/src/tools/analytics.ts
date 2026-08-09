/**
 * Analytics tools (SEA-79): campaign audience reads against the Sealevel
 * MCP server's analytics identity.
 *
 * The MCP server exposes a SECOND service identity (`service:analytics`,
 * `ANALYTICS_TOKEN` wrangler secret) scoped server-side to exactly five
 * read-only tools over the nightly Mindbody D1 mirror: run_sql,
 * teacher_performance, slot_performance, attendance_heatmap, and
 * monthly_financials — never the wiki, document, schedule, pricing, or
 * write tools. It is distinct from the customer-facing drafting identity
 * (SEALEVEL_MCP_TOKEN), which in turn can never reach analytics data. The
 * split is enforced by the server; this module just holds the matching
 * credential and mirrors the kbConfigured() gating pattern: unset token =
 * the toolset and read helpers are simply absent, jobs run without them.
 *
 * Data constraints callers must design around (from the SEA-79 plan):
 * - Everything is read-only, and the D1 mirror is up to a DAY stale.
 * - There is no join path to Postgres: match on stable fields (e.g. email)
 *   in application code, never by id.
 * - run_sql caps results at 200 rows, so audience reads must paginate —
 *   use pageSelect() below.
 * - The mirror is dropped and recreated nightly around 02:30
 *   America/Los_Angeles: no campaign job may run between 02:00 and 03:30
 *   PT (see analyticsBlackout()).
 */

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";

import { KB_RESULT_MAX_CHARS, truncateForPrompt } from "../brain/budget.js";
import { KbClient } from "./kb.js";
import type { TraceRecorder } from "./trace.js";

/** One recorded analytics lookup, display-ready for run payloads. */
export interface AnalyticsSource {
  tool: string;
  ref: string;
  at: string;
  truncated?: boolean;
}

/** Per-run record of analytics usage, mirroring KbRunLog. */
export interface AnalyticsRunLog {
  sources: AnalyticsSource[];
  unavailable: boolean;
}

/**
 * Whether the analytics connection is configured in the environment. The
 * URL is the same MCP endpoint the KB toolset uses; the token is the
 * server's ANALYTICS_TOKEN secret, NEVER the drafting or kb-writer token.
 */
export function analyticsConfigured(): boolean {
  return Boolean(
    process.env["SEALEVEL_MCP_URL"] &&
      process.env["SEALEVEL_MCP_ANALYTICS_TOKEN"],
  );
}

// Same keyed-singleton idiom as tools/kb.ts: one shared client per
// (url, token) pair, replaced if the environment changes under us (tests).
let sharedClient: KbClient | undefined;
let sharedClientKey: string | undefined;

function getClient(): KbClient {
  const url = process.env["SEALEVEL_MCP_URL"] ?? "";
  const token = process.env["SEALEVEL_MCP_ANALYTICS_TOKEN"] ?? "";
  const key = `${url}\n${token}`;
  if (!sharedClient || sharedClientKey !== key) {
    sharedClient = new KbClient(url, token);
    sharedClientKey = key;
  }
  return sharedClient;
}

/** The five tools the analytics identity may call — the server registers
 * nothing else for its sessions, so any other name is "not found". */
export const ANALYTICS_TOOLS = [
  "run_sql",
  "teacher_performance",
  "slot_performance",
  "attendance_heatmap",
  "monthly_financials",
] as const;

export type AnalyticsTool = (typeof ANALYTICS_TOOLS)[number];

/**
 * Direct tool call for NON-model consumers (campaign audience jobs paging
 * SELECTs, report builders). Throws on failure or when unconfigured, so
 * callers degrade on their own terms.
 */
export async function analyticsToolCall(
  tool: AnalyticsTool,
  args: Record<string, unknown>,
): Promise<string> {
  if (!analyticsConfigured()) {
    throw new Error(
      "analytics is not configured (SEALEVEL_MCP_URL / SEALEVEL_MCP_ANALYTICS_TOKEN)",
    );
  }
  return getClient().callTool(tool, args);
}

/** The server's run_sql row cap; also the largest useful page size. */
export const RUN_SQL_ROW_CAP = 200;

/** Parsed shape of one run_sql result page. */
interface RunSqlPage {
  row_count: number;
  truncated: boolean;
  rows: Array<Record<string, unknown>>;
}

function parseRunSqlPage(text: string): RunSqlPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON text is the server explaining itself (query rejected, data
    // not synced yet); surface it verbatim.
    throw new Error(`run_sql did not return rows: ${text.slice(0, 300)}`);
  }
  const page = parsed as Partial<RunSqlPage>;
  if (!Array.isArray(page.rows)) {
    throw new Error(
      `run_sql returned an unexpected shape: ${text.slice(0, 300)}`,
    );
  }
  return {
    row_count: typeof page.row_count === "number" ? page.row_count : page.rows.length,
    truncated: Boolean(page.truncated),
    rows: page.rows as Array<Record<string, unknown>>,
  };
}

/**
 * Page a SELECT through run_sql (SEA-79 "done when": an ai-manager job can
 * page a SELECT against the analytics D1). The server caps every result at
 * 200 rows, so this appends `LIMIT <pageSize> OFFSET <n>` per page and
 * yields each page's rows until a short page signals the end.
 *
 * The query must be a single SELECT (or WITH ... SELECT) WITHOUT its own
 * LIMIT/OFFSET — pagination owns those — and with a deterministic ORDER BY,
 * or D1 may repeat/skip rows across pages. `maxRows` is a hard safety stop
 * for runaway audiences.
 */
export async function* pageSelect(
  select: string,
  opts: { pageSize?: number; maxRows?: number } = {},
): AsyncGenerator<Array<Record<string, unknown>>> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? RUN_SQL_ROW_CAP, 1), RUN_SQL_ROW_CAP);
  const maxRows = opts.maxRows ?? 10_000;
  const base = select.trim().replace(/;+\s*$/, "");
  if (/\blimit\b/i.test(base)) {
    throw new Error(
      "pageSelect owns LIMIT/OFFSET — pass the query without them",
    );
  }
  if (!/\border\s+by\b/i.test(base)) {
    throw new Error(
      "pageSelect needs a deterministic ORDER BY to page correctly",
    );
  }
  let offset = 0;
  for (;;) {
    const text = await analyticsToolCall("run_sql", {
      query: `${base} LIMIT ${pageSize} OFFSET ${offset}`,
    });
    const page = parseRunSqlPage(text);
    if (page.rows.length > 0) yield page.rows;
    offset += page.rows.length;
    // A short page normally means the data ended — but if the server
    // flagged the result truncated (its own row cap dropped below ours),
    // a short page still has more behind it, so keep paging.
    if (page.rows.length < pageSize && !page.truncated) return;
    if (page.rows.length === 0) return;
    if (offset >= maxRows) {
      throw new Error(
        `pageSelect exceeded maxRows=${maxRows}; narrow the query or raise the cap deliberately`,
      );
    }
  }
}

/**
 * Nightly rebuild blackout (SEA-79): the D1 mirror is dropped and recreated
 * around 02:30 America/Los_Angeles. No campaign job may run between 02:00
 * and 03:30 PT — mid-rebuild reads see a missing or half-loaded database.
 * Schedulers should check this (or simply not schedule inside the window;
 * remember worker crons run in UTC and the PT offset shifts with DST).
 */
export const ANALYTICS_BLACKOUT_START_MINUTES = 2 * 60; // 02:00 PT
export const ANALYTICS_BLACKOUT_END_MINUTES = 3 * 60 + 30; // 03:30 PT

export function analyticsBlackout(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  // "24" can appear for midnight under hour12:false in some ICU versions.
  const minutes = (get("hour") % 24) * 60 + get("minute");
  return (
    minutes >= ANALYTICS_BLACKOUT_START_MINUTES &&
    minutes < ANALYTICS_BLACKOUT_END_MINUTES
  );
}

const UNAVAILABLE_NOTE =
  "Analytics is unavailable right now. Do not invent attendance, revenue, or audience numbers; say the data could not be read and stop, or continue only with work that does not depend on analytics.";

/**
 * Build the per-run analytics toolset for model-driven jobs. Returns no
 * tools when unconfigured (the kbConfigured() pattern: an unset token means
 * the toolset is simply absent). The returned log records every lookup and
 * whether analytics failed during the run; TraceRecorder capture is
 * best-effort and can never fail or change a call.
 */
export function createAnalyticsToolset(recorder?: TraceRecorder): {
  tools: BetaRunnableTool<any>[];
  log: AnalyticsRunLog;
} {
  const log: AnalyticsRunLog = { sources: [], unavailable: false };
  if (!analyticsConfigured()) return { tools: [], log };

  const record = (tool: string, ref: string): AnalyticsSource => {
    const source: AnalyticsSource = {
      tool,
      ref,
      at: new Date().toISOString(),
    };
    log.sources.push(source);
    // Lookup refs are operator-visible metadata, never secrets.
    console.log(`[analytics] ${tool}: ${ref}`);
    return source;
  };

  const call = async (
    tool: AnalyticsTool,
    ref: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    const source = record(tool, ref);
    const started = Date.now();
    try {
      const text = await getClient().callTool(tool, args);
      try {
        recorder?.record({
          tool,
          ref,
          args,
          outcome: text.length === 0 ? "empty" : "ok",
          resultChars: text.length,
          durationMs: Date.now() - started,
        });
      } catch {
        // Trace capture must never fail the lookup.
      }
      if (text.length === 0) return "(no results)";
      if (text.length > KB_RESULT_MAX_CHARS) source.truncated = true;
      return truncateForPrompt(
        text,
        KB_RESULT_MAX_CHARS,
        `analytics ${tool} result`,
      );
    } catch (err) {
      log.unavailable = true;
      try {
        recorder?.record({
          tool,
          ref,
          args,
          outcome: "error",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        });
        recorder?.degrade("analytics-unavailable");
      } catch {
        // Trace capture must never fail the lookup.
      }
      console.warn(
        `[analytics] ${tool} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return UNAVAILABLE_NOTE;
    }
  };

  const dateField = (what: string) =>
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO date format YYYY-MM-DD")
      .optional()
      .describe(what);

  const runSql = betaZodTool({
    name: "run_sql",
    description:
      "Read-only SQL over the studio's analytics mirror (Mindbody data, up to a day stale): a SINGLE SELECT (or WITH ... SELECT) statement. Results are capped at 200 rows, so use ORDER BY with LIMIT/OFFSET to page through larger sets. Rejects anything that modifies data.",
    inputSchema: z.object({
      query: z.string().min(1).describe("A single read-only SELECT query."),
    }),
    run: ({ query }) => call("run_sql", query.slice(0, 120), { query }),
  });

  const teacherPerformance = betaZodTool({
    name: "teacher_performance",
    description:
      "Average draw (attendance) per teacher over an optional date range, optionally filtered to one class type: classes taught, average attendees, total attendees, and average revenue per class, best draw first.",
    inputSchema: z.object({
      start_date: dateField("Start date (inclusive), e.g. '2026-01-01'."),
      end_date: dateField("End date (inclusive)."),
      class_type: z
        .string()
        .optional()
        .describe("Exact class type, e.g. '26&2 (60 min)'. Omit for all."),
    }),
    run: ({ start_date, end_date, class_type }) =>
      call(
        "teacher_performance",
        `${class_type ?? "all"} ${start_date ?? ""}..${end_date ?? ""}`,
        {
          ...(start_date ? { start_date } : {}),
          ...(end_date ? { end_date } : {}),
          ...(class_type ? { class_type } : {}),
        },
      ),
  });

  const slotPerformance = betaZodTool({
    name: "slot_performance",
    description:
      "Per-time-slot class performance over an optional date range: number of classes, average attendance, and average revenue per class, busiest slot first.",
    inputSchema: z.object({
      start_date: dateField("Start date (inclusive), e.g. '2026-01-01'."),
      end_date: dateField("End date (inclusive)."),
    }),
    run: ({ start_date, end_date }) =>
      call("slot_performance", `${start_date ?? ""}..${end_date ?? ""}`, {
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
      }),
  });

  const attendanceHeatmap = betaZodTool({
    name: "attendance_heatmap",
    description:
      "Day-of-week x time-of-day attendance grid across the full dataset: classes held and average attendance per (day, time) slot. Good for spotting the busiest and quietest slots.",
    inputSchema: z.object({}),
    run: () => call("attendance_heatmap", "grid", {}),
  });

  const monthlyFinancials = betaZodTool({
    name: "monthly_financials",
    description:
      "Monthly sales by category (membership, class pack, single class, retail, ...) plus allocated visit revenue and attended visit counts, one row per month.",
    inputSchema: z.object({}),
    run: () => call("monthly_financials", "all months", {}),
  });

  return {
    tools: [
      runSql,
      teacherPerformance,
      slotPerformance,
      attendanceHeatmap,
      monthlyFinancials,
    ],
    log,
  };
}

/**
 * Standard analytics guidance appended to campaign job instructions when
 * analytics is configured. Centralized so future jobs stay consistent.
 */
export const ANALYTICS_PROMPT_GUIDANCE = `
You have read-only analytics tools over the studio's Mindbody data mirror (run_sql, teacher_performance, slot_performance, attendance_heatmap, monthly_financials).
- The data is up to a DAY stale and there is no link to the live booking system or the app database: match people by stable fields like email, never by internal ids.
- run_sql returns at most 200 rows per call. For anything bigger, page with ORDER BY + LIMIT/OFFSET and keep going until a short page.
- Everything is read-only; you cannot change schedules, prices, or client records from here.
- If a tool has no answer or is unavailable, say so rather than inventing numbers.`;
