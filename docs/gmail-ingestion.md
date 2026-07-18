# Gmail email pipeline: ingestion and send (GH-95)

This wires the email lane to a real mailbox in both directions:

- **Inbound**: a poll pulls unread mail from the studio's Gmail inbox and
  fires the drafting job per message. The system now watches an inbox
  instead of being hand-fed by `apps/worker/src/fire.ts`.
- **Outbound**: approving a draft in the console can actually deliver the
  reply from the studio address, threaded to the original conversation.
  This is Job B in ARCHITECTURE.md's approval state machine. It stays
  behind the human-approval gate and a deployment opt-in, honoring the
  CLAUDE.md "nothing auto-sends in v1" lock.

Everything is **config-gated**, exactly like the knowledge base connection:
with no Gmail credentials the whole layer is inert (ingestion polls
nothing, sending is disabled), so local dev, tests, and a not-yet-
provisioned deploy never touch a real mailbox.

## Configuration (environment)

Required for the Gmail layer to do anything (all four):

| Variable | Meaning |
|---|---|
| `GMAIL_CLIENT_ID` | OAuth2 client id of the installed app |
| `GMAIL_CLIENT_SECRET` | OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | offline refresh token for the studio mailbox |
| `GMAIL_USER` | the mailbox address (used in `From:` and logging) |

Optional (safe defaults):

| Variable | Default | Meaning |
|---|---|---|
| `GMAIL_INGEST_QUERY` | `in:inbox is:unread` | Gmail search for the poll |
| `GMAIL_INGEST_MAX` | `25` | max messages pulled per poll |
| `GMAIL_PROCESSED_LABEL` | `AI-Manager/Ingested` | label added after ingest (empty string disables) |
| `GMAIL_MARK_READ` | `true` | `false` leaves ingested mail unread |
| `GMAIL_POLL_CRON` | `*/2 * * * *` | poll cadence |
| `GMAIL_SEND_ENABLED` | unset (off) | `true` to actually send approved replies |
| `GMAIL_SEND_MODE` | `send` | `send` delivers on approval; `draft` parks a Gmail draft to send manually (GH-97). Inert unless send is enabled |

`GMAIL_SEND_ENABLED` defaults **off** on purpose: standing up the
credentials enables **ingestion** (read + label only, safe) without
silently turning on **outbound delivery**. A human must opt into sending,
and even then nothing goes out until an operator clicks Approve. No secret
is ever logged.

### Getting a refresh token

The app authenticates as an installed OAuth2 client with a long-lived
refresh token (the standard headless-server pattern). One-time setup:

1. In Google Cloud Console, create/select a project and enable the **Gmail
   API**.
2. Configure the **OAuth consent screen**. While it is in "Testing", add
   the studio mailbox as a **Test user**.
3. Create an **OAuth client** of type **Desktop app**; copy the client id
   and secret.
4. From the repo root on your laptop, run the helper and follow the printed
   URL (sign in as the studio mailbox):

   ```
   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy \
     node scripts/gmail/mint-refresh-token.mjs
   ```

   It prints `GMAIL_REFRESH_TOKEN=...`. Put all four values in the worker
   (and console, for send) environment.

The single scope `https://www.googleapis.com/auth/gmail.modify` covers
everything the worker does: read, label, mark read, and send. Access tokens
are refreshed automatically at runtime.

## Inbound: how a message becomes a draft

1. The `email.ingest` repeatable schedule fires on `GMAIL_POLL_CRON`
   (registered on every worker boot; a no-op until Gmail is configured).
2. `ingestInbound` (packages/core/src/gmail/ingest.ts) lists unread message
   ids, fetches each, and parses it into an inbound payload
   (`parseGmailMessage`) carrying both the human fields (from/subject/body)
   and threading metadata (threadId, RFC822 Message-ID, Reply-To).
3. `dispatchInboundEmail` (packages/core/src/jobs/dispatch.ts) reads
   `Job.triggers` and enqueues the message to every job whose
   `{kind:"email", match}` trigger fires. The drafting job (`email.received`)
   has a catch-all email trigger, so every message drafts a reply. This is
   the heartbeat's email dispatch path from ARCHITECTURE.md, which had been
   declared and never read since Phase 0.
4. The message is marked processed (UNREAD removed, processed label added)
   **only after** its dispatch succeeds, so a mid-poll failure leaves it
   for the next poll. Re-dispatch is a no-op (deterministic jobId +
   item `dedupe_key`), so duplicates never produce duplicate drafts.

The drafting job stamps the threading metadata onto the item as
`payload.email_meta` structurally (not through the model's prompt, same
discipline as tags and KB sources), so the model can neither see nor
corrupt it and a later reply threads correctly.

Idempotency has three layers: the ingest marks mail read **and applies the
processed label, which the poll query excludes**, so an ingested message is
never re-fetched (robust even with `GMAIL_MARK_READ=false` and past the 24h
BullMQ dedupe window); the BullMQ jobId (`email-<jobId>-<hash(messageId)>`)
dedupes a duplicate enqueue; and the item `dedupe_key` (the message id)
makes `create_item` return the existing item instead of a second draft.

**Dead-letter caveat.** A message is marked processed once its drafting job
is *enqueued*, not once the draft is *created* (the draft is produced
asynchronously in the brain worker). If the `email.received` job exhausts
its retries (5, with backoff) it lands in BullMQ's failed set, which is the
dead-letter surface (visible in Bull Board) per ARCHITECTURE.md. In that
case the message is already marked processed and no draft exists, so
recovery is via the failed queue, not a re-poll. This is the deliberate
decoupling of the ingest edge from the brain; watch the failed set.

Test the poll by hand after provisioning: `npm run ingest:once` (from
`apps/worker`).

## Outbound: how an approval becomes a sent reply

1. An operator approves a draft in the console. `decideItem` records the
   decision and resolves the item (unchanged).
2. When `GMAIL_SEND_ENABLED` is true, the approve action stamps
   `payload.delivery = {status:"queued"}` (`markDeliveryQueued`, guarded so
   it never re-queues an already-sent item) and enqueues `email.send`
   (Job B) with a deterministic jobId (`send-<itemId>`).
3. The worker runs `sendApprovedReply` (packages/core/src/gmail/send.ts):
   - **atomically claims** the item for sending
     (`claimDeliveryForSend` flips `queued`/`failed`/absent -> `sending` in
     one guarded UPDATE, and returns null if another attempt already sent or
     is sending it). This is the single guard that prevents a double-send.
   - builds a threaded RFC822 reply (`buildRawReply`: To = original
     Reply-To/From, In-Reply-To + References from the original, body as
     UTF-8 base64) and sends it via the Gmail API with the original
     `threadId`.
   - records `payload.delivery = {status:"sent", messageId, to}` on success,
     or `{status:"failed", error}` on failure (and throws so BullMQ
     retries; a retry re-claims safely from `failed`).

The decided view's delivery line (`DeliveryStatus`) reflects real state:
queued, sending, sent (green, with recipient + time), or failed (red). With
sending disabled it keeps the honest "approved, not sent" copy.

### Send vs draft mode (GH-97)

When sending is enabled, `GMAIL_SEND_MODE` chooses what an approval does:

- **`send`** (default, backward compatible): the reply is delivered to the
  customer exactly as above.
- **`draft`**: instead of sending, the worker creates a **Gmail draft** in
  the studio's Drafts folder (`drafts.create`, threaded to the original) and
  records `payload.delivery = {status:"drafted", draftId, to}`. Nothing
  reaches the customer until a human opens Gmail and hits send. This is a
  safer middle ground before fully automated sending.

The mode branches inside `sendApprovedReply` **only after** the atomic claim
and the reply build, so every guarantee is identical across modes:

- The same `claimDeliveryForSend` claim gates both, so a retry or double
  enqueue can never act twice.
- `drafted`, like `sent`, is a terminal success in the never-re-claim set
  (`TERMINAL_OR_INFLIGHT`), so a reopen -> re-approve never parks a second
  draft.
- `createDraft` classifies failures with the **same** ambiguous-vs-not
  scheme as `sendMessage`. A definitely-not-created failure (non-2xx, or a
  pre-request failure) reverts to `failed` and retries; an **ambiguous**
  failure (network timeout, or a 2xx whose body could not be read, so a
  draft may already exist) leaves the item `sending` and is **not** retried.
  `drafts.create` has no idempotency key, so this is the only lever against a
  duplicate draft, mirroring the no-double-send guarantee exactly.

The mode is inert unless `GMAIL_SEND_ENABLED=true`: with sending off an
approval still only records the decision (no send **and** no draft). Set
`GMAIL_SEND_MODE` on **both** the worker (it does the drafting) and the
console (its approve toast and delivery line say "a draft was created"
instead of "sending").

### Why this respects "nothing auto-sends in v1"

The lock means the AI never sends without a human. Here the **operator's
Approve click is the send authorization**, and sending is additionally
gated behind an explicit per-deployment opt-in (`GMAIL_SEND_ENABLED`).
Unset, approvals behave exactly as before: the decision is recorded and
nothing leaves the building.

### Failure and recovery

- A queue hiccup at approval time never fails the recorded approval; the
  reply stays "queued"/"approved, not sent" and can be re-sent by reopening
  and re-approving.
- Send failures are classified to avoid duplicates. A **definitely-not-sent**
  failure (non-2xx response, or a failure before the request left) reverts
  the item to `failed` and retries. An **ambiguous** failure (network
  timeout, or a 2xx whose body could not be read, so the message may already
  be out) leaves the item `sending` and is **not** retried; the decided view
  shows "Send status unclear ... check the sent folder", for a human to
  verify. A hard crash between the Gmail accept and the `sent` write
  likewise leaves the item `sending`, which the claim guard then refuses to
  re-send. Gmail has no send idempotency key, so this classification is the
  only lever; the bias is always to never risk a duplicate email.

## AI assignee suggestion (GH-95)

Alongside tag classification, a small `claude-sonnet-5` call
(`suggestAssignee`) sorts each inbound email into a routing category
(`packages/core/src/routing.ts`: billing -> Pete, schedule -> Alison,
finance -> Brooke, general -> manual triage). The suggestion is stamped on
the item as `payload.assignee_suggestion` and shown in the console as a
one-click chip on an unassigned item. It only ever **suggests**; a human
confirms (no auto-assign in v1). Best-effort: any failure leaves the item
unsuggested and drafting proceeds unchanged.
