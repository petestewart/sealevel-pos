#!/usr/bin/env node
/**
 * Mint a Gmail refresh token for the AI Manager worker (GH-95).
 *
 * The worker authenticates to Gmail as the studio mailbox using a long-lived
 * OAuth2 refresh token. This one-time helper runs the consent flow on your
 * own machine (it needs a browser and a localhost redirect, so it cannot run
 * on the server) and prints the refresh token to paste into the deploy env.
 *
 * Prerequisites (Google Cloud Console, ~10 min):
 *   1. Create/select a project and enable the "Gmail API".
 *   2. Configure the OAuth consent screen. If it is in "Testing", add the
 *      studio mailbox address as a Test user.
 *   3. Create an OAuth client of type "Desktop app". Copy its client id and
 *      client secret. (Desktop clients allow a localhost loopback redirect,
 *      so you do not need to pre-register a redirect URI.)
 *
 * Usage (from the repo root, on your laptop):
 *   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy \
 *     node scripts/gmail/mint-refresh-token.mjs
 *
 * Then open the printed URL, sign in AS THE STUDIO MAILBOX, and approve.
 * The script prints GMAIL_REFRESH_TOKEN=... when done.
 *
 * Scope: gmail.modify -- the single scope that covers everything the worker
 * does (read, label, mark read, AND send). No secret is written to disk.
 */
import http from "node:http";

const clientId = process.env.GMAIL_CLIENT_ID || process.argv[2];
const clientSecret = process.env.GMAIL_CLIENT_SECRET || process.argv[3];

if (!clientId || !clientSecret) {
  console.error(
    "Missing credentials. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET " +
      "(env vars or the first two CLI args).",
  );
  process.exit(1);
}

const port = Number(process.env.PORT || 4756);
const redirectUri = `http://localhost:${port}`;
const scope = "https://www.googleapis.com/auth/gmail.modify";

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", scope);
authUrl.searchParams.set("access_type", "offline");
// prompt=consent forces Google to return a refresh_token even if this
// mailbox already granted the app before.
authUrl.searchParams.set("prompt", "consent");

console.log(
  "\n1. Open this URL in a browser, sign in AS THE STUDIO MAILBOX, and approve:\n",
);
console.log(authUrl.toString());
console.log(`\n2. Waiting for the Google redirect on ${redirectUri} ...`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== "/") {
    res.writeHead(404).end();
    return;
  }
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error) {
    res.writeHead(400).end(`Authorization failed: ${error}. Check the terminal.`);
    console.error(`\nAuthorization failed: ${error}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end("No authorization code in the request.");
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const json = await tokenRes.json();
    if (!tokenRes.ok || !json.refresh_token) {
      res
        .writeHead(500)
        .end("Token exchange did not return a refresh token. Check the terminal.");
      console.error(
        `\nToken exchange failed: HTTP ${tokenRes.status}` +
          (json.error ? ` ${json.error}` : "") +
          (json.refresh_token === undefined
            ? "\nNo refresh_token returned. Revoke the app's prior access at " +
              "https://myaccount.google.com/permissions and run this again " +
              "(prompt=consent is already set)."
            : ""),
      );
      server.close();
      process.exit(1);
    }
    res
      .writeHead(200, { "Content-Type": "text/plain" })
      .end("Success. Refresh token minted. You can close this tab.");
    console.log("\n3. Success. Set this on the worker (and console) service:\n");
    console.log(`GMAIL_REFRESH_TOKEN=${json.refresh_token}\n`);
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500).end("Unexpected error. Check the terminal.");
    console.error("\nUnexpected error:", err);
    server.close();
    process.exit(1);
  }
});

server.listen(port);
