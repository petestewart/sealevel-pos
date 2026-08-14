# Campaign sending (SEA-84): how it fires, and what to do before the first real send

The send-gate. `campaigns.send` is the pure-code BullMQ job that actually
mails a campaign: enqueued by the console's Approve click (via
`onCampaignApproved`), immediately or as a delayed job for
`campaigns.send_at`, delivering the frozen SEA-82 audience snapshot the
copy a human approved, through Resend.

## The flow

1. **Approve** (console) commits the decision, then `onCampaignApproved`
   enqueues `campaigns.send` -- delayed to `max(now, send_at)` when the
   campaign row carries a scheduled send time (`send_at` NULL = send on
   approval). A failed enqueue never fails the approval; the monitor's
   `overdue_scheduled` condition is the backstop.
2. **The job** (worker) re-reads everything: campaign must be
   approved/sending, the approved `campaign_approval` item supplies the
   copy byte for byte, the copy is snapshotted durably into
   `campaign_copy_snapshots` (first write wins, per run) BEFORE anything
   leaves, and then recipients are processed in batches.
3. **Per batch**: suppressions and consent are RE-CHECKED per recipient
   (this is what makes `send_at` delays safe; drops are recorded as
   `skipped_suppressed` rows, never silent). Per recipient: the
   `dedupe_key` claim insert (0011: retried jobs re-derive the same key
   and double-send nobody), merge-field rendering, the signed one-click
   unsubscribe link in the body plus `List-Unsubscribe` +
   `List-Unsubscribe-Post` headers (RFC 8058), one Resend request with
   `Idempotency-Key` = the dedupe_key.
4. **Warmup ramp**: sends across ALL campaigns in the trailing 24h are
   counted against `CAMPAIGN_SEND_RAMP_PER_DAY`; at the budget the run
   pauses (campaign stays `sending`) and re-enqueues itself delayed.
5. **Done**: `sending -> sent` only when zero rows remain queued.

## Refusals and skips

- `UNSUBSCRIBE_TOKEN_SECRET` or `UNSUBSCRIBE_BASE_URL` unset: the send
  REFUSES, loudly. Never send without a working unsubscribe (CAN-SPAM).
- `RESEND_API_KEY` or `CAMPAIGN_FROM_EMAIL` unset: logged skip, campaign
  stays `approved` (the monitor flags it as overdue).
- Campaign cancelled/draft underneath the job: the job dead-letters.

## Reply-To (optional, recommended)

`CAMPAIGN_FROM_EMAIL` lives on the dedicated news/sending subdomain,
which has no inbound mail (no MX for receiving) -- a human hitting Reply
would bounce. `CAMPAIGN_REPLY_TO` routes replies to the monitored studio
inbox instead:

| Variable | Required | Purpose |
| --- | --- | --- |
| `CAMPAIGN_REPLY_TO` | no | Reply-To on every campaign email, e.g. `hello@sealevelhotyoga.com` (the monitored studio inbox). Unset = no `reply_to` field on the Resend request at all (today's behavior). NOT a gate: a value without `@` is warned about loudly and omitted -- a typo'd reply-to never blocks a send |

## The unsubscribe endpoint

`GET/POST /unsubscribe?token=...` on the worker (same surface as
`/webhooks/resend`). The token is HMAC-signed over (campaign id, contact
id); not enumerable, timing-safe verified, deliberately replayable (both
writes are idempotent). One valid click writes the `suppressions` row
(email-keyed, reason `unsubscribe`) and appends `consent_events` (state
`unsubscribed`, source `unsubscribe_link`). No login, no preference maze.

## Warmup ramp plan (dedicated subdomain, per the automation-suite doc)

Never blast a cold subdomain. `CAMPAIGN_SEND_RAMP_PER_DAY` defaults to
200/day; a reasonable ramp once real sending starts, adjusting on
deliverability (watch the monitor's complaint/bounce alerts and Resend's
dashboard):

| Week | RAMP_PER_DAY |
| --- | --- |
| 1 | 200 (default) |
| 2 | 500 |
| 3 | 1000 |
| 4+ | 2000+, or remove the ceiling gradually |

The studio's whole list is low tens of thousands, so week 3-4 capacity
already covers any single campaign.

## Before the first real send (Pete's checklist)

1. **Resend account + dedicated subdomain**: add e.g.
   `mail.sealevelhotyoga.com` in Resend, create the DNS records it asks
   for (SPF, DKIM, MX for the subdomain) in Cloudflare, wait for
   Verified. Never the transactional Gmail identity.
2. **Railway worker env** (see docs/infrastructure.md):
   `RESEND_API_KEY`, `CAMPAIGN_FROM_EMAIL` (on the verified subdomain),
   `UNSUBSCRIBE_TOKEN_SECRET` (long random string, e.g.
   `openssl rand -hex 32`), `UNSUBSCRIBE_BASE_URL` (the worker's public
   https URL), `RESEND_WEBHOOK_SECRET` (from the Resend webhook config,
   SEA-85). Optional but recommended: `CAMPAIGN_REPLY_TO` (see the
   Reply-To section above). Optional tuning:
   `CAMPAIGN_SEND_RAMP_PER_DAY` etc.
3. **Migrate**: deploy runs `npm run migrate` (0018 adds
   `campaigns.send_at` + `campaign_copy_snapshots`).
4. **Resend webhook**: point Resend's webhook at
   `https://<worker>/webhooks/resend` (delivered/opened/clicked/bounced/
   complained) if not already done for SEA-85.
5. **Inbox test** (the ticket's done-when): a one-recipient campaign to
   your own address. Verify: the email lands (check spam), merge fields
   rendered, the unsubscribe link works in one click (and the row
   appears in `suppressions` + `consent_events`), Gmail shows the
   native "Unsubscribe" affordance (List-Unsubscribe headers), the
   campaign row reaches `sent`, and the Resend webhook writes
   `campaign_events` rows for the send.
6. **Scheduled-send test**: approve a campaign with `send_at` ~10 min
   out; confirm the console shows the schedule, the send fires on time,
   and an unsubscribe clicked BEFORE the fire results in a
   `skipped_suppressed` row instead of a delivery.
