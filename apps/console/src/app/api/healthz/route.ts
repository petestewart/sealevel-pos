/**
 * Liveness endpoint for Railway healthchecks. Public (excluded from Clerk
 * auth in middleware.ts) and dependency-free: it reports that the Next.js
 * server is up, not that Postgres/Clerk are reachable.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ ok: true });
}
