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

## Clerk

Login only; no app data or behavior lives here. Manage users and allowed origins (the console's Railway domain must be listed) in the Clerk dashboard. Its only footprint in our infrastructure is the two keys above, copied into the Railway console service.

## Cloudflare (sealevel-mcp-server)

The live knowledge layer: an MCP Worker plus a D1 database (the wiki), deployed from the sealevel-mcp-server repo via wrangler. Its wrangler secrets:

- `MINDBODY_API_KEY`, `MINDBODY_SITE_ID`: back the live `upcoming_classes` and `class_pricing` tools.
- The MCP OAuth secrets and the service-token secrets that authenticate clients, including the ai-manager worker's service identity.

Config changes here (new tools, identity scoping) ship from that repo, not this one. The ai-manager side only holds the client pair `SEALEVEL_MCP_URL` / `SEALEVEL_MCP_TOKEN`.

## GitHub Actions

- **sealevel-analytics**: repo secrets for the nightly Mindbody data sync, the `MB_*` (Mindbody API) and `CLOUDFLARE_*` (D1 access) sets.
- **ai-manager**: `ANTHROPIC_API_KEY`, used only by the drafting-evals CI job (`.github/workflows/ci.yml`); absent, the live eval steps skip with a notice.

## Operational gotchas

1. **Railway stages variable changes.** Editing a variable does not apply it; the change sits staged until you click Deploy. If a new value seems to have no effect, check for a pending deploy.
2. **Raw strings only.** Env values must be pasted without surrounding quotes. A quoted value (for example `"true"` including the quote characters) becomes part of the string and silently fails comparisons like `GMAIL_SEND_ENABLED === "true"`.
