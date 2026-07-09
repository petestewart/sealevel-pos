# item.revise: enqueue and poll contract (for the console, GH-37)

The `item.revise` job (packages/core/src/jobs/itemRevise.ts) takes a one-shot
operator instruction about a pending `email_reply` item. The model decides
whether it is an edit or a question:

- Edit ("make it two sentences shorter"): the draft is replaced. The prior
  draft is pushed onto `payload.draft_revisions` (most recent 5 kept, each
  entry `{ draft_subject, draft_body, revised_at }`) and `payload.last_answer`
  is cleared.
- Question ("what class is she asking about?"): the draft is untouched and
  `payload.last_answer = { question, answer, at }` is written.

Both writes are guarded on `status = 'pending_approval'`; if the item is
decided while the job runs, the run fails and nothing is mutated.

## Enqueue (from the console server)

Reuse the generic worker dispatch: the always-on worker runs any BullMQ job
whose name matches a registered job id, so enqueue on the default queue with
the name `item.revise`:

```ts
import {
  createQueue,
  createRedis,
  DEFAULT_QUEUE_NAME,
  enqueue,
  reviseJobId,
} from "@ai-manager/core";

const queue = createQueue(DEFAULT_QUEUE_NAME, createRedis());
await enqueue(
  queue,
  "item.revise",
  { itemId, instruction },
  { jobId: reviseJobId(itemId, instruction) },
);
```

The deterministic jobId (`revise-<itemId>-<sha256(instruction) prefix>`)
makes double-submits of the same instruction idempotent while the prior job
record still exists in Redis (see queue/queue.ts for the window caveat).

## Poll (how the UI knows the run finished)

The job's only outputs are item payload writes, so poll the item row itself
(the console already reads items from Postgres):

1. Snapshot `payload.draft_subject`, `payload.draft_body`, and
   `payload.last_answer` before enqueueing. Do NOT use the length of
   `draft_revisions` as the completion signal: the history is capped at 5
   entries, so it stops growing on the sixth and later revisions.
2. Poll the item every 1-2 seconds. The run is done when either the draft
   subject/body content changed (edit) or `last_answer` changed (question).
3. Optionally also watch the BullMQ job state via `queue.getJob(jobId)`:
   `completed` with no payload change means the model declined to act;
   `failed` carries the error (most commonly: the item was decided before
   or during the run, or the item id was not a pending email_reply).

Failed-run caveat: failed jobs are kept forever (`removeOnFail: false`),
and a kept job record pins its jobId. If a revise run exhausts its retries,
re-submitting the exact same instruction for the same item is a silent
no-op (same deterministic jobId). Surface the failure to the operator and
have them reword the instruction, or remove the failed job first.

Timeout guidance: a run normally completes in well under a minute; treat
several minutes without a payload change or a terminal BullMQ state as a
failure and surface the BullMQ job's error to the operator.
