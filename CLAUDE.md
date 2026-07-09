# AI Manager — Sealevel Hot Yoga

Always-on AI ops system for Sealevel Hot Yoga (Seattle). The full system design is in ARCHITECTURE.md — read it before any build work; its "First build checklist" is the Phase 0 implementation plan.

## Locked decisions (2026-07-08)
- Hosting: Railway, Pro plan. One project: worker, Next.js console, Postgres, Redis. Build an automated nightly off-platform pg_dump into Phase 0.
- Auth: Clerk.
- Assignment: AI suggests an assignee, human confirms. No auto-assign in v1.
- Auto-send: nothing auto-sends in v1. Every outbound reply is an approval item.
- Models: claude-sonnet-5 for triage/classification jobs, claude-opus-4-8 for drafting.

## Phasing
Phase 0 (skeleton) and Phase 1 (email triage + assignment/routing) are unblocked. Phase 2 (Mindbody analytics) is gated on Mindbody production API access. Task tracking lives on GitHub Project 2 "Sealevel Ops" (owner petestewart); the epic is sealevel-knowledge-base issue #17.

## Conventions
- Node + TypeScript monorepo per ARCHITECTURE.md repo structure (apps/worker, apps/console, packages/core, packages/features, analytics/dbt).
- Secrets in .env, gitignored. Never commit credentials.
- No em dashes in any outgoing user-facing copy (emails, SMS, notifications).
