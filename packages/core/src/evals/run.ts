import { existsSync } from "node:fs";

import type { UsageTotals } from "../brain/budget.js";
import { classifyNoReplyDeterministic } from "../brain/noReply.js";
import { fixtureText, loadCases, type EvalCase } from "./cases.js";
import {
  caseHash,
  casesDir,
  readOutput,
  rubricHash,
  writeOutput,
  type SavedOutput,
} from "./cache.js";
import { runChecks, type CheckResult } from "./checks.js";
import { runDraftCase } from "./draft.js";
import { judgeCase } from "./judge.js";

/**
 * Golden-case eval runner for email drafting quality.
 *
 *   npm run eval                 all cases (drafts cached by content hash)
 *   npm run eval -- --case <id>  one case
 *   npm run eval -- --offline    deterministic checks only, against the
 *                                last saved outputs; zero API calls
 *   npm run eval -- --force      re-draft even when the cache is valid
 *
 * Token discipline, in order: deterministic checks are free and always
 * run first; a case only reaches the judge if it has a rubric AND its
 * deterministic tier passed; the judge is one batched sonnet call per
 * case with a compact JSON verdict; drafts (and judge verdicts) are
 * cached by content hash so unchanged cases cost nothing to re-run.
 * Exits nonzero on any regression (expectedToFail cases stay tracked
 * without breaking the suite).
 */

interface CaseReport {
  c: EvalCase;
  draftSource:
    | "fresh"
    | "cached"
    | "stale cache"
    | "missing"
    | "no-reply gate";
  checks?: CheckResult[];
  judge?: {
    criteria: Record<string, boolean>;
    notes: string;
    source: "fresh" | "cached" | "skipped";
  };
  /** Tokens actually spent by THIS invocation. */
  spent: { input: number; output: number };
  outcome: "pass" | "fail" | "xfail" | "xpass" | "skipped";
  problems: string[];
}

function allPass(results: { pass?: boolean }[] | undefined): boolean {
  return (results ?? []).every((r) => r.pass !== false);
}

function spend(
  spent: { input: number; output: number },
  usage: UsageTotals,
): void {
  spent.input +=
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens;
  spent.output += usage.output_tokens;
}

async function runOne(
  c: EvalCase,
  opts: { offline: boolean; force: boolean },
): Promise<CaseReport> {
  const report: CaseReport = {
    c,
    draftSource: "missing",
    spent: { input: 0, output: 0 },
    outcome: "skipped",
    problems: [],
  };
  const hash = caseHash(c.raw);
  let saved = readOutput(c.id);

  // GH-115: the free deterministic no-reply tiers (sender rules, headers)
  // run in-process for EVERY case at zero cost, live or offline. For a
  // case expecting classification they can decide the outcome outright;
  // for a drafting case they are the over-blocking guard (a real customer
  // email matching tier 1/2 is a failure even against a cached draft).
  const detGate = classifyNoReplyDeterministic(c.inbound);

  if (c.expectNoReply) {
    // Tier 1/2 expectations are decidable right here with no API call and
    // no cache. Only a gray-area (tier 3) expectation needs the model.
    let cls = detGate;
    report.draftSource = "no-reply gate";
    if (!cls) {
      if (opts.offline) {
        if (saved?.classification) {
          cls = saved.classification;
          report.draftSource = saved.hash === hash ? "cached" : "stale cache";
        } else {
          report.problems.push(
            "no cached classification; run a live eval first",
          );
          report.draftSource = "missing";
          return report;
        }
      } else if (saved && saved.hash === hash && !opts.force) {
        cls = saved.classification ?? null;
        report.draftSource = "cached";
      } else {
        const result = await runDraftCase(c);
        spend(report.spent, result.usage);
        saved = {
          case_id: c.id,
          hash,
          generated_at: new Date().toISOString(),
          draft: result.draft ?? null,
          create_item_calls: result.createItemCalls,
          final_text: result.finalText,
          usage: result.usage,
          ...(result.classification
            ? { classification: result.classification }
            : {}),
        };
        writeOutput(saved);
        cls = result.classification ?? null;
        report.draftSource = "fresh";
      }
    }
    if (!cls) {
      report.problems.push(
        "expected a no_reply_needed classification but a draft was generated",
      );
      report.outcome = "fail";
    } else if (
      c.expectNoReplyTier !== undefined &&
      cls.tier !== c.expectNoReplyTier
    ) {
      report.problems.push(
        `classified no_reply_needed at tier ${cls.tier}, expected tier ${c.expectNoReplyTier}`,
      );
      report.outcome = "fail";
    } else {
      report.outcome = "pass";
    }
    if (c.expectedToFail) {
      if (report.outcome === "fail") report.outcome = "xfail";
      else if (report.outcome === "pass") report.outcome = "xpass";
    }
    return report;
  }

  if (opts.offline) {
    if (!saved) {
      report.problems.push("no cached output; run a live eval first");
      return report;
    }
    report.draftSource = saved.hash === hash ? "cached" : "stale cache";
    if (report.draftSource === "stale cache") {
      report.problems.push(
        "case or prompt sources changed since this output was drafted",
      );
    }
  } else if (saved && saved.hash === hash && !opts.force) {
    report.draftSource = "cached";
  } else {
    const result = await runDraftCase(c);
    spend(report.spent, result.usage);
    saved = {
      case_id: c.id,
      hash,
      generated_at: new Date().toISOString(),
      draft: result.draft ?? null,
      create_item_calls: result.createItemCalls,
      final_text: result.finalText,
      usage: result.usage,
      ...(result.classification
        ? { classification: result.classification }
        : {}),
    };
    writeOutput(saved);
    report.draftSource = "fresh";
  }

  const body = saved?.draft?.body;
  // Over-blocking guards (GH-115): this case expects a normal draft, so a
  // no-reply classification, from the run itself or from the always-on
  // deterministic tiers, is a failure.
  if (saved?.classification) {
    report.problems.push(
      `classified no_reply_needed at tier ${saved.classification.tier} (${saved.classification.reason}) but this case expects a draft`,
    );
    report.outcome = "fail";
  } else if (detGate) {
    report.problems.push(
      `deterministic no-reply tier ${detGate.tier} would misclassify this email: ${detGate.reason}`,
    );
    report.outcome = "fail";
  } else if (typeof body !== "string" || body.length === 0) {
    report.problems.push(
      `no draft captured (create_item calls: ${saved?.create_item_calls ?? 0})`,
    );
    report.outcome = "fail";
  } else {
    report.checks = runChecks(c.checks, body, fixtureText(c));
    for (const r of report.checks) {
      if (!r.pass) {
        report.problems.push(`${r.label}: ${r.detail ?? "failed"}`);
      }
    }
    const detPass = allPass(report.checks);

    if (c.rubric && detPass) {
      if (opts.offline) {
        report.judge = { criteria: {}, notes: "", source: "skipped" };
      } else {
        const rh = rubricHash(c.rubric);
        const reusable =
          report.draftSource === "cached" &&
          saved!.judge &&
          saved!.judge.rubric_hash === rh &&
          !opts.force;
        if (reusable) {
          report.judge = {
            criteria: saved!.judge!.criteria,
            notes: saved!.judge!.notes,
            source: "cached",
          };
        } else {
          const verdict = await judgeCase(c, body);
          spend(report.spent, verdict.usage);
          const output: SavedOutput = {
            ...saved!,
            judge: {
              rubric_hash: rh,
              criteria: verdict.criteria,
              notes: verdict.notes,
              usage: verdict.usage,
            },
          };
          writeOutput(output);
          report.judge = {
            criteria: verdict.criteria,
            notes: verdict.notes,
            source: "fresh",
          };
        }
        for (const [num, ok] of Object.entries(report.judge.criteria)) {
          if (!ok) {
            report.problems.push(
              `judge criterion ${num} failed: ${c.rubric[Number(num) - 1] ?? ""}` +
                (report.judge.notes ? ` (judge: ${report.judge.notes})` : ""),
            );
          }
        }
      }
    }

    const judged = report.judge && report.judge.source !== "skipped";
    const judgePass = !judged || allPass(
      Object.entries(report.judge!.criteria).map(([, pass]) => ({ pass })),
    );
    report.outcome = detPass && judgePass ? "pass" : "fail";
  }

  if (c.expectedToFail) {
    if (report.outcome === "fail") report.outcome = "xfail";
    else if (report.outcome === "pass") report.outcome = "xpass";
  }
  return report;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function scorecard(reports: CaseReport[]): void {
  const rows = reports.map((r) => {
    const checks = r.checks
      ? `${r.checks.filter((x) => x.pass).length}/${r.checks.length}`
      : "-";
    const judge = !r.c.rubric
      ? "-"
      : !r.judge || r.judge.source === "skipped"
        ? "skip"
        : `${Object.values(r.judge.criteria).filter(Boolean).length}/${r.c.rubric.length}` +
          (r.judge.source === "cached" ? " (cached)" : "");
    const tokens =
      r.spent.input + r.spent.output === 0
        ? "0"
        : `in ${r.spent.input} out ${r.spent.output}`;
    const outcome =
      r.outcome === "xfail"
        ? "FAIL (expected)"
        : r.outcome === "xpass"
          ? "PASS (remove expectedToFail)"
          : r.outcome.toUpperCase();
    return [r.c.id, r.draftSource, checks, judge, tokens, outcome];
  });
  const header = ["case", "draft", "checks", "judge", "tokens", "result"];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
  const line = (cols: string[]) =>
    cols.map((col, i) => pad(col, widths[i]!)).join("  ");
  console.log("");
  console.log(line(header));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(row));
  console.log("");
  for (const r of reports) {
    if (r.problems.length > 0) {
      console.log(`${r.c.id}:`);
      for (const p of r.problems) console.log(`  - ${p}`);
    }
  }
  const totalIn = reports.reduce((n, r) => n + r.spent.input, 0);
  const totalOut = reports.reduce((n, r) => n + r.spent.output, 0);
  console.log(
    `tokens spent this run: input ${totalIn} (incl. cache) output ${totalOut}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const force = args.includes("--force");
  const caseFlag = args.indexOf("--case");
  const only = caseFlag >= 0 ? args[caseFlag + 1] : undefined;
  if (caseFlag >= 0 && !only) {
    throw new Error("--case requires a case id");
  }

  const dir = casesDir();
  if (!existsSync(dir)) throw new Error(`no cases directory at ${dir}`);
  let cases = loadCases(dir);
  if (only) {
    cases = cases.filter((c) => c.id === only);
    if (cases.length === 0) throw new Error(`no case with id "${only}"`);
  }

  const reports: CaseReport[] = [];
  for (const c of cases) {
    console.log(`[eval] ${c.id}${offline ? " (offline)" : ""}`);
    reports.push(await runOne(c, { offline, force }));
  }
  scorecard(reports);

  const failed = reports.filter((r) => r.outcome === "fail");
  const skipped = reports.filter((r) => r.outcome === "skipped");
  if (skipped.length > 0) {
    console.log(
      `note: ${skipped.length} case(s) skipped (no cached output in offline mode)`,
    );
  }
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((r) => r.c.id).join(", ")}`);
    process.exit(1);
  }
  console.log("eval suite green");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
