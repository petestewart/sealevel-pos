import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { UsageTotals } from "../brain/budget.js";

/**
 * Draft-generation cache. A case's saved output is reused (zero API
 * calls) whenever nothing that could change the draft has changed: the
 * case file itself (inbound, fixtures, env) plus every prompt-affecting
 * source file, hashed together. --force overrides; --offline consumes
 * only this cache. Outputs live in <repo>/evals/outputs/ and are
 * gitignored: they are machine-local API products, and committing them
 * would churn on every prompt tune.
 */

/** dist/evals/cache.js -> packages/core/dist/evals -> repo root. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export function casesDir(): string {
  return join(repoRoot(), "evals", "cases");
}

export function outputsDir(): string {
  return join(repoRoot(), "evals", "outputs");
}

/**
 * Everything that shapes the drafting prompt or tool surface. A change
 * to any of these invalidates every cached draft.
 */
export const PROMPT_SOURCES = [
  "packages/core/src/jobs/emailDraft.ts",
  "packages/core/src/booking.ts",
  "packages/core/src/tools/kb.ts",
  "packages/core/src/tools/registry.ts",
  "packages/core/src/brain/prompts.ts",
  "packages/core/src/brain/budget.ts",
  "packages/core/src/evals/draft.ts",
];

let promptSourcesDigest: string | undefined;

function promptSourcesHash(): string {
  if (promptSourcesDigest === undefined) {
    const hash = createHash("sha256");
    for (const rel of PROMPT_SOURCES) {
      const path = join(repoRoot(), rel);
      hash.update(rel);
      hash.update("\0");
      hash.update(existsSync(path) ? readFileSync(path) : "missing");
      hash.update("\0");
    }
    promptSourcesDigest = hash.digest("hex");
  }
  return promptSourcesDigest;
}

/** Content hash for one case: raw case JSON + prompt-affecting sources. */
export function caseHash(rawCaseJson: string): string {
  return createHash("sha256")
    .update(rawCaseJson)
    .update("\0")
    .update(promptSourcesHash())
    .digest("hex");
}

export function rubricHash(rubric: string[]): string {
  return createHash("sha256").update(JSON.stringify(rubric)).digest("hex");
}

export interface SavedJudge {
  rubric_hash: string;
  criteria: Record<string, boolean>;
  notes: string;
  usage: UsageTotals;
}

export interface SavedOutput {
  case_id: string;
  hash: string;
  generated_at: string;
  draft: { subject?: string; body?: string; rationale?: string } | null;
  create_item_calls: number;
  final_text: string;
  usage: UsageTotals;
  judge?: SavedJudge;
}

export function readOutput(caseId: string): SavedOutput | undefined {
  const path = join(outputsDir(), `${caseId}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SavedOutput;
  } catch {
    return undefined; // corrupt cache entry: treat as absent
  }
}

export function writeOutput(output: SavedOutput): void {
  mkdirSync(outputsDir(), { recursive: true });
  writeFileSync(
    join(outputsDir(), `${output.case_id}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
  );
}
