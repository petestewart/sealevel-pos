# AI Manager — Initial System Architecture

This is the architecture for Sealevel Hot Yoga's "AI Manager": an always-on system that ingests events (Mindbody webhooks, schedules, inbound email/SMS/chat), runs Claude per task to analyze data and handle managerial knowledge-work, routes approvals and notifications to Pete and Alison, and surfaces everything through a role-aware operator console. It is built homegrown on the Anthropic SDK for the parts that are the system's special sauce (job/feature composition, Mindbody integration, task logic) and adopts off-the-shelf tools for the commodity layers (notifications, BI, auth). It is designed to be added to and changed continuously: new capabilities are self-contained **feature modules**, and the dashboard is built so most change is config or user self-service, not code.

The Mindbody half is gated on owner-authorized API access, which depends on the acquisition closing or Kathy granting a sandbox/activation. All technical facts about the Mindbody API are cited to its developer docs (see Sources); the rest is design.

## Design principles

1. **Optimize for change, not first-time correctness.** The set of jobs, tools, and dashboards will churn and grow. Everything is a plug-in module; the core is written once and reads from registries.
2. **Buy the commodity, build the core.** Adopt Novu (notifications), Metabase (BI), and Clerk/Auth.js (auth). Build the job/feature system and the operator console, because that composition is the system's value.
3. **Two lanes over one core.** Async work (events → queue → brain) and live conversations (SMS/web → ordered turns → brain) share one brain and one tool library.
4. **One backbone.** A single `items` table is the source of truth for "what needs attention," powering dashboard counts, the approval inbox, and notification routing alike.
5. **Push change down the cost ladder.** Most "the dashboard changed" requests should land on user self-service or config, not a deploy.

## Core concepts: Tools, Jobs, Feature Modules, Items

- **Tools = capabilities (code).** `mindbody`, `gmail`, `twilio`, `social`, `knowledgeBase`, `warehouseQuery`. The verbs the agent *can* do. Added rarely; each is real engineering. Outbound/destructive tools carry idempotency keys and may be gated behind approval.
- **Jobs = routines (mostly declarative).** A trigger + a prompt + which tools it may use. Added constantly; mostly prose.
- **Feature modules = vertical slices.** A domain (email, social, expenses, analytics) bundles its jobs, tools, item types, dashboard widget, and default notification prefs in one folder. Drop it in and it shows up everywhere it should.
- **Items = the backbone.** Everything needing human attention is a row in `items` with a lifecycle (`open → resolved`). Dashboard counts, approvals, and notifications all derive from it.

## Architecture at a Glance

```
  INBOUND                    CORE                              DATA + SURFACES
  ───────                    ────                              ───────────────
  Mindbody webhooks ┐
  Schedules (cron)  ┼─▶ HEARTBEAT ─▶ BullMQ ─▶ BRAIN ──────┐
  Inbound email     ┘   (route to    (retry,   (Claude tool │
                         jobs)        repeatable, runner,    │
                                      per-session) scoped     │
                                                   tools)     ▼
  SMS / web chat ──────▶ CONVERSATION LANE ─────▶ (same ────▶ ACTIONS ──┬─▶ Postgres
                         (session-ordered turns)   brain)               │     • items / sessions
                                                                        │     • system of record
                                                                        │     • warehouse (raw)
                                                                        ├─▶ Gmail / Twilio / Social
                                                                        ├─▶ git wiki
                                                                        └─▶ Novu ─▶ Pete / Alison
                                                                              (per-user routing)

  Postgres(raw) ─▶ dbt (tested marts = metrics layer) ─▶ Metabase (humans)
                                                       └▶ BRAIN (text-to-SQL + code-exec)

  Operator Console (Next.js): widget registry • RBAC • per-user layout • approval inbox
```

Three structural layers: a thin **inbound** edge (webhooks, schedules, inbound messages), a shared **core** (queue + brain + tools), and **data + surfaces** (Postgres, the analytics stack, the console, and outbound channels).

## The two lanes

Both lanes run through BullMQ for uniform logging, retry, and observability. They differ in shape.

### Async lane

Events → `BullMQ` → worker → brain → done. Used for analysis, drafting, campaigns, expense processing, social monitoring. The heartbeat matches an inbound event to the jobs whose triggers fire, and enqueues each with a deterministic `jobId` for idempotency.

### Conversation lane

Inbound SMS (Twilio) or website chat → a turn job on BullMQ → brain (with session history) → reply. Two things are mandatory because a turn has side effects:

- **Per-session ordering.** Two inbound messages from the same person must process one at a time, in order. Enforced with a Redis lock keyed by session id around the turn. Without it, a fast double-message produces interleaved replies.
- **Retry-safe outbound.** A retried turn must not double-send an SMS or double-book a class. Low `attempts`; outbound tools carry idempotency keys (Twilio supports them; bookings dedupe on a natural key).

**Streaming (deferred, by design).** The website chatbot starts **non-streaming**: a "typing…" indicator, then the full reply, served through BullMQ like everything else. A queue worker cannot stream tokens back to the browser, so streaming requires running that one endpoint inline (synchronous handler runs the brain and streams; BullMQ used only for the resulting booking write + transcript log). The brain is built streaming-ready (the SDK supports it), and the website chat endpoint is isolated so flipping it to inline-streaming is a contained change, not a rebuild. This is a planned near-term upgrade, not a maybe. SMS never streams and stays on BullMQ permanently.

## Queue layer: BullMQ on Redis

BullMQ provides retries with backoff, repeatable (cron) jobs, concurrency limits, dead-letter, idempotent dedup, and a UI (Bull Board) out of the box — so adopting it *removes* hand-rolled code. The only cost is one Redis (a near-free serverless instance like Upstash at this volume).

- **Repeatable jobs** drive scheduled routines (replaces `node-cron`).
- **Deterministic `jobId`** gives free idempotency for Mindbody's "no replay, possible duplicates" webhooks.
- **Concurrency limit** prevents many Claude runs firing at once.

**Not Temporal — yet.** Temporal's durable long-horizon orchestration is operational weight aimed at problems a one-person studio doesn't have. Human-in-the-loop waits are handled by decomposing them into two events joined by durable state (see Approvals). Revisit Temporal only if jobs become genuinely multi-day branching workflows.

## The brain

Claude via the Anthropic SDK **tool runner** (the "custom agent with your own tools" tier). Per job/turn, it loads the job's instructions and *only that job's tools*, then runs the agentic loop.

```typescript
// src/brain/run.ts
import Anthropic from "@anthropic-ai/sdk";
import { jobById } from "../jobs";
import { toolsByName } from "../tools/registry";
import { SYSTEM_PROMPT } from "./prompts";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

export async function runJob(jobId: string, payload: unknown) {
  const job = jobById.get(jobId);
  if (!job) throw new Error(`unknown job: ${jobId}`);

  const finalMessage = await client.beta.messages.toolRunner({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    tools: job.tools.map((name) => toolsByName[name]), // scoped per job
    messages: [{ role: "user", content: job.instructions({ payload }) }],
  });

  // Tool side effects already happened in the runner. Throw → BullMQ retries.
  return finalMessage.stop_reason;
}
```

Scoping tools per job keeps the model focused and limits blast radius. Conversation turns use the same runner with the session's message history loaded.

## Data layer: Postgres

Postgres is both the **system of record** (operational state) and the **warehouse** (analytics). One database now; split later only if volume demands.

System-of-record tables (illustrative):

```
items(id, type, domain, status, audience, assignee, payload, created_at, resolved_at)
  -- the backbone: emails to answer, posts to approve, anomalies, expenses to review
sessions(id, channel, contact, status, created_at)          -- conversation lane
messages(id, session_id, role, body, created_at)            -- turn history
content_queue(id, channel, draft, status, scheduled_for)    -- social/campaign drafts
campaigns(id, name, steps_json, audience_json, schedule, status)
expenses(id, vendor, amount, category, receipt_file, status, period)
users(id, name, role)                                       -- Pete, Alison, later manager/instructor
dashboard_layouts(user_id, widget_id, position, visible)    -- per-user arrangement
notification_prefs(user_id, event_type, channel, enabled, digest, quiet_hours)
```

The `items` table is deliberately generic: a new domain writes a new `type`, and it appears in dashboard counts, the approval inbox, and notification routing automatically.

## Analytics stack (the enterprise-shaped pattern, right-sized)

```
Mindbody ──incremental sync──▶ Postgres (raw/staging)
Weather  ──backfill (Open-Meteo)──▶ dim_weather
                                         │
                                       dbt  ◀── versioned, TESTED SQL models
                                         │      (= the metrics / semantic layer)
                                         ▼
                                  curated marts  ──▶ Metabase (humans)
                                         └──────────▶ BRAIN: text-to-SQL + code-exec
```

- **Warehouse:** Postgres (no Snowflake/BigQuery needed for one studio).
- **Dimensional model:** star schema — facts (`fact_visit`, `fact_payment`) + dimensions (`dim_client`, `dim_class`, `dim_date`, `dim_weather`). Makes "attendance vs payment type / time of day / weather" a clean join.
- **dbt** defines every metric as a versioned, tested SQL model in git ("repeat-visit rate," "retention by acquisition channel," "fill rate by time-of-day"). This is what makes the numbers trustworthy and reproducible — the metric definition is the citable source, matching the confirmed-vs-inferred discipline.
- **Metabase** (free, self-host) over the marts for human exploration, embeddable in the console.
- **The AI queries the curated marts, never raw tables** (consistent numbers), via a text-to-SQL tool plus a code-execution tool for stats SQL can't express, then *interprets* the results — it never eyeballs raw rows.
- **Ingestion:** incremental sync (webhook deltas + scheduled backfill) with idempotent upserts into raw; dbt transforms raw → marts on a schedule.

## Jobs and the registry

A job is one self-contained object; one file per job in `src/jobs/` (or inside a feature module).

```typescript
// src/jobs/types.ts
export interface Job {
  id: string;
  enabled: boolean;
  triggers: Trigger[];
  tools: string[];                              // scoped capability names
  instructions: (ctx: JobContext) => string;   // the prompt
}
export type Trigger =
  | { kind: "cron"; expr: string }
  | { kind: "webhook"; eventType: string }
  | { kind: "email"; match: RegExp }
  | { kind: "manual" };                         // fire by hand (CLI/dashboard)
```

```typescript
// example job — almost entirely prose
export const retentionSweep: Job = {
  id: "weekly.retention_sweep",
  enabled: true,
  triggers: [{ kind: "cron", expr: "0 8 * * 1" }],
  tools: ["warehouseQuery", "gmail", "knowledgeBase"],
  instructions: () => `
    Query the marts for clients lapsed 21+ days and classes under 60% fill.
    Draft a short outreach email per lapsed client for Pete to review (create
    items of type 'email_reply'). Email Pete a digest. Log to the wiki.
    No em dashes; sign off as the AI Manager.
  `,
};
```

The registry collects jobs; the core reads from it, so there are no per-job core edits:

```typescript
export const JOBS = [retentionSweep, /* ... */].filter((j) => j.enabled);
export const jobById = new Map(JOBS.map((j) => [j.id, j]));
```

Adding = new file. Removing = delete or `enabled: false`. Updating = edit the prose.

## Tools and outbound guardrails

Tools use the `betaZodTool` shape (Zod schema + `run`), looked up by name so jobs scope to what they need:

```typescript
export const gmailTool = betaZodTool({
  name: "send_alert_to_pete",
  description: "Email an alert: anomalies, shrinkage flags, a class trending empty, items needing a human.",
  inputSchema: z.object({
    subject: z.string(),
    body: z.string().describe("Plain, brief. No em dashes. Sign off as the AI Manager."),
    urgency: z.enum(["fyi", "soon", "now"]),
  }),
  run: async ({ subject, body, urgency }) => { /* via Novu or direct */ return "sent"; },
});
```

Outbound/destructive tools (post to social, send campaign, book a class) are **idempotent** (idempotency keys / natural-key dedupe) and may be **approval-gated** — they create a `pending_approval` item instead of acting directly (see Approvals). This keeps a misfire from blasting the client list.

**The drafter's knowledge tools (shipped).** The email drafting job's knowledge base is the **sealevel-mcp-server** (a Cloudflare Worker serving MCP over Streamable HTTP, backed by D1). The worker connects as an MCP client with a service token (`SEALEVEL_MCP_URL` + `SEALEVEL_MCP_TOKEN`; unset = jobs run KB-less) and exposes a curated, strictly read-only toolset to the brain (`packages/core/src/tools/kb.ts`):

- `search_wiki` / `read_wiki_page`: the studio wiki, for **policies and studio information only**.
- `upcoming_classes`: the live class schedule from Mindbody (customer-safe fields: class type, date, time, teacher, spots).
- `class_pricing`: the live published purchase options (drop-in, packs, memberships, intro offers).

The **knowledge routing rule**: pricing and schedule come exclusively from the live tools, never the wiki, where they would go stale and disagree; the wiki holds only general, durable, canonical studio facts. The server enforces the same read-only scoping for the service identity, so the client-side allowlist is defense in depth. Every lookup is logged onto the item as `payload.sources` for the approving human; KB write-back is designed (human-gated, separate writer identity) in `docs/design/kb-write-back.md` but not built.

## Approvals: a durable state machine, not a long wait

"Draft → wait for a human → act" (social posts, campaign sends, sometimes email replies) is decomposed into two events joined by durable state:

1. **Job A** produces a draft and writes an `items` row `status='pending_approval'`.
2. Pete/Alison approve (or edit-then-approve / reject) in the **operator console**.
3. The approval flips status and emits an event that triggers **Job B**, which performs the action via the idempotent outbound tool.

No in-process waiting, no Temporal — just two BullMQ jobs and a state row. The console is the approval surface; one-click email-link approval can be layered on later.

**Shipped for email (GH-95/GH-97, `docs/gmail-ingestion.md`).** The email lane runs this state machine end to end against a real mailbox:

- **Inbound**: a repeatable poll ingests unread studio Gmail, dispatches each message to the drafting job by email trigger, and marks it processed only after dispatch. Three idempotency layers (processed label excluded from the poll query, deterministic BullMQ jobId, item `dedupe_key`) mean duplicates never produce duplicate drafts.
- **Outbound**: Approve in the console enqueues Job B (`email.send`); the worker atomically claims the item and either **delivers** the threaded reply from the studio address (`GMAIL_SEND_MODE=send`) or **parks a Gmail draft** for a human to send from Gmail (`GMAIL_SEND_MODE=draft`, the safer default posture). The Approve click is the only trigger; with `GMAIL_SEND_ENABLED` unset, approvals record the decision and nothing leaves the building.
- **The gate is split across services** so the Gmail refresh token never sits on the web-facing console: the **console** gates on the flag alone (`gmailSendEnabled`, no credential check) to decide whether an approval enqueues Job B and what the delivery copy says; the **worker** gates on the full four Gmail credentials plus the flag (`gmailSendConfigured`) and re-checks before acting, so a job enqueued while the worker lacks creds is skipped, never half-sent.

**Run trace.** Every drafting run stamps the worker's built commit on the item it creates (`payload.generated_by`, from `RAILWAY_GIT_COMMIT_SHA` via `packages/core/src/version.ts`), so "which code drafted this?" is a lookup, not a deploy-timeline reconstruction.

## Operator console — designed for continuous change

Built in **Next.js** over Postgres, reading from a **widget registry** (the same plug-in philosophy as jobs). Three concerns kept separate: **items** (data), **dashboards** (pull), **notifications** (push).

A widget is a module:

```typescript
interface Widget {
  id: string;
  domain: string;
  requires: Permission;                 // RBAC gate
  summary: (userId: string) => Promise<{ count: number; label: string; status: string }>; // overview card
  detailRoute: string;                  // drill-in view
}
```

- **Main view** renders one summary card per widget the user is permitted to see, in their saved order; each links to its detail view.
- **Detail views** are the per-domain dashboards (email inbox + draft review; social calendar + approval queue; analytics = embedded Metabase).
- **RBAC + per-user layout:** `users.role` gates which widgets exist for a user; `dashboard_layouts` stores personal arrangement. Pete and Alison get different role defaults and can each tailor. Scales to manager/instructor roles later as new permission sets, not new code.

**The cost ladder — keep change cheap:**

1. **User self-service (no engineering):** users reorder, show/hide, pin cards from a catalog of permitted widgets. Absorbs most layout churn.
2. **Config, not deploy:** default widgets per role, ordering, thresholds live in Postgres rows — editable without a release.
3. **Code (rare):** a genuinely new *kind* of view = drop in one isolated widget module.

Plus: a **stable backbone** (`items` + query layer doesn't change) under churning presentation, and **isolated widgets** (rewrite/replace/delete one without touching others). Component layer: Tremor (KPI cards) + shadcn/ui; optionally React-Admin/AdminJS for RBAC+CRUD scaffolding.

## Notifications — adopt Novu

Notifications are push and **separate from the dashboard**. On item creation/state change, emit a typed event; Novu routes it per user, per event type, per channel, with digests and quiet hours, and supplies an in-app inbox UI.

```
notification_prefs(user_id, event_type, channel, enabled, digest, quiet_hours)
  channel = sms | email | push | in_app | dashboard_only
```

Same event routes differently: a `social_approval` pings Pete by SMS instantly and never reaches Alison; an `anomaly` emails Alison instantly and digests for Pete. Sends run as BullMQ jobs, so delivery inherits retry/dedup. Novu replaces the entire hand-rolled router.

## Assignment & routing

Any item can be assigned to a person — assignment is a general property of the items backbone (`items.assignee`), not an email-only feature. Email is simply the first consumer: an inbound Sealevel email becomes an `items` row (`type=email_reply`, `status=unassigned`), and you or the AI set the assignee.

- **Manual or AI-assisted routing.** Assign in the dashboard, or a job classifies the email and suggests/sets an assignee by rule (billing → Pete, schedule/instructor → Alison, finance/investor → Brooke), always overridable. AI suggests; a human confirms — or auto-assign with easy reassignment.
- **Per-person dashboards.** Each person's view is `items WHERE assignee = me`, plus an "unassigned" queue and, for the owner, an "all" view — the per-user dashboard already described, filtered by assignee.
- **Forward as notification, not as the reply channel.** On assignment, an `item_assigned` event routes through Novu per the assignee's prefs. A forward to a personal inbox is an **FYI + a link to review the AI draft** — not where the reply is written. The actual reply goes out **from the Sealevel address, composed/approved in the dashboard**, so threading and the business identity stay intact.
- **Audit.** Assignment and reassignment are logged (who assigned what, when) as assignment history on the item.
- **People who aren't operators (Brooke).** Brooke is a committed co-owner/investor, not day-to-day staff, and her hands-on involvement is TBD. For now she is **forward-only**: items can be assigned to her and forwarded to her personal inbox, with no dashboard login. When her involvement firms up, a **collaborator role** is a pure drop-in — a role + a dashboard filter showing only items assigned to her, no rework — the same RBAC machinery that later serves manager/instructor roles.

## Auth/identity — adopt

Multi-user RBAC needs real auth; do not roll it. **Clerk** (orgs/roles built in) or **Auth.js (NextAuth)** if you want free + self-owned. Roles defined here back the dashboard RBAC and notification routing.

## Feature module = vertical slice

A capability bundles its whole vertical so adding one is additive and self-contained:

```
features/social/
  jobs/         ← draft, queue, post-on-approval
  tools/        ← platform API tools (idempotent)
  itemTypes.ts  ← "social_approval"
  widget.tsx    ← overview card + detail view
  notifs.ts     ← default notification prefs
```

Drop it in → it produces items, shows a card to permitted users, routes notifications per each user's prefs, and is approvable in the console. Same discipline as jobs, now spanning UI and notifications.

## Draft quality evals (shipped)

Email drafting quality is guarded by a golden-case eval suite: cases in `evals/cases` (inbound email + KB/schedule/pricing fixtures + deterministic checks + an optional judge rubric), engine in `packages/core/src/evals/`. Run with `npm run eval` (`--case <id>`, `--offline`, `--force`). Token discipline: free deterministic checks always run first, a case reaches the model judge only if it has a rubric and passed the deterministic tier, and drafts/verdicts are cached by content hash so unchanged cases cost nothing. In CI, the live suite runs on PRs only when a prompt-affecting path changed (drafting job, booking, KB tools, prompts, eval code) and the `ANTHROPIC_API_KEY` repo secret exists; a manual `workflow_dispatch` runs it on demand. Prompt-affecting changes must keep the suite green.

## Channel integrations + compliance

Per-channel tools, each with idempotency and the relevant compliance built in, not bolted on:

- **SMS (Twilio):** inbound webhooks for the conversation lane; outbound with idempotency keys; **TCPA** consent + opt-out (STOP) tracking.
- **Email (Gmail + bulk):** inbound for the email lane; **CAN-SPAM** unsubscribe handling and deliverability for campaigns. The Gmail integration is live in both directions (poll-based ingestion; send or draft-park on approval) via an installed OAuth2 app with a refresh token; see `docs/gmail-ingestion.md`.
- **Social (per platform):** OAuth per platform, posting + read APIs, rate limits.

Consent/opt-out state lives in Postgres and is checked before any outbound marketing send.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node + TypeScript |
| Inbound edge | Express/Fastify (webhooks, Twilio, web chat) |
| Queue + scheduler | BullMQ on Redis (Upstash) |
| LLM | `@anthropic-ai/sdk`, `claude-opus-4-8`, adaptive thinking, tool runner |
| Database + warehouse | Postgres |
| Transformations / metrics | dbt |
| BI / human analytics | Metabase (embedded) |
| Notifications | Novu |
| Auth | Clerk or Auth.js |
| Console | Next.js + Tremor/shadcn (+ optional React-Admin/AdminJS) |
| Hosting | Always-on host + Redis (Fly.io / Railway / VPS) |

Where every piece of configuration lives across hosts (Railway, Clerk, Cloudflare, GitHub Actions) is mapped in `docs/infrastructure.md`.

## Repo structure

```
ai-manager/
  apps/
    worker/                 # heartbeat + BullMQ workers + brain (always-on)
    console/                # Next.js operator console
  packages/
    core/
      brain/                # tool runner, prompts
      queue/                # BullMQ queue, worker, schedule register
      tools/                # registry + mindbody, gmail, twilio, social, warehouseQuery, kb
      jobs/                 # Job/Trigger types + registry
      db/                   # Postgres client, migrations, item helpers
    features/               # vertical slices: email/, social/, analytics/, expenses/, ...
  analytics/
    dbt/                    # sources, staging, marts, tests
  .env                      # secrets (gitignored)
```

## Use cases → where each lands

| Use case | Lane / components |
|---|---|
| Email list + auto-draft | Async lane; `email` feature; `items(email_reply)`; Gmail tool; console email view |
| Mindbody metrics & correlations | Ingestion → Postgres → dbt marts; analysis job uses warehouseQuery + code-exec; Metabase |
| Monitor social activity | Async lane; polling jobs; `social` feature; `social_events` |
| Create/queue/post social on approval | `content_queue` + approval state machine; console approval inbox |
| Missed-call text bot | Conversation lane (Twilio); sessions/messages; per-session ordering |
| Website chat QA + booking | Conversation lane (non-streaming first); Mindbody booking tool (idempotent, guarded) |
| Multi-channel marketing campaigns | `campaigns` + recurring advance job; Twilio/email/social tools; consent checks |
| Expense tracking for CPA | Async lane; receipt parsing (vision/PDF); `expenses` ledger; monthly export job |

Adding the "many more" you expect = a new feature module per the plug-in pattern.

## Mindbody integration — grounded constraints

Quoted/paraphrased from the Mindbody developer docs:

- **Owner activation required.** Build against the **sandbox**, request approval to go live, then request a **site-specific activation code/link for the business owner's account**, which the owner activates. You cannot pull Sealevel's live data on your own credentials — gated on the acquisition closing (or Kathy authorizing access). *[Public API docs]*
- **Review to go live.** Integration apps undergo a review that can take a couple of business days. *[Public API docs]*
- **Per-call pricing.** ~$0.002 per API call since Oct 1, 2023; favors webhook-driven designs over heavy polling. *[API Pricing FAQ]*
- **Webhooks are push, not stored.** Subscriptions are activated by Mindbody; **events are delivered only to active subscriptions at the time they occur and are not stored for later delivery.** Respond `2xx` within **10 seconds** or Mindbody retries every 15 min for up to 3 hours. Queue and make processing **idempotent**. *[Webhooks API docs]*

## Phasing

1. **Now (pre-close):** stand up the core (BullMQ + brain + Postgres + job registry), the console shell (auth + one widget), Novu, and the lanes that need no live studio data — email drafting and the knowledge-base automation. Build against the **Mindbody sandbox**.
2. **At/after close:** obtain the owner activation code, point the Mindbody client at the real site, run ingestion + dbt, enable analytics and the customer-facing bots.
3. **Iterate:** add feature modules one at a time; add tools only for genuinely new capabilities.

## First build checklist

- [ ] Monorepo (`worker` + `console` + shared packages); Postgres + Redis; `.env` gitignored.
- [ ] BullMQ wired: queue, worker (concurrency-capped), repeatable-schedule register, Bull Board.
- [ ] `Job`/`Trigger` types + registry; `items` table + helpers; brain tool runner with scoped tools.
- [ ] Async lane end-to-end: fire a `manual` job that drafts and creates an `email_reply` item.
- [ ] Console shell: Clerk/Auth.js, one widget reading item counts, the approval inbox.
- [ ] Novu wired; one event type routed differently to Pete vs Alison.
- [ ] Conversation lane: Twilio inbound → session-ordered turn → reply; idempotent outbound.
- [ ] Mindbody developer account + sandbox client + a test webhook subscription (confirm dedup).
- [ ] Analytics skeleton: ingestion stub → Postgres raw → one dbt mart → Metabase + a warehouseQuery tool.
- [ ] Deploy to an always-on host; confirm restart-survival, queue drain, dead-letter visibility.

## Sources

- Mindbody Public API V6.0 — https://developers.mindbodyonline.com/ui/documentation/public-api
- Mindbody Webhooks API Documentation — https://developers.mindbodyonline.com/WebhooksDocumentation
- Mindbody API Pricing Change FAQ — https://developers.mindbodyonline.com/ui/faq
- Mindbody Developer Portal — https://developers.mindbodyonline.com/

Last updated: 2026-07-19
