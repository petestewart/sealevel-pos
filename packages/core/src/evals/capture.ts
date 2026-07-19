import { getPool } from "../db/client.js";
import { getItemById } from "../db/items.js";
import { bookingConfigured, bookingUrl } from "../booking.js";
import { kbConfigured, kbToolCall } from "../tools/kb.js";
import { FIXTURE_TOOLS, parseCase } from "./cases.js";

/**
 * One-click eval-case capture (GH-128): turn a console item's drafting run
 * into a runnable golden case for evals/cases/.
 *
 * The worker replays the run's recorded trace calls (tool + the full args
 * retained by the GH-128 trace extension) against the live KB toolset and
 * snapshots the responses as case fixtures. That is deliberate and
 * documented honesty: the trace stores result SIZES, never result text,
 * so the original tool outputs cannot be recovered; the fixtures reflect
 * capture time, not the original run, and the case notes say so.
 *
 * Privacy exclusion: search_email_history calls are NEVER replayed. Their
 * results embed prior correspondence from the mailbox, and a committed
 * case file must not contain content from other email threads. The
 * exclusion is noted on the captured case.
 *
 * The finished case JSON is stored on the item payload
 * (payload.eval_capture = {at, case} or {at, error}) and surfaced in the
 * console as a copyable/downloadable block; the operator commits it to
 * evals/cases/ via a normal PR. Nothing is auto-committed.
 */

/** What lands at payload.eval_capture. */
export interface EvalCaptureRecord {
  at: string;
  /** The assembled, parseCase-validated case JSON, on success. */
  case?: Record<string, unknown>;
  /** Honest failure note (KB unconfigured, no inbound, replay error). */
  error?: string;
}

/** Replay one tool call against the live toolset; throws on failure. */
export type ReplayFn = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string>;

/** The minimum item shape capture needs (row or synthetic test double). */
export interface CaptureItemLike {
  id: string | number;
  payload: Record<string, unknown>;
}

/** Per-fixture cap on a replayed result stored in the case. */
export const CAPTURE_FIXTURE_MAX_CHARS = 12_000;

/** Cap on the whole serialized case stored at payload.eval_capture. */
export const CAPTURE_CASE_MAX_CHARS = 64_000;

/** The tools capture never replays, with the reason baked into notes. */
export const CAPTURE_EXCLUDED_TOOLS = new Set(["search_email_history"]);

interface TraceCallLike {
  tool?: unknown;
  ref?: unknown;
  args?: unknown;
}

interface ReplayableCall {
  tool: string;
  args: Record<string, unknown>;
  argsInclude?: string;
}

/** Args fields whose value disambiguates repeat calls to the same tool. */
const ARGS_INCLUDE_FIELDS = ["query", "name", "class_type", "contains"];

function parseArgs(entry: TraceCallLike): Record<string, unknown> | null {
  if (typeof entry.args === "string") {
    try {
      const parsed = JSON.parse(entry.args) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to the ref-based reconstruction below.
    }
  }
  // Traces that predate the args extension: for the two wiki tools the
  // ref IS the single argument, so the call is still faithfully
  // replayable. Other tools without args are skipped (noted).
  const ref = typeof entry.ref === "string" ? entry.ref : "";
  if (entry.tool === "search_wiki" && ref.length > 0) return { query: ref };
  if (entry.tool === "read_wiki_page" && ref.length > 0) return { name: ref };
  return null;
}

function argsIncludeOf(args: Record<string, unknown>): string | undefined {
  for (const field of ARGS_INCLUDE_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/**
 * The replayable tool calls from a run trace, deduplicated (a repeated
 * identical lookup yields one fixture) and partitioned so entries WITH an
 * args matcher precede matcher-less fallbacks: the eval fixture layer is
 * first-match-wins per tool, so a fallback listed first would shadow a
 * specific entry.
 */
function collectReplayCalls(payload: Record<string, unknown>): {
  calls: ReplayableCall[];
  excludedHistory: boolean;
  unreplayable: string[];
} {
  const trace = payload["run_trace"] as { calls?: unknown } | undefined;
  const raw = Array.isArray(trace?.calls) ? (trace.calls as TraceCallLike[]) : [];
  const withMatcher: ReplayableCall[] = [];
  const fallbacks: ReplayableCall[] = [];
  const seen = new Set<string>();
  let excludedHistory = false;
  const unreplayable: string[] = [];
  for (const entry of raw) {
    const tool = typeof entry.tool === "string" ? entry.tool : "";
    if (CAPTURE_EXCLUDED_TOOLS.has(tool)) {
      excludedHistory = true;
      continue;
    }
    if (!(FIXTURE_TOOLS as readonly string[]).includes(tool)) continue;
    const args = parseArgs(entry);
    if (args === null) {
      unreplayable.push(tool);
      continue;
    }
    const argsInclude = argsIncludeOf(args);
    const key = `${tool}\u0000${argsInclude ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const call: ReplayableCall = {
      tool,
      args,
      ...(argsInclude ? { argsInclude } : {}),
    };
    (argsInclude ? withMatcher : fallbacks).push(call);
  }
  return { calls: [...withMatcher, ...fallbacks], excludedHistory, unreplayable };
}

function inboundOf(payload: Record<string, unknown>): {
  from: string;
  subject: string;
  body: string;
} {
  const original = (payload["original_email"] ?? {}) as Record<string, unknown>;
  const field = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  if (typeof payload["original_email"] !== "object") {
    throw new Error("item has no original_email payload to capture");
  }
  return {
    from: field(original["from"], "(unknown sender)"),
    subject: field(original["subject"], "(no subject)"),
    body: field(original["body"], "(empty body)"),
  };
}

/**
 * Assemble the capture record for one item: replay the trace via `call`,
 * build the case JSON, validate it with the real case parser. Never
 * throws; failures come back as an honest {at, error} record. When `call`
 * is omitted the live KB client is used, gated on kbConfigured().
 */
export async function captureRecordForItem(
  item: CaptureItemLike,
  call?: ReplayFn,
): Promise<EvalCaptureRecord> {
  const at = new Date().toISOString();
  try {
    const payload = item.payload ?? {};
    const inbound = inboundOf(payload);
    const { calls, excludedHistory, unreplayable } =
      collectReplayCalls(payload);

    let replay = call;
    if (!replay) {
      if (calls.length > 0 && !kbConfigured()) {
        return {
          at,
          error:
            "Cannot capture fixtures: the knowledge base connection is not configured for the worker (SEALEVEL_MCP_URL / SEALEVEL_MCP_TOKEN), so the recorded tool calls cannot be replayed.",
        };
      }
      replay = kbToolCall;
    }

    let anyClipped = false;
    const fixtures: Array<Record<string, unknown>> = [];
    for (const c of calls) {
      const result = await replay(c.tool, c.args);
      const text = result.length > 0 ? result : "(no results)";
      const clipped = text.length > CAPTURE_FIXTURE_MAX_CHARS;
      if (clipped) anyClipped = true;
      fixtures.push({
        tool: c.tool,
        ...(c.argsInclude ? { argsInclude: c.argsInclude } : {}),
        result: clipped ? text.slice(0, CAPTURE_FIXTURE_MAX_CHARS) : text,
      });
    }

    const booking = bookingConfigured() ? bookingUrl() : undefined;
    const checks: Array<Record<string, unknown>> = [
      ...(booking
        ? [{ kind: "mustContainVerbatim", pattern: booking }]
        : []),
      { kind: "noInventedTimes" },
      { kind: "noInventedPrices" },
      { kind: "noEmDash" },
    ];

    const guidance = (payload["run_trace"] as { guidance?: unknown } | undefined)
      ?.guidance;
    const hadRules =
      Array.isArray(guidance) && (guidance as unknown[]).includes("rules");

    const notes = [
      `Captured from item ${item.id} at ${at}.`,
      "Fixtures were re-fetched from the live tools at capture time, so their contents reflect capture time, not what the original run saw.",
      ...(excludedHistory
        ? [
            "search_email_history calls were not replayed: captured cases must not embed content from other email threads.",
          ]
        : []),
      ...(unreplayable.length > 0
        ? [
            `Not replayed (no recorded args in the trace): ${[...new Set(unreplayable)].join(", ")}.`,
          ]
        : []),
      ...(calls.length === 0
        ? ["No replayable tool calls were recorded for this run, so the case has no fixtures."]
        : []),
      ...(anyClipped
        ? ["Some fixture results were shortened to the capture size cap."]
        : []),
      ...(hadRules
        ? [
            "The original run had studio rules active; rule text is not captured. Add a rules fixture if a rule shaped this draft.",
          ]
        : []),
      "Review the checks, add rubric criteria for what a good reply must do, then commit this file to evals/cases/ via a normal PR.",
    ].join(" ");

    const subject = inbound.subject.replace(/\s+/g, " ").trim().slice(0, 80);
    const kase: Record<string, unknown> = {
      id: `captured-item-${item.id}`,
      description: `Captured from item ${item.id}: ${subject}`,
      inbound,
      ...(booking ? { env: { SEALEVEL_BOOKING_URL: booking } } : {}),
      ...(fixtures.length > 0 ? { fixtures } : {}),
      checks,
      notes,
    };

    // Self-check: the capture must be a runnable case file, byte for byte
    // what the operator will commit. parseCase throws loudly if not.
    const serialized = JSON.stringify(kase, null, 2);
    parseCase(`captured-item-${item.id}.json`, serialized);
    if (serialized.length > CAPTURE_CASE_MAX_CHARS) {
      return {
        at,
        error: `Captured case is too large to store on the item (${serialized.length} chars; cap ${CAPTURE_CASE_MAX_CHARS}).`,
      };
    }
    return { at, case: kase };
  } catch (err) {
    return {
      at,
      error: `Capture failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Persist the capture record at payload.eval_capture (overwrites prior). */
export async function recordEvalCapture(
  itemId: string,
  record: EvalCaptureRecord,
): Promise<void> {
  await getPool().query(
    `UPDATE items
     SET payload = payload || jsonb_build_object('eval_capture', $2::jsonb)
     WHERE id = $1`,
    [itemId, JSON.stringify(record)],
  );
}

/**
 * The eval.capture worker job body: load the item, assemble the capture
 * (replaying against the live KB), and store the result, success or
 * honest failure, at payload.eval_capture. Throws only when the item does
 * not exist (a real infrastructure error worth a retry/dead-letter);
 * every capture-level failure is recorded on the payload instead.
 */
export async function captureEvalCase(
  itemId: string,
  call?: ReplayFn,
): Promise<EvalCaptureRecord> {
  const item = await getItemById(itemId);
  if (!item) throw new Error(`eval.capture: no item with id ${itemId}`);
  const record = await captureRecordForItem(
    { id: item.id, payload: item.payload },
    call,
  );
  await recordEvalCapture(String(item.id), record);
  return record;
}
