import { loadEnv } from "@ai-manager/core";

/**
 * Side-effect module: load the repo-root .env (DATABASE_URL etc.) before any
 * server-side data access. Next only auto-loads .env files from the app
 * directory; this monorepo keeps one .env at the repo root, and core's
 * loadEnv never overrides variables already set (so Railway service env wins).
 */
loadEnv();
