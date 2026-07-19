/**
 * Tiny dependency-free line differ for the kb_update approval card
 * (GH-112): renders a proposal's before/after as unified diff rows so the
 * reviewing human sees exactly what changes on the page, not just the new
 * text. Pure and client-safe (no imports), so the pending card (a client
 * component) and the decided detail (server) share it.
 *
 * Algorithm: classic LCS over lines via dynamic programming. Wiki pages
 * are small (the detector refuses bases over 20k chars), so O(n*m) is
 * fine; a hard cell cap guards pathological inputs by falling back to
 * "whole page replaced" rows rather than burning CPU.
 */

export type DiffRowKind = "context" | "add" | "del" | "gap";

export interface DiffRow {
  kind: DiffRowKind;
  /** Line text ("" for gap rows, which render as an ellipsis divider). */
  text: string;
}

/** Above this many DP cells, skip the LCS and fall back to replace-all. */
const MAX_CELLS = 500_000;

/** Unchanged lines kept around each change; longer runs collapse to a gap. */
const CONTEXT_LINES = 3;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** Raw op stream: every line of both sides, marked. */
function diffOps(
  before: string[],
  after: string[],
): Array<{ kind: "same" | "add" | "del"; text: string }> {
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_CELLS) {
    return [
      ...before.map((text) => ({ kind: "del" as const, text })),
      ...after.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  // lcs[i][j] = LCS length of before[i..] and after[j..]
  const lcs: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Array<{ kind: "same" | "add" | "del"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "same", text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "del", text: before[i]! });
      i++;
    } else {
      ops.push({ kind: "add", text: after[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: before[i++]! });
  while (j < m) ops.push({ kind: "add", text: after[j++]! });
  return ops;
}

/**
 * Unified diff rows for display: changes with CONTEXT_LINES of unchanged
 * context, longer unchanged runs collapsed into a single gap row. A
 * new-page proposal (empty before) renders as all-add rows, which is the
 * honest view.
 */
export function lineDiff(before: string, after: string): DiffRow[] {
  const ops = diffOps(splitLines(before), splitLines(after));
  const rows: DiffRow[] = [];
  // Indexes of ops that are changes, to window the context around them.
  const changed = ops.map((op) => op.kind !== "same");
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (!changed[k]) continue;
    for (
      let w = Math.max(0, k - CONTEXT_LINES);
      w <= Math.min(ops.length - 1, k + CONTEXT_LINES);
      w++
    ) {
      keep[w] = true;
    }
  }
  let inGap = false;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) {
      if (!inGap) {
        rows.push({ kind: "gap", text: "" });
        inGap = true;
      }
      continue;
    }
    inGap = false;
    const op = ops[k]!;
    rows.push({
      kind: op.kind === "same" ? "context" : op.kind,
      text: op.text,
    });
  }
  return rows;
}

/** Change counts for the diff header ("+3 -1 lines"). */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added++;
    else if (row.kind === "del") removed++;
  }
  return { added, removed };
}
