import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Golden-case loading for the email-drafting eval suite (see run.ts).
 *
 * Cases are plain JSON files in <repo>/evals/cases/*.json so adding a
 * regression case never requires touching engine code. Each case freezes
 * an inbound email, the canned KB tool results the drafter should see
 * (fixtures), the environment the draft runs under, and what a good
 * draft must and must not contain.
 */

/** Tools the fixture layer can stand in for (the KB toolset, tools/kb.ts). */
export const FIXTURE_TOOLS = [
  "search_wiki",
  "read_wiki_page",
  "upcoming_classes",
] as const;

export interface FixtureEntry {
  /** Which KB tool this canned result answers. */
  tool: (typeof FIXTURE_TOOLS)[number];
  /**
   * Optional args matcher: the entry applies only when the lowercased
   * JSON of the tool-call arguments contains this substring (e.g.
   * "vinyasa" to answer a filtered upcoming_classes call). An entry
   * without a matcher is the tool's fallback. First matching entry wins,
   * so list specific entries before the fallback.
   */
  argsInclude?: string;
  /** The canned tool result text (arrays are joined with newlines). */
  result: string;
}

export type CheckSpec =
  | { kind: "mustContain"; pattern: string; regex?: boolean; flags?: string }
  | { kind: "mustNotContain"; pattern: string; regex?: boolean; flags?: string }
  /** Exact, case-sensitive substring (e.g. the booking URL, verbatim). */
  | { kind: "mustContainVerbatim"; pattern: string }
  | { kind: "noEmDash" }
  /** Every clock time in the draft must appear in the fixture data. */
  | { kind: "noInventedTimes" }
  /** Every $ amount in the draft must appear in the fixture data. */
  | { kind: "noInventedPrices" };

export interface EvalCase {
  id: string;
  description: string;
  inbound: { from: string; subject: string; body: string };
  /**
   * Env overrides for the run (null deletes the variable). The harness
   * always pins SEALEVEL_MCP_URL/TOKEN to the fixture endpoint and
   * removes DATABASE_URL so runs are hermetic; cases typically only set
   * or unset SEALEVEL_BOOKING_URL.
   */
  env?: Record<string, string | null>;
  fixtures?: FixtureEntry[];
  /** Deterministic assertions, run first and at zero API cost. */
  checks: CheckSpec[];
  /**
   * Optional judge criteria. Only cases with a rubric ever trigger the
   * (single, batched) claude-sonnet-5 judge call, and only after every
   * deterministic check passed.
   */
  rubric?: string[];
  /**
   * Known-bad today: a failure is reported but keeps the suite green, so
   * real production misses stay tracked while their fixes are in flight.
   * A pass is flagged so the marker gets removed.
   */
  expectedToFail?: boolean;
  notes?: string;
  /** The raw file content, used for content-hash caching. */
  raw: string;
}

const CHECK_KINDS = new Set([
  "mustContain",
  "mustNotContain",
  "mustContainVerbatim",
  "noEmDash",
  "noInventedTimes",
  "noInventedPrices",
]);

function fail(file: string, msg: string): never {
  throw new Error(`eval case ${file}: ${msg}`);
}

function asString(file: string, v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) {
    fail(file, `${what} must be a non-empty string`);
  }
  return v;
}

/** Parse and validate one case file. */
export function parseCase(file: string, raw: string): EvalCase {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const id = asString(file, data["id"], "id");
  const inbound = data["inbound"] as Record<string, unknown> | undefined;
  if (!inbound) fail(file, "inbound is required");
  const checks = data["checks"];
  if (!Array.isArray(checks) || checks.length === 0) {
    fail(file, "checks must be a non-empty array");
  }
  for (const c of checks as Array<Record<string, unknown>>) {
    const kind = c["kind"];
    if (typeof kind !== "string" || !CHECK_KINDS.has(kind)) {
      fail(file, `unknown check kind: ${String(kind)}`);
    }
    if (kind.startsWith("must")) {
      const pattern = asString(file, c["pattern"], `${kind}.pattern`);
      if (c["regex"] === true) new RegExp(pattern); // compile-check now
    }
  }
  const fixtures = (data["fixtures"] ?? []) as Array<Record<string, unknown>>;
  const parsedFixtures: FixtureEntry[] = fixtures.map((f) => {
    const tool = asString(file, f["tool"], "fixture.tool");
    if (!(FIXTURE_TOOLS as readonly string[]).includes(tool)) {
      fail(file, `fixture tool must be one of ${FIXTURE_TOOLS.join(", ")}`);
    }
    const rawResult = f["result"];
    const result = Array.isArray(rawResult)
      ? rawResult.map((l) => asString(file, l, "fixture.result line")).join("\n")
      : asString(file, rawResult, "fixture.result");
    return {
      tool: tool as FixtureEntry["tool"],
      ...(typeof f["argsInclude"] === "string"
        ? { argsInclude: f["argsInclude"] }
        : {}),
      result,
    };
  });
  const rubric = data["rubric"];
  if (rubric !== undefined) {
    if (!Array.isArray(rubric) || rubric.length === 0) {
      fail(file, "rubric, when present, must be a non-empty array");
    }
    for (const r of rubric) asString(file, r, "rubric entry");
  }
  return {
    id,
    description: asString(file, data["description"], "description"),
    inbound: {
      from: asString(file, inbound["from"], "inbound.from"),
      subject: asString(file, inbound["subject"], "inbound.subject"),
      body: asString(file, inbound["body"], "inbound.body"),
    },
    ...(data["env"] ? { env: data["env"] as Record<string, string | null> } : {}),
    fixtures: parsedFixtures,
    checks: checks as CheckSpec[],
    ...(rubric ? { rubric: rubric as string[] } : {}),
    ...(data["expectedToFail"] === true ? { expectedToFail: true } : {}),
    ...(typeof data["notes"] === "string" ? { notes: data["notes"] } : {}),
    raw,
  };
}

/** Load every case in a directory, sorted by id; ids must be unique. */
export function loadCases(dir: string): EvalCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const cases = files.map((f) => parseCase(f, readFileSync(join(dir, f), "utf8")));
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate eval case id: ${c.id}`);
    seen.add(c.id);
  }
  return cases;
}

/** All fixture text for a case, the reference for invented-fact checks. */
export function fixtureText(c: EvalCase): string {
  return (c.fixtures ?? []).map((f) => f.result).join("\n");
}
