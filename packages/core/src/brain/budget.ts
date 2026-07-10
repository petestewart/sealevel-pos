/**
 * Input-size budgets for brain runs (GH-62 cost hardening).
 *
 * The tool loop resends the entire conversation on every iteration, so a
 * single oversized block (a big wiki page, a pasted-novel email body) is
 * paid for again on each subsequent API call and can push a request into
 * the >200k context pricing tier (2x input price). These budgets cap the
 * blocks that can realistically balloon. Caps are in characters (~4 chars
 * per token): generous enough that real studio content never trips them,
 * tight enough that no single block exceeds a few thousand tokens.
 */

/** One KB tool result (search passage set or full wiki page). ~6k tokens. */
export const KB_RESULT_MAX_CHARS = 24_000;

/** An inbound email body or a stored draft/original rendered into a prompt. */
export const EMAIL_BODY_MAX_CHARS = 16_000;

/** A one-shot operator instruction to item.revise. */
export const INSTRUCTION_MAX_CHARS = 4_000;

/**
 * Truncate oversized text with an explicit marker so the model (and any
 * human reading logs) knows content was cut. Logs the event; `label`
 * names the block for the log line. No-op for text within budget.
 */
export function truncateForPrompt(
  text: string,
  maxChars: number,
  label: string,
): string {
  if (text.length <= maxChars) return text;
  console.warn(
    `[budget] truncated ${label}: ${text.length} chars -> ${maxChars}`,
  );
  return `${text.slice(0, maxChars)}\n\n[truncated: ${label} exceeded the size budget; ${text.length - maxChars} characters omitted]`;
}

/** Token usage accumulated across every API call in one brain run. */
export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** Number of API calls (tool-loop iterations) in the run. */
  api_calls: number;
}

export function emptyUsage(): UsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    api_calls: 0,
  };
}

/** Add one API response's usage block into the run totals. */
export function addUsage(
  totals: UsageTotals,
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
): void {
  totals.input_tokens += usage.input_tokens ?? 0;
  totals.output_tokens += usage.output_tokens ?? 0;
  totals.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  totals.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  totals.api_calls += 1;
}
