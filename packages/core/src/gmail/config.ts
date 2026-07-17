/**
 * Gmail integration config (GH-95, inbound ingestion + outbound send).
 *
 * The worker talks to the studio's Gmail inbox over the Gmail REST API,
 * authenticating as an installed OAuth2 app with a long-lived refresh
 * token (the standard headless-server pattern; no interactive consent at
 * runtime). Config lives entirely in the environment, exactly like the KB
 * connection (tools/kb.ts): when it is absent the whole Gmail layer is
 * inert -- ingestion polls nothing, sending is disabled -- so local dev,
 * tests, and a not-yet-provisioned deploy never require Google creds and
 * never touch a real mailbox.
 *
 * Required for ingestion AND send (all four):
 *   GMAIL_CLIENT_ID      OAuth2 client id
 *   GMAIL_CLIENT_SECRET  OAuth2 client secret
 *   GMAIL_REFRESH_TOKEN  offline refresh token for the studio mailbox
 *   GMAIL_USER           the mailbox address (From: header, logging)
 *
 * Optional (safe defaults):
 *   GMAIL_INGEST_QUERY     Gmail search for the poll (default: unread inbox)
 *   GMAIL_INGEST_MAX       max messages pulled per poll (default 25)
 *   GMAIL_PROCESSED_LABEL  label added after a message is ingested
 *   GMAIL_MARK_READ        "false" to leave ingested mail unread
 *   GMAIL_POLL_CRON        poll schedule (default every 2 minutes)
 *   GMAIL_SEND_ENABLED     "true" to actually send approved replies
 *
 * No secret is ever logged. GMAIL_SEND_ENABLED defaults OFF so that
 * standing up the credentials enables INGESTION (safe, read + label only)
 * without silently turning on OUTBOUND delivery; a human must opt in to
 * sending, which honors the CLAUDE.md "nothing auto-sends in v1" lock --
 * the operator's Approve click is the send trigger, and even that does
 * nothing until sending is explicitly enabled for the deployment.
 */

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  user: string;
  ingestQuery: string;
  ingestMax: number;
  processedLabel: string | null;
  markRead: boolean;
  pollCron: string;
}

/** Default Gmail search for the ingest poll: unread mail in the inbox. */
export const DEFAULT_INGEST_QUERY = "in:inbox is:unread";

/** Default poll cadence: every 2 minutes. */
export const DEFAULT_POLL_CRON = "*/2 * * * *";

/** Default cap on messages pulled per poll (keeps a backlog from stampeding). */
export const DEFAULT_INGEST_MAX = 25;

/** Default label applied to a message once it has been ingested. */
export const DEFAULT_PROCESSED_LABEL = "AI-Manager/Ingested";

/**
 * True when all four required Gmail credentials are present. Gates every
 * network path in the Gmail layer; when false the layer no-ops.
 */
export function gmailConfigured(): boolean {
  return Boolean(
    process.env["GMAIL_CLIENT_ID"] &&
      process.env["GMAIL_CLIENT_SECRET"] &&
      process.env["GMAIL_REFRESH_TOKEN"] &&
      process.env["GMAIL_USER"],
  );
}

/**
 * True when Gmail is configured AND outbound send is explicitly enabled
 * (GMAIL_SEND_ENABLED=true). This is the gate the console checks before
 * enqueuing a send on approval and the send routine checks before it
 * delivers: unset, approvals behave exactly as in v1 (decision recorded,
 * nothing sent).
 */
export function gmailSendConfigured(): boolean {
  return gmailConfigured() && process.env["GMAIL_SEND_ENABLED"] === "true";
}

/**
 * Read the effective Gmail config from the environment, or throw if a
 * required field is missing. Call only behind a gmailConfigured() check
 * (or when you want the throw). Optional fields fall back to the defaults
 * above; a malformed GMAIL_INGEST_MAX throws rather than silently using 0.
 */
export function gmailConfig(): GmailConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };

  const rawMax = process.env["GMAIL_INGEST_MAX"];
  let ingestMax = DEFAULT_INGEST_MAX;
  if (rawMax !== undefined && rawMax !== "") {
    const parsed = Number(rawMax);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `GMAIL_INGEST_MAX must be a positive integer, got "${rawMax}"`,
      );
    }
    ingestMax = parsed;
  }

  const label = process.env["GMAIL_PROCESSED_LABEL"];
  return {
    clientId: required("GMAIL_CLIENT_ID"),
    clientSecret: required("GMAIL_CLIENT_SECRET"),
    refreshToken: required("GMAIL_REFRESH_TOKEN"),
    user: required("GMAIL_USER"),
    ingestQuery:
      process.env["GMAIL_INGEST_QUERY"]?.trim() || DEFAULT_INGEST_QUERY,
    ingestMax,
    // An explicit empty label disables labeling; unset uses the default.
    processedLabel:
      label === undefined ? DEFAULT_PROCESSED_LABEL : label.trim() || null,
    markRead: process.env["GMAIL_MARK_READ"] !== "false",
    pollCron: process.env["GMAIL_POLL_CRON"]?.trim() || DEFAULT_POLL_CRON,
  };
}

/** The configured poll cadence, without requiring the full config to be valid. */
export function gmailPollCron(): string {
  return process.env["GMAIL_POLL_CRON"]?.trim() || DEFAULT_POLL_CRON;
}
