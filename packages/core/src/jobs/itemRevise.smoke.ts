import assert from "node:assert/strict";

import { createItem, resolveItem } from "../db/items.js";
import { getPool } from "../db/client.js";
import { loadEnv } from "../env.js";
import { runJob } from "../brain/run.js";
import { itemRevise, itemReviseTools, reviseJobId } from "./itemRevise.js";

/**
 * item.revise smoke test (same pattern as brain/smoke.ts).
 *
 * Dry-run checks always run and include the GH-36 read-only toolset
 * assertion: the job's entire side-effect surface is the two per-run
 * item-payload tools (update_draft, answer_question) and nothing else.
 *
 * The live section needs the docker compose Postgres (DATABASE_URL) and
 * ANTHROPIC_API_KEY: it seeds a pending email_reply item, runs a revise
 * instruction and a question, and asserts the payload contract for each.
 */

interface LastAnswer {
  question: string;
  answer: string;
  at: string;
}

async function itemPayload(id: string): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM items WHERE id = $1",
    [id],
  );
  assert.ok(rows[0], `item ${id} exists`);
  return rows[0].payload;
}

async function main(): Promise<void> {
  loadEnv();

  // --- Read-only toolset assertion (always runs) ---------------------
  // No registry tools at all: nothing outbound, nothing shared.
  assert.deepEqual(itemRevise.tools, []);
  // The per-run toolset is exactly the two private item-payload tools.
  const toolNames = itemReviseTools("00000000-0000-0000-0000-000000000000")
    .map((t) => t.name)
    .sort();
  assert.deepEqual(toolNames, ["answer_question", "update_draft"]);
  // Job.runtimeTools yields the same set from a payload.
  const fromJob = (itemRevise.runtimeTools?.({
    payload: { itemId: "x", instruction: "y" },
  }) ?? [])
    .map((t) => t.name)
    .sort();
  assert.deepEqual(fromJob, ["answer_question", "update_draft"]);
  console.log(
    "ok: item.revise toolset is read-only: only update_draft + answer_question",
  );

  // Payload validation and deterministic jobId.
  assert.throws(
    () => itemRevise.runtimeTools?.({ payload: {} }),
    /payload\.itemId/,
  );
  assert.equal(reviseJobId("abc", "shorter"), reviseJobId("abc", "shorter"));
  assert.notEqual(reviseJobId("abc", "shorter"), reviseJobId("abc", "longer"));
  assert.match(reviseJobId("abc", "shorter"), /^revise-abc-[0-9a-f]{12}$/);
  console.log("ok: payload validation throws; reviseJobId is deterministic");

  if (!process.env["DATABASE_URL"] || !process.env["ANTHROPIC_API_KEY"]) {
    console.log(
      "skip: DATABASE_URL and/or ANTHROPIC_API_KEY not set; live run not exercised",
    );
    return;
  }

  // --- Live: seed a pending email_reply item --------------------------
  const { item } = await createItem({
    type: "email_reply",
    domain: "email",
    status: "pending_approval",
    payload: {
      original_email: {
        from: "maria@example.com",
        subject: "Question about the Saturday class",
        body: "Hi! Is the 9am Saturday hot vinyasa class suitable for a beginner? Do I need to bring my own mat? Thanks, Maria",
      },
      draft_subject: "Re: Question about the Saturday class",
      draft_body:
        "Hi Maria,\n\nThanks so much for reaching out! Our 9am Saturday hot vinyasa class welcomes beginners, and our instructors are great about offering modifications throughout. You are welcome to bring your own mat, but we also have mats available to rent at the front desk for a small fee. We recommend arriving about 15 minutes early for your first visit so we can get you settled in. Please remember to bring water and a towel, as the room is heated.\n\nWe look forward to seeing you on the mat!\n\nWarmly,\nthe AI Manager",
    },
  });
  console.log(`ok: seeded pending email_reply item ${item.id}`);

  // --- Live: revise instruction ---------------------------------------
  const priorBody = item.payload["draft_body"] as string;
  let stop = await runJob("item.revise", {
    itemId: item.id,
    instruction: "Make it two sentences shorter.",
  });
  let payload = await itemPayload(item.id);
  assert.notEqual(payload["draft_body"], priorBody, "draft body replaced");
  const revisions = payload["draft_revisions"] as Array<
    Record<string, unknown>
  >;
  assert.ok(Array.isArray(revisions) && revisions.length === 1);
  assert.equal(revisions[0]!["draft_body"], priorBody, "prior draft preserved");
  assert.equal(payload["last_answer"], undefined, "no last_answer after revise");
  console.log(
    `ok: revise run (stop_reason=${stop}) replaced the draft and kept history`,
  );

  // --- Live: question --------------------------------------------------
  const revisedBody = payload["draft_body"];
  stop = await runJob("item.revise", {
    itemId: item.id,
    instruction: "What class is she asking about?",
  });
  payload = await itemPayload(item.id);
  assert.equal(payload["draft_body"], revisedBody, "draft untouched by question");
  const la = payload["last_answer"] as LastAnswer;
  assert.ok(la && typeof la.answer === "string" && la.answer.length > 0);
  assert.ok(typeof la.at === "string" && la.at.length > 0);
  assert.match(la.answer.toLowerCase(), /saturday|vinyasa|9\s?am/);
  console.log(
    `ok: question run (stop_reason=${stop}) left the draft alone and wrote last_answer`,
  );

  // --- Live: decided items are not revisable ---------------------------
  await resolveItem(item.id);
  await assert.rejects(
    runJob("item.revise", { itemId: item.id, instruction: "shorter please" }),
    /expected "pending_approval"/,
  );
  console.log("ok: revising a decided item fails instead of mutating it");

  await getPool().end();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
