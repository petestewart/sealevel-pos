# Novu notifications

How item events reach Pete and Alison, and how the same event routes
differently per person (ARCHITECTURE.md "Notifications — adopt Novu").

## How it works

- `packages/core/src/notifications/emit.ts` exposes
  `emitItemEvent(eventType, item, actor?)`. It sends a Novu trigger with a
  typed payload to both configured subscribers.
- One event is wired in v1: creating an item with status
  `pending_approval` (via the brain's `create_item` tool) emits
  `item.pending_approval`.
- With `NOVU_SECRET_KEY` unset, emits are a logged no-op. Local dev and
  tests never need a Novu account.
- The `notification_prefs` table (migration 0003) records the routing
  intent per user, event type, and channel. Enforcement (which channel
  fires, digests, quiet hours) lives in Novu's workflow and subscriber
  preference config, which is dashboard-side; this table is the console's
  source of truth for displaying and editing that intent.

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
4. Create a workflow with the trigger identifier exactly
   `item.pending_approval` (the code maps event types to workflow ids in
   `WORKFLOW_IDS` in packages/core/src/notifications/emit.ts). If the
   dashboard refuses or rewrites the dotted identifier, create the
   workflow as `item-pending-approval` and update that one mapping to
   match, then confirm the event in the Activity Feed. Add two channel
   steps:
   - an SMS step, e.g. "New item awaiting approval: {{payload.itemType}}
     (item {{payload.itemId}})"
   - an email step with a digest stage in front of it (Novu's Digest
     action), so batched items arrive as one email.
5. Configure per-subscriber channel preferences so the same event routes
   differently: in the workflow's preferences (or per subscriber under
   Subscribers > Preferences), enable only SMS for Pete and only email
   for Alison. Result: one trigger, Pete gets an instant SMS, Alison gets
   a digested email. This mirrors the seed rows in `notification_prefs`.
6. Connect providers under Integrations: an SMS provider (Twilio) and an
   email provider. Until providers are connected, triggers succeed but
   deliver nothing.

## Payload reference

Every `item.pending_approval` trigger carries:

```
itemId, itemType, domain, status, assignee, actor, createdAt
```

Use these in workflow templates, e.g. `{{payload.itemType}}`.

Copy rule: no em dashes in any template copy (project convention,
CLAUDE.md).

## Verifying

- Without a key: `npm run smoke:novu --workspace packages/core` checks
  the no-op path, the with-key path via a stubbed trigger, and error
  containment. No network calls.
- With a real `NOVU_SECRET_KEY` in `.env`: the same command also fires
  one real `item.pending_approval` trigger; check the Novu dashboard's
  Activity Feed for the event and its per-subscriber routing.
