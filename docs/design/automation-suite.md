# Where the new automations should live

Status: design discussion, nothing built. Written 2026-07-26 in response to a
batch of seven requested automations (teacher payroll, substitute tracking,
weekly attendance reporting, inbound-invoice forwarding, ClassPass counts,
email campaigns, SMS campaigns) and the question of whether they belong in
ai-manager, in separate apps, or in a larger "suite" of mini-apps.

## What is already true

Four repos are in play: `ai-manager` (this one), `sealevel-analytics` (the
Mindbody data pipeline), `sealevel-mcp-server` (the Cloudflare Worker serving
MCP), and `sealevel-website`. The facts below are verified against the live
systems and the analytics repo, not against the docs, which are stale in
places.

**1. Mindbody data is already flowing, nightly, from the production site.**
The chain is:

```
Mindbody Public API v6 (site 471)
  └─ sealevel-analytics: pipeline/mbapi/{client,sync,backfill}.py
       (7-day incremental window; upserts on the same natural keys the
        xlsx export path uses; rows tagged source = 'export' | 'api' | 'both'
        and the API never clobbers export-derived fields)
  └─ .github/workflows/nightly-sync.yml @ 02:30 Seattle
       └─ writes sqlite mindbody.db, which is COMMITTED TO THE REPO
       └─ pipeline/export_decision_tables.py -> exports/decision-tables/*.md
       └─ pipeline/d1_dump.py + wrangler d1 execute
            (DROP + recreate every table/view in D1 each night)
  └─ Cloudflare D1 "sealevel-mindbody"
  └─ sealevel-mcp-server (Worker, MCP over Streamable HTTP)
  └─ ai-manager's KB tools (packages/core/src/tools/kb.ts)
```

Both gates in that workflow (`ENABLE_API_SYNC`, `ENABLE_D1_IMPORT`) are on:
the last nine scheduled runs through 2026-07-26 all succeeded, and D1 carries
API-sourced rows dated today. So `CLAUDE.md`'s "Phase 2 is gated on Mindbody
production API access" is stale — the access exists and the pipeline is
running.

Three consequences for anything built on top:

- **The system of record is a git-committed sqlite file**, not a database.
  ai-manager cannot write to it and should not try.
- **Data is up to a day stale, and D1 is briefly torn down nightly** during
  the DROP-and-recreate import. Automations must not be scheduled near
  02:30 Seattle.
- **The go-live reconciliation gate still reports FAIL** (1,244 gating
  mismatches in the committed `sync_validation_report.txt`). Inspecting the
  deltas, every one is an `source=export` row from 2025 with `api=0`, which is
  what comparing the whole database against a 7-day API pull necessarily
  produces. It looks like an artifact of the check's scope rather than bad API
  data, but nobody has formally cleared it, and the sync was enabled anyway.
  Worth closing out before money-moving automations depend on these numbers.

**2. ai-manager's own analytics stack is an empty skeleton.** `analytics/dbt`
contains a `dbt_project.yml` and three `.gitkeep` files. Postgres holds the
operational tables (items, rules, settings, learning loop) and no Mindbody
data. Building the dbt marts as originally designed would duplicate a pipeline
that already works.

**3. Some of the requested reporting already exists, in a different form.**
`pipeline/export_decision_tables.py` writes markdown decision tables (slot
performance, teacher draw, day/time heatmap, monthly financials) for a
claude.ai project to consume as knowledge, and `reports/` holds hand-built
static HTML analyses deployed to Netlify. The weekly attendance automation
should absorb and replace that surface, not run alongside it.

**4. Substitute tracking is designed but unbuilt, and half its inputs exist.**
`DESIGN.md` §2.6 specs a `scheduled_classes` table, §5 specs a
`v_schedule_vs_actual` view, and the "Analytical caveats" section already
documents that substitution can only be *inferred* from divergence between
planned and actual staff. None of it is built: the analytics build is
explicitly attendance-only, and neither the committed sqlite nor D1 has a
`scheduled_classes` table. But `pipeline/mbapi/schedule.py` already pulls
scheduled staff per class occurrence live from the API (written "for the
future texting system," with no persistence). So the prerequisite is to
persist that forward, not to invent it.

What is built and reusable in ai-manager: the items backbone, the approval
state machine (draft to human decision to idempotent outbound action), Clerk
RBAC, the widget registry, Novu routing, the job registry with cron
auto-registration, and owner-editable config in Postgres (the `rules` table
and its settings UI). `packages/features/src` is an empty placeholder waiting
for exactly this kind of work.

## The seven automations are three patterns

They are not seven things to build. Sorted by shape rather than by domain:

**Engine A: scheduled monitor/report.** Query a data source on a cadence,
compare against a baseline or threshold, narrate the result, raise an item
when something crosses the line. Covers weekly attendance reporting, ClassPass
counts, substitute-rate tracking, and most of the "probably many more."
Instances differ only in query, cadence, threshold, and audience.

**Engine B: document/transaction workflow.** Trigger, build an outbound
artifact, human approves, idempotent write into an external financial system.
Covers teacher payroll invoices and inbound-invoice forwarding. This is the
approval state machine that already ships for email, with new outbound tools
and period-keyed idempotency so a retry can never double-invoice.

**Engine C: campaigns.** Audience query, content, consent gate, scheduled
multi-step send, results attribution. Covers email and SMS campaigns. This is
the only genuinely new subsystem, and the only one with calendar-time gates
(A2P 10DLC registration, sender-domain warmup).

Build A first (three of seven asks plus the open-ended tail), B second (two
asks, highest dollar value, mostly reuses shipped machinery), C last.

## Three decisions, not one

The four options as posed conflate decisions that are actually independent:

1. **Runtime shape**: one deployable or many?
2. **UI shape**: one console or a suite of mini-apps?
3. **Authoring model**: is a new automation a code change or a config row?

The "suite of mini-apps" idea is really a UI answer (2) plus an authoring
answer (3). Neither requires splitting the runtime.

## Option 1: feature modules inside ai-manager

Each automation is a folder under `packages/features/`: jobs, tools, item
types, widget, notification defaults. This is what ARCHITECTURE.md already
specifies and the placeholder package is waiting for.

- Adding one: new folder, one registry entry, PR, deploy.
- Free inheritance: items backbone, approvals, auth, notifications, one
  Railway deploy, one "what needs my attention" list.
- Nothing new to design; you are filling a designed slot.

Ceiling: "easy to create" means easy *for an engineer*. Seven automations is
seven PRs. Mitigate the shared-process risk with separate BullMQ queues and
per-queue concurrency, not separate services.

## Option 2: separate apps per automation

Honest upside: hard blast-radius isolation, independent deploys, and
credential separation (QBO tokens never sit near the web console).

Real cost: seven times auth, seven approval UIs, seven notification configs,
and no single attention queue, which is the property that makes the current
system usable. It also contradicts the architecture's "one backbone"
principle.

Verdict: wrong as an organizing principle, right as an occasional deployment
tactic. QBO writes and SMS sending are reasonable candidates for their own
*worker service* on the same Postgres and the same items table, with no UI of
their own.

## Option 3: one app, three engines

Option 1's packaging plus the A/B/C decomposition above: build the engine
once, instantiate it repeatedly, and let the console grow one section per
engine (Reports, Money, Campaigns) alongside the existing Inbox. This is the
cheapest path to all seven automations and it yields the "suite" feel with one
deploy, one auth, and one backbone.

## Option 4: automations as data, not files

The endpoint implied by "an easy way to create these" and "an easy way to see
them and their results." Promote automations from code to rows:

```
automations(id, name, kind, trigger, source, params, prompt,
            thresholds, output, enabled, created_by)
automation_runs(id, automation_id, started_at, status, summary,
                item_ids, usage)
```

The console gains an Automations page (list, enable/disable, edit cadence and
threshold and prompt, Run now) and a Runs page (every execution, what it
found, what it cost, what it flagged). That is ARCHITECTURE.md's cost ladder
pushed one rung further: config rather than deploy for a whole automation, not
just for widget layout. The precedent is already in the repo, since `rules`
are owner-authored Postgres rows injected into prompts, and
`cronSchedulesFromJobs` already derives repeatable jobs from declared triggers,
so a DB-driven schedule register is a small extension rather than a new
mechanism.

Risk: building a general builder before the shape is known. Apply the rule of
three. Ship two or three Engine A automations as code, extract the config
surface from what they actually vary, then generalize. Option 4 is where to
land, not where to start.

## Recommendation

Option 3 now, Option 4 as the declared destination, Option 2 only for
credential isolation of QBO and SMS workers. Reject Option 2 as the org
principle and treat "suite" as a UI and authoring goal that one deployable can
satisfy.

Framing shift worth making explicit: ai-manager is not an email app that is
growing. It is an items-plus-approvals platform whose first feature happened
to be email. The suite is correct as a concept; it just does not need separate
apps.

## Data plane, and which repo owns what

A second, independent decision, and with `sealevel-analytics` in view it
mostly answers itself.

**The line to draw: sealevel-analytics owns data and metric definitions;
ai-manager owns triggers, judgment, approvals, and outbound actions.** Do not
rebuild the Mindbody pipeline in TypeScript, and do not put payroll or
campaigns in a GitHub Actions cron. Concretely:

- **Stays in sealevel-analytics**: API sync, natural keys and provenance,
  parsing lookups, the `v_*` views as the metric definitions, validation and
  reconciliation reporting, and the new `scheduled_classes` capture that
  substitute tracking needs. A new metric is a view there, not a query string
  embedded in an ai-manager prompt.
- **Belongs in ai-manager**: cadence and thresholds, the Claude interpretation
  step, items, approvals, notifications, the console surfaces, and every
  outbound write (QBO, forwarded invoice email, campaign sends).
- **New operational tables in ai-manager's Postgres**, because they are
  ai-manager's own state and have no place in an analytics mirror that gets
  dropped and recreated nightly: teacher pay rates, consent and opt-out state,
  campaigns, automation definitions and runs.

Defer dbt indefinitely. Its job was to be the tested metric layer; `v_*` plus
`sync_validation_report.txt` already is one.

**The integration seam that needs building.** ai-manager's only read path into
the data is the MCP server, and the drafter's toolset deliberately excludes
analytics (`kb.ts`: the service identity cannot call analytics, document, or
write tools). So analytics automations need a **second MCP identity with an
analytics-scoped toolset** — `run_sql`, `teacher_performance`,
`slot_performance`, `attendance_heatmap`, `monthly_financials` — kept separate
from the customer-facing drafting identity. That is the concrete first piece of
plumbing, and it is small.

Constraints to design around: the MCP tools are read-only, `run_sql` caps at
200 rows, there is no join path to Postgres, and the data is up to a day
stale.

## Integrations

Integrations are tools, the rare and genuinely-engineered layer. All seven
automations need only three new ones: QBO (invoice write), a bulk email sender
separate from the transactional Gmail identity, and Twilio. Everything else
composes what exists. That is the real answer to "easy integration": keep the
tool count small and let automations compose them.

## Gaps and blockers

| Automation | What it needs | Status |
|---|---|---|
| Weekly attendance report | `class_instances`, `v_slot_performance` | Available today. Should absorb `exports/decision-tables/` and the Netlify `reports/` surface rather than duplicate them. |
| ClassPass counts | `visits.pricing_bucket` | Present on export/both rows (2,071 ClassPass visits, Jul 2025 to Jul 2026) but NULL on all 28,310 API-sourced rows: the bucket is derived by the xlsx parser via `pipeline/lookups/pricing_buckets.csv`, and the API sync path never populates it. Fix is in `sealevel-analytics` (`mbapi/sync.py` plus the lookup) and must land before ClassPass reporting works on current data. |
| Teacher payroll | Classes per teacher per period | Available today (verified: live per-teacher counts for June and July 2026). |
| | Pay rates, and a written policy for subs, comps, and canceled classes | Exists nowhere. `sealevel-analytics` README is explicit: no expense or teacher-pay data in any export, everything is revenue-side only. New ai-manager Postgres table plus a policy decision before code. |
| | QBO invoice write | New integration: OAuth app, sandbox first. US Bank sync is downstream and needs no work. |
| | Trustworthy numbers | The reconciliation gate reports FAIL for what looks like a scope artifact. Close it out before invoices are generated from these counts. |
| Substitute tracking | Scheduled teacher vs actual | Designed in `DESIGN.md` (§2.6 `scheduled_classes`, §5 `v_schedule_vs_actual`), explicitly not built; no such table in sqlite or D1. `class_instances.teacher_id` is who *actually* taught. `pipeline/mbapi/schedule.py` already pulls scheduled staff per day live from the API, so the work is to persist it forward on a weekly snapshot. History is unrecoverable: the sub rate starts accruing the day snapshotting starts. Inherit DESIGN.md's caveat that divergence is soft evidence — cancellations, post-snapshot schedule edits, and class-type mapping gaps all masquerade as substitutions, so flag counts with the underlying rows attached, never as fact. |
| Invoice email forwarding | Gmail lane | Shipped. Ingestion skips attachments (`gmail/parse.ts`), but forwarding does not need to parse them: fetch the original with `format=raw`, rewrite the recipient, send. Needs an is-this-an-invoice classifier, a new item type, and the US Bank intake address in config. |
| Email campaigns | Bulk sender, consent ledger, campaigns table | New. Do not send bulk from the transactional Gmail identity. Audience quality is limited by `clients.is_ambiguous` (names merged across Mindbody's dual ID schemes); exclude ambiguous clients from targeted sends. |
| SMS campaigns | Twilio, TCPA consent and STOP, A2P 10DLC | New, and registration is calendar time rather than build time. `pipeline/mbapi/schedule.py` was written for this ("built for the future texting system") and already renders a day's schedule human-readably. Start registration early if this is wanted within the quarter. |

Data-quality caveats any report inherits: `clients.is_ambiguous` may merge two
real people under one name; auto-onboarded teachers land as `role='staff'` and
need review (the 2026-07-26 run onboarded "Adam Pearlstein"); 22 sale item
names are unmapped and bucket to `other`, which skews revenue-by-category; and
cash sales versus allocated visit revenue are different accounting bases that
must never be summed.
