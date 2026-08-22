# Infrastructure config map

Where every piece of configuration lives. The system spans four config homes; when you are hunting for a setting (or deciding where a new one goes), start here.

## Rule of thumb

App behavior -> Railway. Live schedule/pricing -> Cloudflare. Nightly analytics -> GitHub Actions. Login -> Clerk.

## The four homes

| Home | What lives there | Where to change it |
| --- | --- | --- |
| **Railway** (project env vars) | Everything the `worker` and `console` services do at runtime: database/queue URLs, Anthropic key, Novu, Gmail, KB connection, booking link, feature flags | Railway dashboard > service > Variables |
| **Clerk** | Login only. Users, sessions, allowed origins. Its two API keys are copied into the Railway `console` service | Clerk dashboard |
| **Cloudflare** | The sealevel-mcp-server: MCP Worker + D1 wiki database, serving `search_wiki` / `read_wiki_page` / `upcoming_classes` / `class_pricing`. Secrets via wrangler: `MINDBODY_API_KEY`, `MINDBODY_SITE_ID`, and the MCP OAuth / service-token secrets | sealevel-mcp-server repo, `wrangler secret put` |
| **GitHub Actions** (repo secrets) | sealevel-analytics: the nightly Mindbody sync (`MB_*` and `CLOUDFLARE_*` secrets). ai-manager: `ANTHROPIC_API_KEY` for the drafting evals in CI | Repo > Settings > Secrets and variables > Actions |

## Railway: worker service

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres; reference `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | yes | BullMQ; reference `${{Redis.REDIS_URL}}` |
| `ANTHROPIC_API_KEY` | yes | The brain (drafting + triage calls) |
| `NIXPACKS_NODE_VERSION` | yes (`20`) | Pin the Node major |
| `NOVU_SECRET_KEY` | no | Notifications; unset = notifications no-op |
| `NOVU_SUBSCRIBER_PETE`, `NOVU_SUBSCRIBER_ALISON` | with Novu | Subscriber ids |
| `SEALEVEL_MCP_URL`, `SEALEVEL_MCP_TOKEN` | no | Knowledge base connection to the Cloudflare MCP server; unset = jobs run KB-less |
| `SEALEVEL_MCP_KB_WRITER_TOKEN` | no | KB write-back (GH-113): the kb-writer service credential (server secret `KB_WRITER_TOKEN`, minted via wrangler in sealevel-mcp-server) used only by the post-approval `kb.write` job; unset = approved KB updates record an honest `skipped`. Worker only, never the console |
| `SEALEVEL_MCP_ANALYTICS_TOKEN` | no | Analytics reads (SEA-79): the analytics service credential (server secret `ANALYTICS_TOKEN`, minted via wrangler in sealevel-mcp-server), scoped server-side to the five read-only D1 analytics tools for campaign audience building; unset = the analytics toolset is simply absent. On the worker for campaign/payroll jobs AND on the console for the Teacher pay rates page (SEA-106), which lists recent teachers through the same read-only seam; unset on the console = the page degrades to stored rates only. The write-capable credentials (Gmail send, KB writer, QBO) remain worker-only |
| `MINDBODY_API_KEY`, `MINDBODY_SITE_ID` | no | Mindbody Public API v6 for the nightly `campaigns.sync_contacts` job (SEA-81) — the same credential pair the sealevel-mcp-server Worker holds as wrangler secrets, duplicated here because the sync calls Mindbody directly; unset = the sync is a logged skip. Worker only, never the console |
| `MINDBODY_STAFF_USERNAME`, `MINDBODY_STAFF_PASSWORD` | no | Staff credentials for the Mindbody user token (`/usertoken/issue`); optional but recommended — permission level governs how much client data `/client/clients` returns. Worker only, never the console |
| `CAMPAIGNS_SYNC_CRON` | no | Contact sync cadence override; default `15 6 * * *`, evaluated in America/Los_Angeles (clear of the 02:15-06:00 PT analytics rebuild blackout, SEA-105) |
| `CAMPAIGNS_MONITOR_CRON` | no | Campaign health monitor cadence (SEA-92); default `*/15 * * * *` |
| `CAMPAIGN_ALERT_COMPLAINT_RATE` | no | Complaint-rate alert threshold as a fraction; default `0.001` (0.1%), applied per campaign and rolling |
| `CAMPAIGN_ALERT_HARD_BOUNCE_RATE` | no | Hard-bounce-rate alert threshold as a fraction; default `0.02` (2%) |
| `CAMPAIGN_ALERT_STUCK_SENDING_MINUTES` | no | Minutes a `sending` campaign may sit with no send activity before the stuck alert; default `120` |
| `CAMPAIGN_ALERT_ZERO_RECIPIENT_GRACE_MINUTES` | no | Grace after approval before a sends-less `sending`/`sent` campaign trips the zero-recipient alert; default `15` |
| `CAMPAIGN_ALERT_ROLLING_WINDOW_DAYS` | no | Rolling complaint-rate window in days; default `7`. Also bounds which campaigns the per-campaign rate and zero-recipient checks evaluate, so a terminal campaign's frozen rate ages out of alerting instead of re-paging forever |
| `CAMPAIGN_ALERT_MIN_SENT` | no | Minimum sent sends before either rate alert applies (keeps a 5-person test send from paging on one event); default `10` |
| `CAMPAIGN_ALERT_REALERT_HOURS` | no | Cooldown before a still-active alert condition pages again; default `24` |
| `CAMPAIGN_ALERT_OVERDUE_SCHEDULED_GRACE_MINUTES` | no | Grace past a campaign's due time (`send_at`, else `approved_at`) before an approved campaign with no send rows trips the overdue-scheduled alert (SEA-84); default `30` |
| `RESEND_API_KEY` | for sending | Resend API key for `campaigns.send` (SEA-84); unset = the send job is a logged skip. Worker only, never the console |
| `RESEND_WEBHOOK_SECRET` | for sending | Svix signing secret for `/webhooks/resend` (SEA-85); unset = the endpoint answers 404 |
| `CAMPAIGN_FROM_EMAIL` | for sending | The From header, e.g. `Sealevel Hot Yoga <hello@mail.sealevelhotyoga.com>`; MUST be on the verified dedicated sending subdomain, never the transactional Gmail identity; unset = the send job is a logged skip |
| `CAMPAIGN_REPLY_TO` | no | Optional Reply-To on every campaign email, e.g. `hello@sealevelhotyoga.com`: the sending subdomain has no inbound mail (no MX for receiving), so this routes replies to the monitored studio inbox instead of bouncing. Unset = no `reply_to` field at all; a value without `@` is warned about loudly and omitted (never blocks a send) |
| `UNSUBSCRIBE_TOKEN_SECRET` | for sending | HMAC secret signing one-click unsubscribe tokens; unset = the `/unsubscribe` endpoint answers 404 AND `campaigns.send` REFUSES to fire (never send without a working unsubscribe, CAN-SPAM) |
| `UNSUBSCRIBE_BASE_URL` | for sending | Public base URL of the worker (e.g. `https://worker.sealevelhotyoga.com`) that unsubscribe links point at; unset = same refusal as the token secret |
| `CAMPAIGN_SEND_RAMP_PER_DAY` | no | Warmup ramp: max provider-accepted sends per trailing 24h ACROSS ALL campaigns; default `200` (conservative for a cold subdomain; raise week by week per docs/campaigns/sending.md) |
| `CAMPAIGN_SEND_BATCH_SIZE` | no | Recipients per send batch (also the granularity of the per-batch suppression re-check); default `25`, capped at 100 |
| `CAMPAIGN_SEND_INTERVAL_MS` | no | Milliseconds between individual Resend requests; default `600` (under Resend's 2 req/s allowance) |
| `CAMPAIGN_SEND_RAMP_RETRY_MINUTES` | no | How long a ramp-paused send waits before resuming; default `60` (keep below `CAMPAIGN_ALERT_STUCK_SENDING_MINUTES` so a paused ramp does not page) |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REFRESH_TOKEN`, `QBO_REALM_ID` | no | QuickBooks Online for `payroll.push` (SEA-104): all four or the push records an honest failed skip. Worker only, never the console (the Gmail gate split; the refresh token never sits on the web-facing service) |
| `QBO_ENV` | no | `sandbox` (default) or `production`; switches Intuit API hosts. Keep sandbox until the Intuit app assessment clears (SEA-99) |
| `QBO_EXPENSE_ACCOUNT_ID` or `QBO_EXPENSE_ACCOUNT_NAME` | for pushes | Expense account for Bill lines, by QBO Account id or exact Chart of Accounts name; QBO requires an AccountRef on every account-based line (no server-side default), so with neither set every push is a terminal failure (which account: open bookkeeper question, policy 10) |
| `ANALYTICS_SYNC_GH_TOKEN` | no | GitHub token with `actions:write` on petestewart/sealevel-analytics, used by `payroll.prepare` to dispatch the on-demand payday sync (policy 6). Worker only, never the console. Unset = dispatch skipped; the freshness gate still blocks a stale run |
| `SEALEVEL_BOOKING_URL` | no | The one canonical self-service booking link, interpolated verbatim into drafts; unset = booking rule absent |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER` | no | Gmail layer (all four or it is inert); worker only, never the console |
| `GMAIL_SEND_ENABLED` | no | `true` opts the deployment into outbound; default off (ingestion-only) |
| `GMAIL_SEND_MODE` | no | `draft` parks a Gmail draft on approval; `send` (default) delivers. Set on both services |
| `GMAIL_INGEST_QUERY`, `GMAIL_INGEST_MAX`, `GMAIL_PROCESSED_LABEL`, `GMAIL_MARK_READ`, `GMAIL_POLL_CRON` | no | Ingestion tuning, safe defaults (see docs/gmail-ingestion.md) |
| `WORKER_CONCURRENCY` | no | Brain concurrency cap, default 2 |

Railway injects `PORT` and `RAILWAY_GIT_COMMIT_SHA` (the draft version stamp) itself; never set them by hand.

## Railway: console service

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Same Postgres reference |
| `REDIS_URL` | yes | The console enqueues Job B (send) and revise jobs |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes | From Clerk; build-time inlined, changing it needs a redeploy |
| `CLERK_SECRET_KEY` | yes | From Clerk |
| `NIXPACKS_NODE_VERSION` | yes (`20`) | Pin the Node major |
| `GMAIL_SEND_ENABLED` | no | Flag-only console gate: whether Approve enqueues Job B and what the delivery copy says |
| `GMAIL_SEND_MODE` | no | So approve toasts and the delivery line say "draft created" vs "sending" |

The console deliberately holds **no Gmail credentials**: the send gate is split so the refresh token lives only on the worker (see docs/gmail-ingestion.md, "Console vs worker gate"). A `pg-backup` cron service also runs in the project with `DATABASE_URL`, `BACKUP_RCLONE_REMOTE`, and the `RCLONE_CONFIG_R2_*` credential set (see docs/backups.md and docs/railway.md).

Railway's service Settings > Deploy > Healthcheck Path must point at `GET /api/healthz` (already set in `apps/console/railway.json`), not the default `/`. `/api/healthz` is the only route excluded from Clerk auth; every other route runs inside `clerkMiddleware()` (GH-134).

## Clerk

Login only; no app data or behavior lives here. Manage users and allowed origins (the console's Railway domain must be listed) in the Clerk dashboard. Its only footprint in our infrastructure is the two keys above, copied into the Railway console service.

## Cloudflare (sealevel-mcp-server)

The live knowledge layer: an MCP Worker plus a D1 database (the wiki), deployed from the sealevel-mcp-server repo via wrangler. Its wrangler secrets:

- `MINDBODY_API_KEY`, `MINDBODY_SITE_ID`: back the live `upcoming_classes` and `class_pricing` tools.
- The MCP OAuth secrets and the service-token secrets that authenticate clients, including the ai-manager worker's service identity and the separate `KB_WRITER_TOKEN` for the `service:kb-writer` identity (the only identity with the gated `write_wiki_page` tool; sealevel-mcp-server PR #26). `KB_WRITER_TOKEN` must be minted there before any approved KB update can actually write.

Config changes here (new tools, identity scoping) ship from that repo, not this one. The ai-manager side only holds the client pair `SEALEVEL_MCP_URL` / `SEALEVEL_MCP_TOKEN`, plus `SEALEVEL_MCP_KB_WRITER_TOKEN` (the client copy of `KB_WRITER_TOKEN`) on the worker for the KB write-back job, and `SEALEVEL_MCP_ANALYTICS_TOKEN` (the client copy of `ANALYTICS_TOKEN`, SEA-79) on the worker for analytics/campaign reads.

## GitHub Actions

- **sealevel-analytics**: repo secrets for the nightly Mindbody data sync, the `MB_*` (Mindbody API) and `CLOUDFLARE_*` (D1 access) sets.
- **ai-manager**: `ANTHROPIC_API_KEY`, used only by the drafting-evals CI job (`.github/workflows/ci.yml`); absent, the live eval steps skip with a notice.

## Operational gotchas

1. **Railway stages variable changes.** Editing a variable does not apply it; the change sits staged until you click Deploy. If a new value seems to have no effect, check for a pending deploy.
2. **Raw strings only.** Env values must be pasted without surrounding quotes. A quoted value (for example `"true"` including the quote characters) becomes part of the string and silently fails comparisons like `GMAIL_SEND_ENABLED === "true"`.
