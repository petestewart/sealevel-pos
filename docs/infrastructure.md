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
| `SEALEVEL_MCP_ANALYTICS_TOKEN` | no | Analytics reads (SEA-79): the analytics service credential (server secret `ANALYTICS_TOKEN`, minted via wrangler in sealevel-mcp-server), scoped server-side to the five read-only D1 analytics tools for campaign audience building; unset = the analytics toolset is simply absent. Worker only, never the console |
| `MINDBODY_API_KEY`, `MINDBODY_SITE_ID` | no | Mindbody Public API v6 for the nightly `campaigns.sync_contacts` job (SEA-81) — the same credential pair the sealevel-mcp-server Worker holds as wrangler secrets, duplicated here because the sync calls Mindbody directly; unset = the sync is a logged skip. Worker only, never the console |
| `MINDBODY_STAFF_USERNAME`, `MINDBODY_STAFF_PASSWORD` | no | Staff credentials for the Mindbody user token (`/usertoken/issue`); optional but recommended — permission level governs how much client data `/client/clients` returns. Worker only, never the console |
| `CAMPAIGNS_SYNC_CRON` | no | Contact sync cadence override; default `0 5 * * *`, evaluated in America/Los_Angeles (clear of the 02:00–03:30 PT analytics rebuild) |
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
