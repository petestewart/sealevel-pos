# Automation suite: implementation plan

Status: plan, follows the recommendation in `docs/design/automation-suite.md`
(Option 3 now, Option 4 as the declared destination, Option 2 only as a
deployment tactic for credential isolation). Written 2026-07-26. The design
doc's options are settled; this document sequences the build.

Two repos carry work. `ai-manager` owns triggers, judgment, approvals, and
outbound actions. `sealevel-analytics` owns data and metric definitions: any
new metric is a table or `v_*` view there, reached from here only through the
MCP server. Steps below are tagged [AM] (ai-manager) or [SA]
(sealevel-analytics) where it matters.

## 0. Status, updated 2026-08-11

Phases are no longer being started in the order written. Campaign work was
pulled forward and payroll was raised to a top priority. What has landed on
`main` since this plan was written:

- **Phase 0 is done.** `packages/core/src/tools/analytics.ts` (SEA-79, #145)
  ships the analytics-scoped MCP client and toolset (`run_sql`,
  `teacher_performance`, `slot_performance`, `attendance_heatmap`,
  `monthly_financials`) behind `SEALEVEL_MCP_ANALYTICS_TOKEN`, with the
  200-row cap and the 02:00-03:30 PT blackout enforced in code. It was built
  for campaign audience building, but it is the same seam every Engine A and
  Engine B automation reads through, payroll included. Sequencing rows 1 and 2
  (toolset half) are closed.
- **Phase 5 substrate is done.** Migration `0011_campaigns.sql` (SEA-80, #146)
  ships `contacts`, `consent_events`, `suppressions`, `campaigns`,
  `campaign_audience`, `campaign_sends`, `campaign_events`. One consent ledger
  covering both channels, per §2.10, and `contacts.analytics_client_id`
  references upstream identity rather than forking it, per §2.11.

Still open and now on the critical path for payroll:

- **The `registerJobs` hook (row 2, second half) is not built.**
  `packages/core/src/jobs/registry.ts` is unchanged and
  `packages/features/src` is still the placeholder, so no feature module can
  contribute a job yet.
- **The outbound-action map (row 10) is not built, and the duplication it was
  meant to stop has grown.** `packages/core/src/queue/enqueue.ts` now carries
  five instances of the same constant-plus-enqueuer shape (`email.send`,
  `email.gmailState`, `kb.write`, `eval.capture`, `learning.mine`). Payroll
  and invoice forwarding would make seven. Do the generalization before Engine
  B, not after.

## 1. Scope and non-goals

In scope:

- The analytics-scoped MCP identity (the seam everything reads through).
- Engine A (scheduled monitor/report): weekly attendance report, ClassPass
  counts, substitute tracking, in that order.
- The Engine A extraction to config rows (`automations` / `automation_runs`)
  after the third instance, per the rule of three.
- Engine B (document/transaction workflow): invoice-email forwarding, then
  teacher payroll with the QBO integration.
- Engine C (campaigns): email first, SMS behind A2P registration.
- Deletion of the dbt skeleton (`analytics/dbt`); rationale in §2.2.

Explicitly deferred:

- A no-code automation builder beyond the Phase 3 config surface. Editing
  cadence, thresholds, and prompts as rows is in; authoring a brand-new
  automation without a PR is out until the config surface has proven itself.
- Metabase, the conversation lane, social. Untouched by this plan.
- Rebuilding any part of the Mindbody pipeline in TypeScript. Never in scope.

## 2. Single ownership: one home per mechanic

Four repos and a lot of overlapping machinery are in flight. Every mechanic
below has exactly one home; every phase in this plan is checkable against
this table, and a PR that violates a row is wrong even if it works.

**2.1 Metric definitions.** Home: `sealevel-analytics/pipeline/sql/views.sql`
(the `v_*` views), documented in that repo's README. Therefore ai-manager
jobs never embed metric SQL in prompts or TypeScript: a report that needs a
new metric is a PR upstream that adds a view, then the job calls it through
`run_sql`. This is the single most likely place to accidentally fork the
definition of a number.

**2.2 The metric layer itself.** Home: it already exists. `views.sql` plus
`sync_validation_report.txt` plus `validation_failures()` in
`pipeline/mbapi/sync.py` are the versioned, tested metric layer that dbt was
going to be. Standing up dbt now would port working, documented SQL into a
second framework in a second database to gain properties it already has, so
ai-manager's `analytics/dbt` skeleton (a `dbt_project.yml` and three
`.gitkeep` files) is deleted in §9. Revisit condition, stated honestly: if
enough automations need joins between Mindbody data and ai-manager's
operational tables that round-tripping through a read-only MCP tool with a
200-row cap stops working, consolidating into Postgres is on the table, and
dbt is the right way to rebuild the metric layer at that point. Not today,
and keeping the skeleton around does not help when that day comes.

**2.3 Reporting surfaces.** Three exist or are planned:
`exports/decision-tables/*.md` (consumed by a claude.ai project as synced
knowledge), `reports/*.html` on Netlify (hand-built static analyses), and the
future console widget plus `weekly_report` items. Destination: the console.
The Netlify surface is retired once the weekly report has run trusted for two
or three cycles (§4). The decision-table export is frozen (no new tables, no
new consumers) and kept only for the claude.ai project's distinct audience
until Pete retires that project (open decision 5). Three surfaces never
answer the same question with independently maintained logic.

**2.4 Scheduling.** Two cron systems exist and both stay, with a hard line:
GitHub Actions (`.github/workflows/nightly-sync.yml`, `backfill.yml`) owns
data pipeline cadence; BullMQ repeatable jobs (`registerSchedules` +
`cronSchedulesFromJobs` in `packages/core/src/queue/schedules.ts`) own
automation cadence. No automation cron in GitHub Actions, no Mindbody pulling
from the worker. The `scheduled_classes` snapshot (§5b) is data capture, so
it lands in GH Actions; the substitute report reading it is an automation, so
it lands in BullMQ.

**2.5 Data read path.** Home: the sealevel-mcp-server MCP tools. No second
D1 client in ai-manager, no direct SQLite reads, never a committed copy of
`mindbody.db` in this repo. The Phase 0 analytics identity is the only new
access, and it reuses the existing `KbClient` in
`packages/core/src/tools/kb.ts`, which is already documented as generic over
its credential (the KB write-back path is the precedent for a second
identity). No new HTTP client.

**2.6 Approvals and outbound actions.** Home: the shipped state machine
(item written `pending_approval`, human decides in the console via
`decideItem` in `apps/console/src/lib/approvals.ts`, the decision enqueues a
job, the job performs an idempotent outbound action, and the worker re-checks
its own gate before acting, the `gmailSendConfigured` pattern). Engine B
extends this path, never builds a parallel one. The generalization seam: the
per-integration constants in `packages/core/src/queue/enqueue.ts`
(`EMAIL_SEND_JOB`/`enqueueEmailSend`, `KB_WRITE_JOB`/`enqueueKbWrite` are
already two instances of one shape) become a typed outbound-action map keyed
by item type: `{ jobName, jobId(itemId), queue }`, which the console's
approve path consults instead of hardcoding job names. `invoice.forward` and
`payroll.push` are entries in that map, not new pipelines.

**2.7 Items, notifications, widgets, RBAC.** One home each, all
registry-driven and already built: `createItem` plus the `items` table;
`emitItemEvent` plus Novu (`packages/core/src/notifications/emit.ts`); the
widget registry (`apps/console/src/lib/widgets/registry.ts`); the permission
map (`apps/console/src/lib/rbac.ts`). No per-feature bespoke work-queue
table, no per-feature notification routing, no per-feature settings page. A
new feature adds registry entries and a permission, not new plumbing.

**2.8 Idempotency.** One convention, already in use across three layers:
`items.dedupe_key` as the natural key, deterministic BullMQ jobId, and
natural-key upserts upstream. No per-feature invention; every new automation
states its key. Reports: the period (`weekly-2026-W31`). Invoice forwarding:
the source Gmail message id. Payroll: the pay period plus the teacher's
`mb_staff_id`, which is what makes double-invoicing structurally impossible
rather than prompt-hoped. Campaigns: `(campaign_id, contact, step)`.

**2.9 Configuration.** One home with a ladder: owner-editable Postgres rows
(the `rules` table plus `db/settings.ts` is the working precedent), extended
by the `automations` table in Phase 3. Thresholds and cadences do not get
scattered across env vars, hardcoded constants, and prompt text; env vars are
for credentials and deployment posture only. Phases 1 and 2 hardcode cadence
and thresholds in the job files as a deliberate, temporary exception, and
Phase 3's extraction is what makes this rule true rather than aspirational.

**2.10 Consent and opt-out.** One ledger covering email and SMS together
(§8), checked by every outbound marketing send regardless of channel. Not one
table per channel.

**2.11 Identity of people.** Home: the analytics repo's canonical identity
(`teachers` + `teacher_aliases` keyed on `mb_staff_id`; `clients` +
`client_source_ids` resolving Mindbody's dual ID schemes). ai-manager never
maintains its own teacher or client list; it references those keys.
Specifically: the new pay-rate table keys on `mb_staff_id` (the stable
Mindbody staff id), NOT on the local `teachers.teacher_id`, because
`teacher_id` is AUTOINCREMENT, `pipeline/build.py` rebuilds `mindbody.db`
from scratch on every run, and `d1_dump.py` drops and recreates everything
nightly; `mb_staff_id` comes from Mindbody and survives both. Current gap,
verified against the committed db: 2 of 35 teacher rows (Sharon, Tanja) have
NULL `mb_staff_id`, so those rows need backfilling before payroll runs and
the pay-rate lookup needs a documented failure mode for a NULL key. Also:
auto-onboarded teachers land upstream as `role='staff'` pending review, so a
new teacher appearing in a pay run is a review prompt, never a silent new
payee.

**Decision rule for future work**, so this section outlives the seven
automations: is it a definition of a number? Analytics repo, as a view. Is it
a cadence, a threshold, or a judgment? An ai-manager job. Does it need a
human to decide? An item plus the approval state machine. Does it write to
the outside world? A tool with an idempotency key and a worker-side gate
re-check. Is it the third instance of a shape already built twice? Stop and
extract it. That last clause is the rule of three, and it is the mechanism
that keeps Phase 3 from being skipped.

## 3. Phase 0: the analytics seam

ai-manager's only read path into Mindbody data is the MCP server (§2.5), and
the drafter's toolset (`packages/core/src/tools/kb.ts`) deliberately excludes
analytics: the customer-facing service identity is scoped to `search_wiki`,
`read_wiki_page`, `upcoming_classes`, `class_pricing`. Analytics jobs need a
second identity. This is small and unblocks every Engine A instance.

**Server side (sealevel-mcp-server repo, one PR).** Mint a second service
token bound to an analytics-scoped identity, following the exact precedent of
the kb-writer identity (`KB_WRITER_TOKEN`, sealevel-mcp-server PR #26): a
`service:analytics` identity whose toolset is `run_sql`,
`teacher_performance`, `slot_performance`, `attendance_heatmap`,
`monthly_financials`, `class_detail`, all read-only, and nothing
customer-facing or write-capable. Secret via `wrangler secret put`, per
`docs/infrastructure.md`.

**Client side [AM].** New module `packages/core/src/tools/analytics.ts`,
modeled line for line on `kb.ts`:

- Reuse the exported `KbClient` class as-is (§2.5): construct one from
  `SEALEVEL_MCP_URL` + the new env var `SEALEVEL_MCP_ANALYTICS_TOKEN`.
  Worker only, never the console.
- `analyticsConfigured()` mirroring `kbConfigured()`: both vars set or the
  toolset is absent and jobs degrade honestly.
- `createAnalyticsToolset(recorder?: TraceRecorder)` returning `betaZodTool`
  wrappers for the six tools above plus a shared run log in the `KbRunLog`
  shape, so every query a report run makes lands on the produced item as
  `payload.sources` and failures flip `unavailable`, exactly as KB lookups do
  today. Thread the `TraceRecorder` (`packages/core/src/tools/trace.ts`)
  through each call the way `createKbToolset` does, so `payload.run_trace`
  covers analytics runs with outcome, result size, and duration.
- The client-side allowlist is those six names only. Defense in depth: the
  server enforces the same scoping on the identity.

Bake the data-plane constraints into the toolset descriptions so the model
works with them instead of against them: `run_sql` is read-only and caps at
200 rows (aggregate in SQL, never page raw rows), there is no join path to
ai-manager's Postgres, and data is up to a day stale (say "as of yesterday's
sync" in outputs, never "today").

**Feature-module registration hook [AM].** `packages/features/src` is the
designed home for this work, but the shipped registries are static inside
core: `packages/core/src/jobs/registry.ts` builds `JOBS`/`jobById` from its
own imports, and core cannot import features without a dependency cycle. Add
a `registerJobs(jobs: Job[])` mutator to `jobs/registry.ts` (append + rebuild
`jobById`, reject duplicate ids), and have `apps/worker/src/index.ts` call it
with the feature packages' job exports before `registerSchedules` runs (the
schedule sweep at index.ts line ~236 reads `cronSchedulesFromJobs(JOBS)`, so
registration must precede it). Tools need no equivalent hook: analytics tools
attach per run via `Job.runtimeTools`, the same pattern `emailDraft` uses.

Deliverables: sealevel-mcp-server PR (identity + token), `analytics.ts`, the
`registerJobs` hook, `SEALEVEL_MCP_ANALYTICS_TOKEN` documented in
`docs/infrastructure.md` (worker table), and a smoke script proving one
`run_sql` round trip through the new identity.

## 4. Phase 1: Engine A, first instance (weekly attendance report)

The first feature module: `packages/features/src/reports/`.

**Job.** `packages/features/src/reports/weeklyAttendance.ts` exporting a
`Job` with id `report.weekly_attendance`:

- Triggers: `{ kind: "cron", expr: "0 14 * * 1" }` plus `{ kind: "manual" }`
  for hand-firing via `apps/worker/src/fire.ts`. `cronSchedulesFromJobs`
  (`packages/core/src/queue/schedules.ts`) already turns the cron trigger into
  a repeatable schedule at worker boot; no scheduler wiring.
- Scheduling constraint: BullMQ evaluates cron in server time, UTC on
  Railway. The nightly sync drops and recreates every D1 table at 02:30
  Seattle (09:30 or 10:30 UTC depending on DST), so keep all analytics
  automations out of the 09:00 to 12:00 UTC window. Monday 14:00 UTC (6 or
  7am Seattle) is safely clear and lands after the weekend's data has synced.
- Model: `claude-sonnet-5`. This is internal analytics narration, not
  customer drafting; the CLAUDE.md model lock (opus for drafting) is about
  customer-facing copy. Cheap to revisit if report quality disappoints.
- `runtimeTools`: `createAnalyticsToolset(recorder)` plus the same
  `createItemWithSources`-style `create_item` wrapper `emailDraft` uses, so
  sources, trace, and `generated_by` ride the tool call structurally.
- Instructions: query `v_slot_performance`, `v_heatmap_dow_time`, and
  `class_instances` via `run_sql` for the prior week vs the trailing 4-week
  baseline (per §2.1, only views and tables that exist upstream; a new
  metric means an upstream view PR first); narrate per-slot and per-teacher
  movement; flag anything that crossed a threshold; end with exactly one
  `create_item` call. State the data-freshness caveat and the standing
  data-quality caveats (`clients.is_ambiguous`, unmapped sale items
  bucketing to `other`, never summing cash sales with allocated visit
  revenue).
- `recordUsage`: attach token usage to the created item via
  `recordItemUsage`, same as `emailDraft`.
- Idempotency key (§2.8): `dedupe_key` = the ISO week, e.g.
  `weekly-2026-W31`, so a BullMQ retry after a mid-run failure returns the
  existing item instead of filing a second report.

**Item type.** `type: "weekly_report"`, `domain: "analytics"`, `status:
"open"` (a report is FYI-with-follow-ups, not an approval; nothing outbound
hangs on it). Payload: `report_markdown`, `period`, `flags` (the threshold
crossings with their underlying rows), `sources`, `run_trace`,
`generated_by`, `usage`.

**Console.** A `reports` widget in `apps/console/src/lib/widgets/`
(register in `registry.ts`; the `WidgetIcon` union in `widgets/types.ts` is
currently just `"mail"`, so add a `"chart"` icon and its SVG in
`components/WidgetCard.tsx`), gated on a new `reports:view` permission, with
`detailRoute: "/reports"`. A `/reports` route rendering `weekly_report` items
newest first with the markdown body and the flags list. Read-only in this
phase: resolve/acknowledge reuses the existing item actions.

**Notification.** Extend `ItemEventType` in
`packages/core/src/notifications/emit.ts` with `"item.report_ready"`, add the
workflow id mapping, create the workflow in the Novu dashboard (see
`docs/novu.md`), and emit it from the report job's `create_item` wrapper.
Default routing: in-app plus email digest for Pete; adjustable per user in
Novu. Per §2.7, no other notification path.

**Absorption, not duplication (§2.3) [SA].** Once the report has run trusted
for two or three cycles: take the Netlify `reports/` deploy down, and freeze
`exports/decision-tables/` (kept only for the claude.ai project until Pete
retires it, open decision 5). Do not build any new consumer against the
decision tables.

## 5. Phase 2: Engine A, instances two and three

### 5a. ClassPass counts

Blocked on an upstream data gap, so the fix is a separate PR in
sealevel-analytics, landed before the ai-manager job.

**Upstream PR [SA].** `visits.pricing_bucket` is populated only by the xlsx
parser (`pipeline/parsers/attendance.py` line ~80, via the lookup
`build.py` loads from `pipeline/lookups/pricing_buckets.csv`). Verified
against the code: the API path's INSERT in `sync_visits`
(`pipeline/mbapi/sync.py`, ~line 487) writes neither `pricing_option` nor
`pricing_bucket`, so all API-sourced rows carry NULL. The fix:

1. First, verify what `/class/classvisits` actually returns per visit. The
   client (`pipeline/mbapi/client.py`, `get_class_visits`) passes raw dicts
   through, and nothing in the repo proves the payload carries the pricing
   option name. One live pull against site 471 settles it. If the field is
   absent, the fallback is a per-client `/client/clientvisits` or sales
   cross-reference, which is a bigger job; scope that only if forced.
2. Load `pricing_buckets.csv` in `sync.py` the same way `build.py` does, map
   the API's pricing name through it (unmapped goes to `other` and is listed
   in the validation report so the lookup can grow, matching the export
   path's behavior), and set both columns in the INSERT and in the ON
   CONFLICT UPDATE, guarded so export-derived values are never clobbered
   (`CASE WHEN visits.source = 'export' THEN visits.pricing_bucket ELSE ...`,
   the same provenance discipline the attendance flags use).
3. Add a `ClassPass` alias row to `pricing_buckets.csv` for whatever exact
   string the API returns, if it differs from the export's `ClassPass`.

**ai-manager job [AM].** `packages/features/src/reports/classpassCounts.ts`,
id `report.classpass_counts`, weekly cron (offset from the attendance report,
e.g. `0 15 * * 1`), sonnet, same toolset, `dedupe_key` = the ISO week. Query:
ClassPass visits per week per slot from `visits WHERE pricing_bucket =
'classpass'`, compare to baseline, note that history before the upstream fix
lands is export-derived only (2,071 ClassPass visits Jul 2025 to Jul 2026
exist on export/both rows, so trend context is real even before API rows
carry the bucket). Same item type family: `type: "classpass_report"`, domain
`analytics`, the same `/reports` surface and widget count.

### 5b. Substitute tracking

Designed but unbuilt upstream (DESIGN.md §2.6 `scheduled_classes`, §5
`v_schedule_vs_actual`; the build is explicitly attendance-only and neither
sqlite nor D1 has the table). The prerequisite is persisting the planned
schedule forward. `pipeline/mbapi/schedule.py` already pulls scheduled staff
per class occurrence live (built "for the future texting system", no
persistence). Per §2.4 the capture is data pipeline work and lands in GH
Actions, not in the worker.

**Upstream PR [SA], the capture:**

1. New weekly snapshot step: pull the coming 7 days of classes via the same
   `/class/classes` call `schedule.py` wraps, and write one committed CSV per
   snapshot under `data/schedule_snapshots/YYYY-MM-DD.csv` (date, time,
   class type, teacher, canceled flag, captured_at). Committed CSVs, not
   direct table writes, because `build.py` rebuilds `mindbody.db` from raw
   files with a full drop-and-recreate: a table populated only by a sync-time
   snapshot would silently vanish on the next rebuild. The design doc does
   not call this out; it matters.
2. `scheduled_classes` table added to `pipeline/sql/schema.sql` per DESIGN.md
   §2.6 (natural key `(date, time_start_norm, teacher_id, class_type_id)`),
   loaded from the snapshot CSVs during both `build.py` and the nightly sync,
   plus a `captured_at` column so post-snapshot schedule edits are datable.
3. `v_schedule_vs_actual` added to `pipeline/sql/views.sql` per DESIGN.md §5:
   `scheduled_classes` FULL/LEFT JOIN `class_instances` on (date, slot,
   type), exposing planned teacher vs actual teacher. The view is the metric
   definition (§2.1); the ai-manager job never re-derives it.
4. Schedule the snapshot in `nightly-sync.yml` (a weekly-gated step, e.g.
   only on Sundays) or a small separate weekly workflow; either way it rides
   the existing commit-and-push and D1 import steps.

**Reality constraints, stated up front:** history is unrecoverable. The sub
rate starts accruing the day the first snapshot lands; the report must print
"tracking since <first snapshot date>" rather than implying a year of
history. And divergence is soft evidence: DESIGN.md's caveat stands
(cancellations, post-snapshot edits, and class-type mapping gaps such as Hot
Fusion / Hot Pilates never appearing in planned data all masquerade as
substitutions). The job therefore flags counts with the underlying
`v_schedule_vs_actual` rows attached in the item payload, and the prompt
forbids stating a substitution as fact.

**ai-manager job [AM].** `packages/features/src/reports/substituteReport.ts`,
id `report.substitutes`, monthly cron to start (weekly once enough snapshots
exist to be interesting), sonnet, same toolset and item surface
(`type: "substitute_report"`, `dedupe_key` = the period).

## 6. Phase 3: the extraction (automations as rows)

After the three Engine A instances exist as code, extract the config surface
from what they actually vary: query set, cadence, thresholds, prompt framing,
audience. Do not start this before all three run in production; the schema
below is the expected shape, and the third instance gets a veto. This phase
is what discharges §2.9: thresholds and cadences move out of job files into
owner-editable rows, the same ladder rung the `rules` table already proved.

**Migrations [AM]** (numbering: `packages/core/migrations/NNNN_name.sql`,
next free at time of writing is `0011`; use the next free number when it
lands):

```sql
automations(
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  engine text NOT NULL CHECK (engine IN ('monitor')),  -- 'workflow','campaign' later
  enabled boolean NOT NULL DEFAULT true,
  cron text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',    -- views queried, baseline window, audience
  thresholds jsonb NOT NULL DEFAULT '{}',
  prompt text NOT NULL,                  -- the instructions body
  item_type text NOT NULL,
  created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)

automation_runs(
  id bigserial PRIMARY KEY,
  automation_id bigint NOT NULL REFERENCES automations(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  summary text,
  item_ids bigint[] NOT NULL DEFAULT '{}',
  usage jsonb                            -- UsageTotals shape from brain/budget.ts
)
```

**Runtime [AM].** One generic job, `engineA.run`, whose payload is an
`automations.id`: load the row, build instructions from `prompt` + `params` +
`thresholds`, attach the analytics toolset, write an `automation_runs` row
around the run (status, summary, produced item ids, usage). Scheduling: the
worker cannot rely on `cronSchedulesFromJobs` for rows, so extend the boot
sweep in `apps/worker/src/index.ts` to also upsert one scheduler per enabled
automation (id `automation-<id>`, jobName `engineA.run`). Two cautions:
`registerSchedules` (`queue/schedules.ts`) deletes any scheduler not in the
declared list, so DB-derived specs must be merged into that declared set, and
a console edit must reach the worker, so add a lightweight `automation.sync`
repeatable job (every 5 minutes) that re-reads the table and re-upserts,
rather than inventing a pub/sub channel.

**Console [AM].** An Automations page (list, enable/disable, edit cron,
thresholds, prompt, Run now via a manual enqueue of `engineA.run`) and a Runs
page (every execution, what it found, what it cost, what it flagged, linking
to the items). `settings:manage` gates editing; `reports:view` gates viewing.

**Conversion.** All three Engine A instances become rows; their job files
shrink to nothing and are deleted. The precedent is exact: `rules` are
already owner-authored Postgres rows injected into prompts.

Engines B and C do not convert. Money and campaign flows keep code-defined
logic (idempotency and compliance do not belong in an editable text column);
they may later gain `automation_runs` rows for observability only.

## 7. Phase 4: Engine B (money workflows)

Both instances extend the shipped approval state machine through the §2.6
outbound-action map in `queue/enqueue.ts`; neither builds a parallel
pipeline. Build the map generalization as the first PR of this phase, with
`email.send` and `kb.write` refactored onto it to prove nothing changed.

### 7a. Invoice-email forwarding (first: cheapest, reuses shipped machinery)

- **Detection [AM].** New job `packages/features/src/money/invoiceForward.ts`
  with an `{ kind: "email", match: /invoice|statement|bill/i }` trigger;
  `dispatchInboundEmail` (`jobs/dispatch.ts`) already fans one inbound to
  every matching job, so this rides ingestion unchanged. Preflight: a sonnet
  is-this-an-invoice classifier (pattern: `brain/noReply.ts`); on a miss the
  job exits handled with no item. Note the interplay with `email.received`,
  whose catch-all trigger will also draft a reply to the same message: seed
  known vendor senders as no-reply sender rules (tier 1 of the GH-115
  detector) so the drafting lane auto-files them and only the invoice item
  needs a human.
- **Item.** `type: "invoice_forward"`, `status: "pending_approval"`,
  `dedupe_key` = the source Gmail message id (§2.8), payload carrying sender,
  subject, the classifier's rationale, and `email_meta`. Approval card
  variant in the console (the `ApprovalCard.tsx` + `lib/approvals.ts` state
  machine is reused; `decideItem`'s guarded UPDATE needs no change).
- **Forward on approval [AM].** Job B `invoice.forward` as an entry in the
  outbound-action map, mirroring `gmail/send.ts` end to end: deterministic
  jobId `forward-<itemId>`, atomic delivery claim, worker-side credential
  gate. The forwarding trick: fetch the original with Gmail `format=raw` and
  re-send it to the intake address with rewritten recipient headers, so
  attachments pass through byte-for-byte and no attachment parsing is ever
  built (`gmail/parse.ts` deliberately skips attachments today). One real gap
  the design doc glosses: `GmailClient.getMessage` (`gmail/client.ts` line
  ~161) hardcodes `format: "full"`, so add a `getRawMessage(id)` method;
  small, but it is new client surface, not pure reuse.
- **Config.** `INVOICE_INTAKE_ADDRESS` (the US Bank intake address) and
  `INVOICE_FORWARD_ENABLED`, both worker-side, documented in
  `docs/infrastructure.md`. Env vars are legitimate here per §2.9: this is
  deployment posture and an external address, not a threshold. Unset means
  the whole lane is inert, matching the Gmail layer's config-gating
  discipline.

### 7b. Teacher payroll invoices

Order of operations is strict: policy, then rates, then reconciliation
close-out, then code, then sandbox, then production.

1. **Written pay policy first.** Rates per teacher, and the rules for subs
   (who is paid, the scheduled or the actual teacher), comps, and cancelled
   classes. This exists nowhere (sealevel-analytics README is explicit: no
   expense or teacher-pay data in any export). No code before the policy doc
   is written and signed off (open decision 1).
2. **Rates table [AM].** Migration: `teacher_pay_rates(id, mb_staff_id
   integer NOT NULL, teacher_display_name text, rate_cents integer,
   rate_basis text CHECK (rate_basis IN ('per_class','per_head')),
   effective_from date, effective_to date, created_by, created_at)`. Keyed on
   `mb_staff_id` per §2.11, never on the analytics repo's AUTOINCREMENT
   `teacher_id`; the display name column is a convenience mirror, not an
   identity. Prerequisite [SA]: backfill the 2 of 35 teacher rows with NULL
   `mb_staff_id` (Sharon, Tanja). The payroll job must fail loudly on any
   teacher with classes in the period but no rate row or a NULL
   `mb_staff_id`, and a newly auto-onboarded `role='staff'` teacher in a pay
   run is a review prompt, never a silent payee.
3. **Reconciliation gate close-out [SA].** The committed
   `sync_validation_report.txt` reports FAIL with 1,244 gating mismatches,
   all `source='export'` rows from 2025 with `api=0`, which is what comparing
   the whole db against a 7-day API pull necessarily produces. It looks like
   a scope artifact, but nobody has formally cleared it. Before any invoice
   is generated from these counts: rescope the check to the pulled window (or
   document the artifact and re-run), get Pete's sign-off, and record it.
   This is a hard gate on step 5 going live (open decision 2).
4. **QBO integration [AM].** New tool module
   `packages/core/src/tools/qbo.ts`: OAuth2 app, sandbox first
   (`QBO_ENV=sandbox`), env `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` /
   `QBO_REFRESH_TOKEN` / `QBO_REALM_ID`, worker only, never the console (the
   same gate split as Gmail send). QBO app approval for production keys is
   calendar time; start the application when this phase starts. Whether the
   QBO artifact is an Invoice or a Bill is genuinely undecided (open
   decision 3).
5. **The job pair [AM].** `payroll.prepare` (monthly cron, sonnet plus the
   analytics toolset): per-teacher class counts for the period from
   `class_instances` via `run_sql` (verified available: live per-teacher
   counts exist for June and July 2026), resolved to `mb_staff_id` through
   the upstream `teachers` table, apply rates and the written policy, file
   one `type: "payroll_invoice"` item per teacher, `status:
   "pending_approval"`, payload showing the line items, the counts, and the
   underlying class rows. On approve, Job B `payroll.push` (an outbound-map
   entry) writes to QBO. Idempotency is period-keyed and layered (§2.8):
   migration `payroll_invoices(id, period text, mb_staff_id integer, item_id
   bigint, status, qbo_ref text, UNIQUE (period, mb_staff_id))`, a
   deterministic BullMQ jobId `payroll-<period>-<mbStaffId>`, an atomic claim
   in the style of `claimDeliveryForSend`, and the QBO request's own
   idempotent reference (DocNumber set to `<period>-<mbStaffId>`). A retry at
   any layer can never double-invoice; a re-run of `payroll.prepare` for a
   period with an existing row is a logged no-op per teacher.
6. **Queue isolation.** Payroll and forwarding jobs run on a separate `money`
   BullMQ queue (§9), so a stuck QBO call never starves email triage.
   Optionally, later, the QBO worker becomes its own Railway service holding
   the QBO refresh token (the Option 2 tactic); same Postgres, same items
   table, same outbound map, no UI.

## 8. Phase 5: Engine C (campaigns)

Start the calendar clocks first, build second:

- **A2P 10DLC registration** (brand + campaign) via Twilio: weeks of lead
  time, zero engineering. Start it the day this phase is approved, or
  earlier if SMS is wanted within the quarter (open decision 4).
- **Bulk email sender**: never the transactional Gmail identity. Pick a
  provider (Resend, Postmark, or SES; open decision 3b), send from a
  dedicated subdomain, and begin warmup early.

Build [AM], as `packages/features/src/campaigns/`:

1. **Consent ledger migration**, one ledger for both channels (§2.10):
   `consent(id, contact text, channel text CHECK (channel IN
   ('email','sms')), status text CHECK (status IN
   ('opted_in','opted_out','unknown')), source text, occurred_at, UNIQUE
   (contact, channel))`, append-only history table beside it. Every outbound
   marketing send checks it; STOP webhooks (Twilio) and unsubscribe links
   (CAN-SPAM) write it. TCPA for SMS, CAN-SPAM for email, built in, not
   bolted on.
2. **Campaigns tables**: `campaigns(id, name, channel, audience_query,
   steps jsonb, schedule, status, created_by)` and `campaign_sends(id,
   campaign_id, contact, step, status, provider_ref, UNIQUE (campaign_id,
   contact, step))`, the send-level unique key being the idempotency guard
   (§2.8).
3. **Audience**: pulled through the analytics toolset (`run_sql` against
   `clients` / `v_client_activity`), always excluding
   `clients.is_ambiguous = 1` (merged identities must never get targeted
   mail) and anyone not opted in. Client identity stays upstream per §2.11;
   ai-manager stores contact handles and consent, never a second client
   list. The 200-row `run_sql` cap means audience materialization pages by
   cursor (`client_id > last`) into `campaign_sends` before sending, not one
   giant query.
4. **Approval and send**: a campaign is drafted as an item
   (`type: "campaign"`, `pending_approval`); approval enqueues the advance
   job through the outbound-action map onto a dedicated `campaigns` queue;
   each step's sends are individually idempotent rows. Nothing auto-sends;
   the approval covers the audience snapshot and the content together.
5. **Tools**: `tools/bulkEmail.ts` and `tools/twilio.ts`, worker-only
   credentials, idempotency keys on every send (Twilio supports them
   natively).
6. **Console**: a Campaigns page (drafts, audience preview with counts,
   step timeline, results) gated on a new `campaigns:manage` permission.

## 9. Cross-cutting work

- **Migrations [AM]**: all new tables above follow the existing
  `packages/core/migrations/NNNN_name.sql` convention (next free: `0011`),
  applied by `db/migrate.ts` in filename order; number them in landing
  order, one concern per file.
- **RBAC [AM]**: extend the `Permission` union in
  `apps/console/src/lib/rbac.ts` with `reports:view`, `money:decide`,
  `campaigns:manage`; map owner to all three, operator to `reports:view` +
  `money:decide`, viewer to `reports:view`. Widget and route gates reuse
  `hasPermission` (§2.7).
- **Per-queue concurrency [AM]**: today one queue (`DEFAULT_QUEUE_NAME =
  "jobs"`, `queue/queue.ts`) and one worker with `WORKER_CONCURRENCY`
  (default 2, `queue/worker.ts`). Add `money` and `campaigns` queues with
  their own `createQueueWorker` instances in `apps/worker/src/index.ts` and
  per-queue caps (`WORKER_CONCURRENCY_MONEY`, `WORKER_CONCURRENCY_CAMPAIGNS`,
  default 1), all registered in Bull Board. Engine A stays on the default
  queue; its runs are short and infrequent.
- **Notifications [AM]**: `ItemEventType` grows `item.report_ready`,
  `item.money_pending`, `item.campaign_pending`; each needs a Novu workflow
  (dashboard step, see `docs/novu.md`) and a `WORKFLOW_IDS` entry.
- **dbt deletion [AM]** (per §2.2): delete `analytics/dbt/`, remove the
  dbt/Metabase rows from ARCHITECTURE.md's analytics section and stack table
  or annotate them superseded, and drop the `analytics/dbt` mention from
  CLAUDE.md's conventions line. While in CLAUDE.md, fix the stale "Phase 2 is
  gated on Mindbody production API access" line: the access exists and the
  nightly sync has been green through 2026-07-26.
- **Docs [AM]**: every new env var lands in `docs/infrastructure.md` the day
  its code lands, per that doc's purpose.

## 10. Sequencing and dependencies

| # | Work | Repo | Blocked by |
|---|---|---|---|
| 1 | ~~Analytics identity + token (server)~~ | sealevel-mcp-server | DONE (SEA-79) |
| 2 | `analytics.ts` toolset DONE (SEA-79); `registerJobs` hook still open | ai-manager | 1 |
| 3 | Weekly attendance report (job, item, widget, Novu event) | ai-manager | 2 |
| 4 | Retire Netlify `reports/`; freeze decision tables | sealevel-analytics | 3 trusted for 2-3 cycles |
| 5 | ClassPass API-path `pricing_bucket` fix | sealevel-analytics | field verification against site 471 |
| 6 | ClassPass counts report | ai-manager | 2, 5 |
| 7 | `scheduled_classes` capture (snapshots, table, view) | sealevel-analytics | nothing (start early: history accrues only from first snapshot) |
| 8 | Substitute report | ai-manager | 2, 7 plus a few weeks of snapshots |
| 9 | Extraction: `automations`/`automation_runs`, console pages | ai-manager | 3, 6, 8 in production |
| 10 | Outbound-action map generalization (five enqueuers onto it) | ai-manager | nothing (do before Engine B) |
| 11 | Invoice forwarding (classifier, item, raw-forward Job B) | ai-manager | 10; US Bank intake address (OD 6) |
| 12 | Pay policy written and signed | humans | nothing (start now) |
| 13 | Reconciliation gate close-out | sealevel-analytics + Pete | nothing (start now) |
| 14 | Backfill 2 NULL `mb_staff_id` teacher rows | sealevel-analytics | nothing |
| 15 | QBO OAuth app, sandbox | ai-manager + Intuit | QBO app approval (calendar) |
| 16 | Payroll prepare/push jobs, rates table | ai-manager | 2, 10, 12, 13, 14, 15; OD 3 (Invoice vs Bill) |
| 17 | A2P 10DLC registration | Twilio | OD 4 (calendar time; start early if SMS wanted) |
| 18 | Bulk sender choice + domain warmup | ai-manager | OD 3b (calendar time) |
| 19 | Consent ledger + campaigns tables DONE (SEA-80); email campaign jobs in flight | ai-manager | 18 for sending |
| 20 | SMS campaigns | ai-manager | 17, 19 |
| 21 | dbt skeleton deletion + doc updates | ai-manager | nothing |

Parallelism: 1-2-3 is the critical path for everything analytic; 7, 10, 12,
13, 14, 17, 21 can all start immediately; 11 can ship any time after the
intake address exists.

## 11. Open decisions needing a human

1. **Teacher pay policy.** Rates per teacher; sub pay (scheduled vs actual
   teacher); comp classes; cancelled classes. Must be a written doc before
   payroll code starts. Owner: Pete + Alison.
2. **Reconciliation gate.** Accept the scope-artifact explanation and rescope
   the check, or demand a full re-validation. Blocks payroll going live on
   API-derived counts. Owner: Pete.
3. **QBO artifact type**: does the studio record teacher pay as a QBO Invoice
   (teacher invoices the studio, studio enters it) or a Bill (accounts
   payable)? Determines which QBO API object `payroll.push` writes.

   **3b. Bulk email provider** (Resend / Postmark / SES) and the sending
   subdomain. Independent of decision 3; numbered this way only to keep the
   `OD 3b` references in §10 stable.
4. **Is SMS wanted this quarter?** If yes, start A2P 10DLC registration now;
   if no, defer item 17 and build email campaigns only.
5. **Decision-tables consumer.** The claude.ai project that syncs
   `exports/decision-tables/` as knowledge: retire it when console reports
   ship, or keep the frozen export step running alongside indefinitely.
6. **US Bank intake address** for invoice forwarding, and the vendor list the
   classifier should treat as invoice senders.
