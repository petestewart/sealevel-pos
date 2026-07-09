import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Minimal .env loader for local dev scripts (migrate, smoke).
 * Loads KEY=VALUE lines from the repo-root .env if present; never
 * overrides variables already set in the environment. On Railway,
 * variables come from the service environment and no .env exists.
 */
export function loadEnv(envPath?: string): void {
  // Default: repo root .env (this file compiles to packages/core/dist/env.js).
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const path = envPath ?? resolve(moduleDir, "../../../.env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Read a required environment variable or throw with a clear message. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
