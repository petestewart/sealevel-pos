import assert from "node:assert/strict";

import { createKbToolset, KB_PROMPT_GUIDANCE } from "../tools/kb.js";
import { casesDir, caseHash, rubricHash } from "./cache.js";
import { fixtureText, loadCases, parseCase } from "./cases.js";
import { extractPrices, extractTimes, runChecks } from "./checks.js";
import {
  applyCaseEnv,
  fixtureResultFor,
  installFixtureKb,
} from "./fixtures.js";
import { buildJudgePrompt, parseVerdict } from "./judge.js";

/**
 * Offline smoke suite for the eval engine itself (same conventions as
 * gmail.smoke.ts): pure assertions on the deterministic checks, the
 * fixture KB layer, case loading, caching, and judge-verdict parsing.
 * No API key, DB, or network required.
 *
 * Run: npm run smoke:evals  (from packages/core)
 */

const FIXTURES = [
  "Mon 2026-07-20 6:00 pm - 7:15 pm | Hot Vinyasa | Maya Chen",
  "Wed 2026-07-22 7:30 am - 8:45 am | Hot Vinyasa | Maya Chen",
  "Drop-in: $28. New student intro week: $40.",
].join("\n");

function testTimeExtraction(): void {
  const times = extractTimes("Class at 6:00 pm, doors 5:45pm, or 18:00.");
  assert.deepEqual(
    times.map((t) => `${t.h12}:${t.minute} ${t.meridiem}`),
    ["6:0 pm", "5:45 pm", "6:0 pm"],
  );
  // Bare numbers and durations are not clock times.
  assert.equal(extractTimes("Hot 26 runs 75 minutes, room at 105F.").length, 0);
  // "6am" without minutes parses; invalid minutes do not.
  assert.equal(extractTimes("see you at 6am").length, 1);
  assert.equal(extractTimes("code 12:99 is not a time").length, 0);
}

function testNoInventedTimes(): void {
  const ok = (draft: string) =>
    runChecks([{ kind: "noInventedTimes" }], draft, FIXTURES)[0]!.pass;
  assert.equal(ok("Join us Monday at 6:00 pm!"), true);
  assert.equal(ok("Join us Monday at 6 pm!"), true); // minute-less form
  assert.equal(ok("Join us Monday at 18:00."), true); // 24h form
  assert.equal(ok("Wednesday at 7:30 works."), true); // meridiem-less draft
  assert.equal(ok("Join us Monday at 5:00 pm!"), false); // invented hour
  assert.equal(ok("Monday at 6:30 pm."), false); // invented minutes
  assert.equal(ok("Wednesday at 7:30 pm."), false); // wrong meridiem
  assert.equal(ok("No times mentioned at all."), true);
}

function testNoInventedPrices(): void {
  const ok = (draft: string, fixtures = FIXTURES) =>
    runChecks([{ kind: "noInventedPrices" }], draft, fixtures)[0]!.pass;
  assert.equal(ok("A drop-in is $28."), true);
  assert.equal(ok("A drop-in is $ 28.00."), true); // formatting-insensitive
  assert.equal(ok("The intro week is $40 total."), true);
  assert.equal(ok("A drop-in is $25."), false); // invented amount
  assert.equal(ok("A drop-in costs $28, mats $3."), false); // partly invented
  assert.equal(ok("Pricing is on our website."), true); // no amounts stated
  assert.equal(ok("It costs $10.", "no prices here"), false);
  assert.deepEqual(extractPrices("$1,250 and $9.50"), [1250, 9.5]);
}

function testStringChecks(): void {
  const draft = "Our next Hot Vinyasa is Monday with Maya Chen. No dashes.";
  const results = runChecks(
    [
      { kind: "mustContain", pattern: "maya chen" }, // case-insensitive
      { kind: "mustContain", pattern: "mon(day)?", regex: true },
      { kind: "mustNotContain", pattern: "pilates" },
      { kind: "mustContainVerbatim", pattern: "Maya Chen" },
      { kind: "noEmDash" },
    ],
    draft,
    "",
  );
  assert.deepEqual(
    results.map((r) => r.pass),
    [true, true, true, true, true],
  );
  const emDash = runChecks([{ kind: "noEmDash" }], "so — anyway", "")[0]!;
  assert.equal(emDash.pass, false);
  const verbatim = runChecks(
    [{ kind: "mustContainVerbatim", pattern: "https://x.example/Book" }],
    "book at https://x.example/book",
    "",
  )[0]!;
  assert.equal(verbatim.pass, false); // verbatim is case-sensitive
}

function testFixtureMatching(): void {
  const fixtures = [
    { tool: "upcoming_classes" as const, argsInclude: "vinyasa", result: "V" },
    { tool: "upcoming_classes" as const, result: "ALL" },
  ];
  assert.equal(
    fixtureResultFor(fixtures, "upcoming_classes", { class_type: "Vinyasa" }),
    "V",
  );
  assert.equal(fixtureResultFor(fixtures, "upcoming_classes", { days: 7 }), "ALL");
  assert.equal(fixtureResultFor(fixtures, "search_wiki", { query: "x" }), "(no results)");
}

/**
 * End-to-end through the REAL KB toolset: env pinned to the fixture
 * endpoint, fetch intercepted, createKbToolset() untouched. Proves the
 * eval harness serves canned results through the exact production tool
 * code (session init, tool call, logging) with no network.
 */
async function testFixtureKbThroughRealToolset(): Promise<void> {
  const restoreEnv = applyCaseEnv(undefined);
  const uninstall = installFixtureKb([
    { tool: "upcoming_classes", result: FIXTURES },
    { tool: "search_wiki", argsInclude: "price", result: "Pricing page: ..." },
  ]);
  try {
    const { tools, log } = createKbToolset();
    // Assert by name, not count: the KB toolset grows over time (e.g.
    // class_pricing landed while this suite was in review) and the eval
    // harness only requires that the tools it exercises exist. The exact
    // allowlist is itemRevise.smoke.ts's job.
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["search_wiki", "read_wiki_page", "upcoming_classes"]) {
      assert.ok(byName.has(name), `KB toolset missing ${name}`);
    }
    const schedule = await byName.get("upcoming_classes")!.run({ days: 7 });
    assert.equal(schedule, FIXTURES);
    const priced = await byName.get("search_wiki")!.run({ query: "price list" });
    assert.equal(priced, "Pricing page: ...");
    const missed = await byName.get("read_wiki_page")!.run({ name: "Nope" });
    assert.equal(missed, "(no results)");
    assert.equal(log.unavailable, false);
    assert.equal(log.sources.length, 3);
  } finally {
    uninstall();
    restoreEnv();
  }
}

function testEnvRestore(): void {
  const before = process.env["SEALEVEL_MCP_URL"];
  const restore = applyCaseEnv({ SEALEVEL_BOOKING_URL: "https://b.example/x" });
  assert.equal(process.env["SEALEVEL_BOOKING_URL"], "https://b.example/x");
  assert.equal(process.env["DATABASE_URL"], undefined); // hermetic
  restore();
  assert.equal(process.env["SEALEVEL_MCP_URL"], before);
}

function testShippedCasesLoad(): void {
  const cases = loadCases(casesDir());
  assert.ok(cases.length >= 5, `expected at least 5 cases, got ${cases.length}`);
  const ids = cases.map((c) => c.id);
  for (const id of [
    "vinyasa-next-class",
    "quoted-text-only-new-question",
    "no-reply-security-alert",
    "self-service-booking",
    "pricing-unavailable-honesty",
  ]) {
    assert.ok(ids.includes(id), `missing founding case ${id}`);
  }
  for (const c of cases) {
    assert.ok(c.checks.length > 0);
    assert.ok(fixtureText(c) !== undefined);
  }
  // Bad cases are rejected loudly.
  assert.throws(() => parseCase("x.json", `{"id":"x"}`));
  assert.throws(() =>
    parseCase(
      "x.json",
      `{"id":"x","description":"d","inbound":{"from":"a","subject":"b","body":"c"},"checks":[{"kind":"nope"}]}`,
    ),
  );
}

/**
 * Regression for the production miss: a draft that said "I don't have
 * that in front of me right now, but I'll follow up with the details
 * shortly." Both halves (knowledge-state narration and a follow-up
 * promise) must be caught deterministically by the hardened
 * pricing-unavailable-honesty checks, and a compliant draft that routes
 * without narrating gaps must pass every check.
 */
function testNoFollowupAndNoGapNarration(): void {
  const kase = loadCases(casesDir()).find(
    (c) => c.id === "pricing-unavailable-honesty",
  );
  assert.ok(kase, "pricing-unavailable-honesty case exists");
  const fixtures = fixtureText(kase) ?? "";
  const failures = (draft: string) =>
    runChecks(kase.checks, draft, fixtures).filter((r) => !r.pass);

  const productionMiss =
    "Hi Dana! On the drop-in rate, I don't have that in front of me right now, but I'll follow up with the details shortly.\nSealevel Hot Yoga";
  assert.ok(
    failures(productionMiss).length >= 2,
    "the real bad draft fails both the gap-narration and follow-up checks",
  );
  for (const bad of [
    "We will get back to you with pricing soon.",
    "Let me follow up with you on that.",
    "I'm unable to pull up our rates.",
    "We'd need to check the exact price.",
    "I will confirm the rate and then reply.",
  ]) {
    assert.ok(failures(bad).length > 0, `paraphrase caught: ${bad}`);
  }

  const compliant =
    "Hi Dana! We would love to have you while you are in Seattle. We have Hot 26 on Saturday at 9:00 am and Hot Vinyasa on Monday at 6:00 pm. Just reply here if you would like the exact drop-in price and we can help you get set up.\nSealevel Hot Yoga";
  assert.deepEqual(failures(compliant), [], "compliant draft passes all checks");

  // The guidance itself must no longer seed follow-up promises: the old
  // wording ("a teammate will confirm exact pricing shortly") caused the
  // production miss. It must route to the booking page instead.
  assert.ok(
    !/follow up|will confirm|get back/i.test(KB_PROMPT_GUIDANCE),
    "KB guidance suggests no follow-up promises",
  );
  assert.ok(
    /booking page/i.test(KB_PROMPT_GUIDANCE),
    "KB guidance routes to the booking page",
  );
}

function testCaseHashing(): void {
  const a = caseHash(`{"id":"one"}`);
  assert.equal(a, caseHash(`{"id":"one"}`)); // stable
  assert.notEqual(a, caseHash(`{"id":"two"}`)); // content-sensitive
  assert.notEqual(rubricHash(["a"]), rubricHash(["b"]));
}

function testJudgeVerdictParsing(): void {
  const parsed = parseVerdict(
    'Here you go:\n```json\n{"1":true,"2":false,"notes":"quoted question answered"}\n```',
    2,
  );
  assert.deepEqual(parsed.criteria, { "1": true, "2": false });
  assert.equal(parsed.notes, "quoted question answered");
  // A missing criterion counts as a fail, never a silent pass.
  const partial = parseVerdict('{"1":true,"notes":""}', 2);
  assert.deepEqual(partial.criteria, { "1": true, "2": false });
  assert.throws(() => parseVerdict("no json here", 1));
  // Prompt shape: single call, all criteria numbered, compact verdict.
  const prompt = buildJudgePrompt(
    {
      id: "x",
      description: "d",
      inbound: { from: "a@b.c", subject: "s", body: "hello" },
      checks: [{ kind: "noEmDash" }],
      rubric: ["first", "second"],
      raw: "{}",
    },
    "draft body",
  );
  assert.ok(prompt.includes("1. first"));
  assert.ok(prompt.includes("2. second"));
  assert.ok(prompt.includes("report the result via the verdict tool"));
}

async function main(): Promise<void> {
  testTimeExtraction();
  testNoInventedTimes();
  testNoInventedPrices();
  testStringChecks();
  testFixtureMatching();
  await testFixtureKbThroughRealToolset();
  testEnvRestore();
  testShippedCasesLoad();
  testNoFollowupAndNoGapNarration();
  testCaseHashing();
  testJudgeVerdictParsing();
  console.log("evals smoke suite passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
