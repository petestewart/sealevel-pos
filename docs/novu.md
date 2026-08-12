# Novu notifications

How item events reach Pete and Alison, and how the same event routes
differently per person (ARCHITECTURE.md "Notifications — adopt Novu").

## How it works

- `packages/core/src/notifications/emit.ts` exposes
  `emitItemEvent(eventType, item, actor?)` and
  `emitCampaignAlert(payload)`. Each sends a Novu trigger with a typed
  payload to both configured subscribers.
- Three events are wired:
  - `item.pending_approval` (v1): creating an item with status
    `pending_approval` (via the brain's `create_item` tool).
  - `campaign_approval` (SEA-92): a campaign approval item awaits a
    decision. The plumbing is live; the item type itself lands with
    SEA-83, whose only notification duty is calling
    `emitItemEvent("campaign_approval", item, actor)`.
  - `campaign_alert` (SEA-92): the campaign health monitor
    (`packages/core/src/campaigns/monitor.ts`, worker job
    `campaigns.monitor`) found a problem: complaint rate, hard bounce
    rate, a stuck send, or a zero-recipient run. Deduped in
    `campaign_alert_state` (migration 0015) so a persistent condition
    pages once per re-alert window, not every run.
- With `NOVU_SECRET_KEY` unset, emits are a logged no-op. Local dev and
  tests never need a Novu account.
- The `notification_prefs` table (migrations 0003 and 0015) records the
  routing intent per user, event type, and channel. Enforcement (which
  channel fires, digests, quiet hours) lives in Novu's workflow and
  subscriber preference config, which is dashboard-side; this table is
  the console's source of truth for displaying and editing that intent.

## Account and workflow setup

1. Create a Novu account at https://dashboard.novu.co (free tier is fine
   for v1 volume).
2. Get the secret key from Settings > API Keys and set `NOVU_SECRET_KEY`
   in the environment (Railway service variables in prod, `.env` locally).
3. Create two subscribers (Subscribers > Add), one per operator. Use
   stable ids and set them in the environment:
   - `NOVU_SUBSCRIBER_PETE` (default `pete`): add Pete's phone number for
     SMS.
   - `NOVU_SUBSCRIBER_ALISON` (default `alison`): add Alison's email
     address.
4. Create one workflow per event type, trigger identifier exactly as in
   `WORKFLOW_IDS` in packages/core/src/notifications/emit.ts
   (`item.pending_approval`, `campaign_approval`, `campaign_alert`). If
   the dashboard refuses or rewrites an identifier (it slugifies dotted
   ids in some flows), create the workflow with the id it accepts and
   update that one mapping to match, then confirm the event in the
   Activity Feed. Channel steps:
   - `item.pending_approval` and `campaign_approval`: an SMS step, e.g.
     "New item awaiting approval: {{payload.itemType}} (item
     {{payload.itemId}})", and an email step with a digest stage in front
     of it (Novu's Digest action), so batched items arrive as one email.
   - `campaign_alert`: an SMS step and an email step, BOTH instant (no
     digest stage; an alert that waits in a digest defeats its purpose).
     `{{payload.detail}}` is a ready-made one-line summary for either
     template.
5. Configure per-subscriber channel preferences so the same event routes
   differently: in the workflow's preferences (or per subscriber under
   Subscribers > Preferences), enable only SMS for Pete and only email
   for Alison. Result: one trigger, Pete gets an instant SMS, Alison gets
   a digested email (instant email for `campaign_alert`). This mirrors
   the seed rows in `notification_prefs` (migrations 0003 and 0015).
6. Connect providers under Integrations: an SMS provider (Twilio) and an
   email provider. Until providers are connected, triggers succeed but
   deliver nothing.

## Payload reference

Every `item.pending_approval` and `campaign_approval` trigger carries:

```
itemId, itemType, domain, status, assignee, actor, createdAt
```

Every `campaign_alert` trigger carries:

```
alertType, scope, campaignId, campaignKey, rate, threshold,
numerator, denominator, detail, at
```

`alertType` is one of `complaint_rate`, `hard_bounce_rate`,
`stuck_sending`, `zero_recipients`; `scope` is `campaign` or `rolling`;
`detail` is a ready-made human sentence. Thresholds and cadence are env
config with ticket defaults (see docs/infrastructure.md, the
`CAMPAIGN_ALERT_*` and `CAMPAIGNS_MONITOR_CRON` rows).

Use these in workflow templates, e.g. `{{payload.itemType}}`.

Copy rule: no em dashes in any template copy (project convention,
CLAUDE.md).

## Verifying

- Without a key: `npm run smoke:novu --workspace packages/core` checks
  the no-op path, the with-key path via a stubbed trigger, and error
  containment. No network calls. The campaign events (approval emit
  shape, alert thresholds, dedupe) are covered by
  `npm run smoke:campaignmonitor --workspace @ai-manager/core`, also
  fully offline and run in CI.
- With a real `NOVU_SECRET_KEY` in `.env`: the same command also fires
  one real `item.pending_approval` trigger; check the Novu dashboard's
  Activity Feed for the event and its per-subscriber routing.
