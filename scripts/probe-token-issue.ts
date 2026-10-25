/**
 * Does the sandbox issue a staff token for the credentials in .env, and
 * does it keep issuing them back to back?
 *
 * Pete's sandbox sign-in (2026-09-20): the teacher sign-in gate issued a
 * token for the typed sandbox login and, seconds later, the service
 * account's own issue with the SAME values from .env answered 403 "Staff
 * identity authentication failed". src/lib/mindbody.ts records the
 * sandbox once refusing to issue tokens for every credential set while
 * still honouring earlier ones, so this asks the one question that tells
 * a throttle from a mismatch: three issues in a row, then one more after
 * a pause, each printed with its status, the user Mindbody named, and the
 * first characters of the username as .env holds it.
 *
 *   MINDBODY_TARGET=sandbox npx tsx --env-file=.env scripts/probe-token-issue.ts
 *
 * Reads only. Every token it is given is revoked before the next.
 */
import { mindbodyEnv } from "../src/lib/mindbody";

async function issue(env: ReturnType<typeof mindbodyEnv>, label: string) {
  const res = await fetch(`${env.baseUrl}/usertoken/issue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Api-Key": env.apiKey,
      SiteId: env.siteId,
    },
    body: JSON.stringify({ Username: env.username, Password: env.password }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  const token = body?.AccessToken;
  if (res.ok && typeof token === "string") {
    const u = body?.User ?? {};
    console.log(
      `    ${label}: OK  user ${u?.Id} ${u?.FirstName ?? ""} ${u?.LastName ?? ""} type ${u?.Type}`,
    );
    await fetch(`${env.baseUrl}/usertoken/revoke`, {
      method: "DELETE",
      headers: { "Api-Key": env.apiKey, SiteId: env.siteId, Authorization: token },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
  } else {
    console.log(`    ${label}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  }
}

async function main() {
  const env = mindbodyEnv();
  const u = env.username;
  console.log(`=== POST /usertoken/issue  site ${env.siteId}  base ${env.baseUrl}`);
  console.log(
    `    username as .env holds it: "${u.slice(0, 3)}...${u.slice(-6)}" (${u.length} chars)` +
      `, password ${env.password.length} chars` +
      `${/^\s|\s$/.test(u) || /^\s|\s$/.test(env.password) ? "  <-- LEADING OR TRAILING WHITESPACE" : ""}`,
  );
  await issue(env, "issue 1");
  await issue(env, "issue 2");
  await issue(env, "issue 3");
  console.log("    waiting 20s...");
  await new Promise((r) => setTimeout(r, 20_000));
  await issue(env, "issue 4");
}

void main();
