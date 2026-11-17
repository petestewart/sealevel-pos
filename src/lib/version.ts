import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * T246: which build this server process is running, so a page that has
 * been open since an earlier deploy can tell that a newer one is up.
 *
 * Three sources, in order:
 *
 * 1. `RAILWAY_GIT_COMMIT_SHA`, which Railway sets on every deploy. It is
 *    the commit, so two deploys of one commit read as one version, which
 *    is right: nothing a page runs has changed.
 * 2. Next's own build id, `.next/BUILD_ID`, read once. A local
 *    `next build` gets a new one each time.
 * 3. A value fixed when this process started, so a dev server (which has
 *    no BUILD_ID worth trusting) still changes version on a restart.
 *
 * It is not a secret: it names a commit, and the page only ever compares
 * it with the one it loaded with. Held on globalThis so every route of
 * this process answers the SAME value, the fallback included, whatever
 * bundle a route was compiled into.
 */

const G = globalThis as typeof globalThis & { __posBuildVersion?: string };

function readBuildId(): string | null {
  /* A dev server's BUILD_ID is whatever the last `next build` left, and
   * would not change on a restart; the process-start value does. */
  if (process.env.NODE_ENV !== "production") return null;
  try {
    const id = readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
    return id.length > 0 && id !== "development" ? id : null;
  } catch {
    return null;
  }
}

export function buildVersion(): string {
  if (G.__posBuildVersion !== undefined) return G.__posBuildVersion;
  const sha = (process.env.RAILWAY_GIT_COMMIT_SHA ?? "").trim();
  const version =
    sha.length > 0
      ? sha
      : (readBuildId() ?? `boot-${Date.now().toString(36)}`);
  G.__posBuildVersion = version;
  return version;
}
