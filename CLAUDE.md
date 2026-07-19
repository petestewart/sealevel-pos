# AI Manager — Sealevel Hot Yoga

Always-on AI ops system for Sealevel Hot Yoga (Seattle). The full system design is in ARCHITECTURE.md — read it before any build work; its "First build checklist" is the Phase 0 implementation plan.

## Locked decisions (2026-07-08)
- Hosting: Railway, Pro plan. One project: worker, Next.js console, Postgres, Redis. Build an automated nightly off-platform pg_dump into Phase 0.
- Auth: Clerk.
- Assignment: AI suggests an assignee, human confirms. No auto-assign in v1.
- Auto-send: nothing auto-sends in v1. Every outbound reply is an approval item.
- Outbound email is draft-mode by default: with GMAIL_SEND_MODE=draft an approval parks a Gmail draft for a human to send from Gmail. The operator's Approve click is the only trigger either way; nothing auto-sends.
- Read state (2026-07-19): read = decided. A message stays unread in Gmail until its item is decided (approve/reject/no-reply/trash/spam); the decision enqueues a worker job that marks it read. Ingestion marks only the processed label (GMAIL_MARK_READ stays false); the label means ingested, the read flag means a human decided.
- Pricing and schedule come EXCLUSIVELY from the live Mindbody tools (class_pricing, upcoming_classes), never from the wiki. The wiki is for policies and studio info only.
- Customer drafts never narrate the assistant's knowledge, tools, or access; never promise follow-ups; never invite a reply for information the tools could not provide.
- Booking is self-service: customers book themselves at SEALEVEL_BOOKING_URL. Drafts never offer to book for the customer.
- Models: claude-sonnet-5 for triage/classification jobs, claude-opus-4-8 for drafting.

## Phasing
Phase 0 (skeleton) and Phase 1 (email triage + assignment/routing) are unblocked. Phase 2 (Mindbody analytics) is gated on Mindbody production API access. Task tracking lives on GitHub Project 2 "Sealevel Ops" (owner petestewart); the epic is sealevel-knowledge-base issue #17.

## Evals
Golden-case drafting evals live in evals/ (cases + cached outputs); run with `npm run eval`. CI runs them on PRs that touch prompt-affecting paths (drafting job, booking, KB tools, prompts, eval code) when the ANTHROPIC_API_KEY repo secret is present; manual dispatch from the Actions tab runs the full suite on demand. Any prompt-affecting change must keep the evals green.

## Configuration
Where config lives (Railway, Clerk, Cloudflare, GitHub Actions) is mapped in docs/infrastructure.md.

## Conventions
- Node + TypeScript monorepo per ARCHITECTURE.md repo structure (apps/worker, apps/console, packages/core, packages/features, analytics/dbt).
- Secrets in .env, gitignored. Never commit credentials.
- No em dashes in any outgoing user-facing copy (emails, SMS, notifications).
