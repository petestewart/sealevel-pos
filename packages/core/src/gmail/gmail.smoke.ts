import assert from "node:assert/strict";

import { loadEnv } from "../env.js";
import {
  inboundEmailJobId,
  jobsForInboundEmail,
} from "../jobs/dispatch.js";
import {
  isKnownRoute,
  routeOwner,
  sanitizeSuggestion,
} from "../routing.js";
import {
  buildRawReply,
  decodeBase64Url,
  extractAddress,
  extractPlainBody,
  parseGmailMessage,
  replySubject,
  stripQuotedReply,
  type GmailMessageResource,
} from "./parse.js";
import {
  DEFAULT_INGEST_QUERY,
  DEFAULT_POLL_CRON,
  gmailConfig,
  gmailConfigured,
  gmailSendConfigured,
  gmailSendEnabled,
  gmailSendMode,
} from "./config.js";
import type { DeliveryStatus } from "../db/delivery.js";

/**
 * Gmail layer smoke test (GH-95). Everything here is pure/offline: message
 * parsing, reply building, dispatch matching, routing validation, and the
 * config gate logic. No mailbox, no Redis, no DB, no API key required -- it
 * runs anywhere and asserts the contracts the live pipeline depends on.
 *
 * Run: npm run smoke:gmail  (from packages/core)
 */

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function testParseMultipart(): void {
  const msg: GmailMessageResource = {
    id: "gmailid123",
    threadId: "thread456",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Jordan Lee <jordan@example.com>" },
        { name: "To", value: "hello@sealevel.example" },
        { name: "Subject", value: "Mat rentals?" },
        { name: "Message-ID", value: "<abc.123@mail.example.com>" },
        { name: "References", value: "<prev.1@mail.example.com>" },
        { name: "Reply-To", value: "jordan.reply@example.com" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: b64url("Do you rent mats?\nThanks, Jordan") },
        },
        {
          mimeType: "text/html",
          body: { data: b64url("<p>Do you rent mats?</p>") },
        },
      ],
    },
  };
  const parsed = parseGmailMessage(msg);
  assert.equal(parsed.messageId, "<abc.123@mail.example.com>");
  assert.equal(parsed.from, "Jordan Lee <jordan@example.com>");
  assert.equal(parsed.subject, "Mat rentals?");
  assert.equal(parsed.body, "Do you rent mats?\nThanks, Jordan");
  assert.equal(parsed.gmailId, "gmailid123");
  assert.equal(parsed.threadId, "thread456");
  assert.equal(parsed.messageIdHeader, "<abc.123@mail.example.com>");
  assert.equal(parsed.references, "<prev.1@mail.example.com>");
  assert.equal(parsed.replyTo, "jordan.reply@example.com");
  console.log("[smoke] parse multipart: prefers text/plain, extracts threading ok");
}

function testParseHtmlOnly(): void {
  const msg: GmailMessageResource = {
    id: "id2",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Subject", value: "Hi" }],
      body: { data: b64url("<div>Hello<br>there</div>") },
    },
  };
  const parsed = parseGmailMessage(msg);
  // HTML-only falls back to a stripped-text body.
  assert.equal(parsed.body, "Hello\nthere");
  // No Message-ID header -> messageId falls back to the Gmail id.
  assert.equal(parsed.messageId, "id2");
  console.log("[smoke] parse html-only: strips tags, falls back to gmail id");
}

function testParseAttachmentSkipped(): void {
  const msg: GmailMessageResource = {
    id: "id3",
    payload: {
      mimeType: "multipart/mixed",
      headers: [],
      parts: [
        { mimeType: "text/plain", body: { data: b64url("real body") } },
        {
          mimeType: "text/plain",
          filename: "note.txt",
          body: { data: b64url("attached, not the body") },
        },
      ],
    },
  };
  assert.equal(extractPlainBody(msg.payload), "real body");
  console.log("[smoke] parse: attachment text/plain part is not the body");
}

function testBuildRawReply(): void {
  const raw = buildRawReply({
    from: "Sealevel Hot Yoga <hello@sealevel.example>",
    to: "jordan@example.com",
    subject: "Re: Mat rentals?",
    body: "Yes, we rent mats for $3.\nSealevel Hot Yoga",
    inReplyTo: "<abc.123@mail.example.com>",
    references: "<prev.1@mail.example.com>",
  });
  // Decode the base64url message and check the headers + threaded body.
  const decoded = decodeBase64Url(raw);
  assert.ok(decoded.includes("From: Sealevel Hot Yoga <hello@sealevel.example>"));
  assert.ok(decoded.includes("To: jordan@example.com"));
  assert.ok(decoded.includes("In-Reply-To: <abc.123@mail.example.com>"));
  assert.ok(
    decoded.includes(
      "References: <prev.1@mail.example.com> <abc.123@mail.example.com>",
    ),
    "References chains prior + replied-to",
  );
  assert.ok(decoded.includes("Content-Transfer-Encoding: base64"));
  // The base64 body must round-trip back to the original reply text.
  const bodyB64 = decoded.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  const body = Buffer.from(bodyB64.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(body, "Yes, we rent mats for $3.\nSealevel Hot Yoga");
  console.log("[smoke] buildRawReply: headers + threading + base64 body round-trip ok");
}

function testUnicodeSubjectAndBody(): void {
  const raw = buildRawReply({
    from: "hello@sealevel.example",
    to: "student@example.com",
    subject: "Re: café 🧘 schedule",
    body: "Namaste 🙏 café",
  });
  const decoded = decodeBase64Url(raw);
  // Non-ASCII subject is RFC2047 encoded-word wrapped.
  assert.ok(
    decoded.includes("Subject: =?UTF-8?B?"),
    "non-ASCII subject is encoded-word wrapped",
  );
  const bodyB64 = decoded.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  const body = Buffer.from(bodyB64.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(body, "Namaste 🙏 café");
  console.log("[smoke] buildRawReply: unicode subject encoded, unicode body preserved");
}

function testHeaderInjection(): void {
  // The recipient and threading values derive from attacker-controlled
  // inbound headers. A CRLF-laden value must NOT inject extra headers.
  const crlf = String.fromCharCode(13) + String.fromCharCode(10);
  const raw = buildRawReply({
    from: "hello@sealevel.example",
    to: `jordan@example.com${crlf}Bcc: evil@attacker.example`,
    subject: `Hi${crlf}X-Injected: yes`,
    body: "hello",
    inReplyTo: `<id@x>${crlf}X-Evil: 1`,
  });
  const decoded = decodeBase64Url(raw);
  const headerBlock = decoded.split(crlf + crlf)[0]!;
  assert.ok(
    !/^Bcc:/im.test(headerBlock),
    "injected Bcc must not appear as a header",
  );
  assert.ok(
    !/^X-Injected:/im.test(headerBlock),
    "injected subject header must not break out",
  );
  assert.ok(!/^X-Evil:/im.test(headerBlock), "injected threading header blocked");
  // The legitimate recipient survives (sans the injected tail).
  assert.ok(headerBlock.includes("To: jordan@example.com"));
  console.log("[smoke] header injection: CRLF in to/subject/threading is neutralized");
}

function testStripQuotedReply(): void {
  // The real failure: a new question followed by an attribution line and the
  // quoted prior thread. Only the new question must survive.
  const withAttribution = [
    "what times do you have hot 26 classes on weekends?",
    "",
    "On Fri, Jul 18, 2026 at 3:00 PM Pete Stewart <pete@example.com> wrote:",
    "> when is your next vinyasa class",
    "> how much to drop in?",
  ].join("\n");
  assert.equal(
    stripQuotedReply(withAttribution),
    "what times do you have hot 26 classes on weekends?",
    "attribution line and everything after it is removed",
  );

  // Leading ">" quoted lines beneath the new message are cut.
  const withLeadingQuote = [
    "Sounds good, see you then.",
    "> earlier they wrote this",
    "> and this",
  ].join("\n");
  assert.equal(
    stripQuotedReply(withLeadingQuote),
    "Sounds good, see you then.",
    "run of leading > lines is removed",
  );

  // An Outlook-style "-----Original Message-----" block is cut.
  const withOriginal = [
    "Can I still use my intro offer?",
    "-----Original Message-----",
    "From: studio@sealevel.example",
    "Subject: welcome",
  ].join("\n");
  assert.equal(
    stripQuotedReply(withOriginal),
    "Can I still use my intro offer?",
    "Original Message delimiter and after is removed",
  );

  // A quoted Gmail header block (From:/Sent:/To:) starts the quote.
  const withHeaderBlock = [
    "Do you have parking?",
    "",
    "From: Pete Stewart <pete@example.com>",
    "Sent: Friday, July 18, 2026 3:00 PM",
    "To: studio@sealevel.example",
    "Subject: hi",
  ].join("\n");
  assert.equal(
    stripQuotedReply(withHeaderBlock),
    "Do you have parking?",
    "quoted From:/Sent:/To: header block starts the quote",
  );

  // A message with no quotes passes through unchanged.
  const noQuote = "Just wondering what your weekend hours are. Thanks!";
  assert.equal(stripQuotedReply(noQuote), noQuote, "no-quote body is unchanged");

  // Fallback: an all-quoted body (nothing new) returns the ORIGINAL so the
  // model is never handed an empty message.
  const allQuoted = ["> only quoted content", "> nothing new here"].join("\n");
  assert.equal(
    stripQuotedReply(allQuoted),
    allQuoted,
    "all-quoted body falls back to the original",
  );

  console.log(
    "[smoke] stripQuotedReply: cuts attribution/>/Original Message/header block, passes clean bodies, falls back when all-quoted",
  );
}

function testHelpers(): void {
  assert.equal(extractAddress("Jordan <jordan@example.com>"), "jordan@example.com");
  assert.equal(extractAddress("plain@example.com"), "plain@example.com");
  assert.equal(replySubject("Mat rentals"), "Re: Mat rentals");
  assert.equal(replySubject("Re: Mat rentals"), "Re: Mat rentals");
  assert.equal(replySubject("RE: shout"), "RE: shout");
  assert.equal(replySubject(""), "Re:");
  console.log("[smoke] helpers: extractAddress + replySubject ok");
}

function testDispatchMatching(): void {
  // The drafting job (email.received) has a catch-all email trigger, so any
  // inbound email matches it. jobsForInboundEmail must find exactly it.
  const matched = jobsForInboundEmail({
    from: "a@b.com",
    subject: "hi",
    body: "hello",
    messageId: "<x@y>",
  });
  const ids = matched.map((j) => j.id);
  assert.ok(ids.includes("email.received"), "email.received matches inbound mail");
  // Manual-only jobs (heartbeat) must NOT be matched by an inbound email.
  assert.ok(!ids.includes("manual.heartbeat"), "manual jobs do not match email");

  // jobId is deterministic and free of characters BullMQ forbids (":").
  const jobId = inboundEmailJobId("email.received", "<abc.123@mail.gmail.com>");
  assert.ok(!jobId.includes(":"), "jobId has no colon");
  assert.ok(!jobId.includes("<") && !jobId.includes(">"), "jobId sanitized");
  assert.equal(
    inboundEmailJobId("email.received", "<abc.123@mail.gmail.com>"),
    jobId,
    "jobId is deterministic",
  );
  console.log(`[smoke] dispatch: matches email.received, jobId="${jobId}"`);
}

function testRouting(): void {
  assert.ok(isKnownRoute("billing"));
  assert.ok(!isKnownRoute("nonsense"));
  assert.equal(routeOwner("billing"), "Pete");
  assert.equal(routeOwner("schedule"), "Alison");
  assert.equal(routeOwner("finance"), "Brooke");
  assert.equal(routeOwner("general"), "");

  // sanitizeSuggestion gates on the registry and trusts the registry owner.
  const good = sanitizeSuggestion({
    category: "Billing",
    suggestedName: "someone-forged",
    reason: "refund request",
    at: "2026-07-13T00:00:00Z",
  });
  assert.ok(good);
  assert.equal(good.category, "billing");
  assert.equal(good.suggestedName, "Pete", "owner comes from the registry, not the payload");
  assert.equal(sanitizeSuggestion({ category: "made-up" }), null);
  assert.equal(sanitizeSuggestion("nope"), null);
  assert.equal(sanitizeSuggestion(null), null);
  console.log("[smoke] routing: registry gate + owner mapping ok");
}

function testConfigGate(): void {
  // With no GMAIL_* env, the gates are closed and defaults hold.
  const hadCreds = gmailConfigured();
  if (!hadCreds) {
    assert.equal(gmailConfigured(), false);
    assert.equal(gmailSendConfigured(), false);
    assert.throws(() => gmailConfig(), /Missing required/);
    console.log("[smoke] config: unconfigured gates closed (as expected here)");
  } else {
    const cfg = gmailConfig();
    assert.ok(cfg.ingestQuery.length > 0);
    console.log("[smoke] config: configured; gates evaluated");
  }
  // Defaults are stable regardless of env.
  assert.equal(DEFAULT_INGEST_QUERY, "in:inbox is:unread");
  assert.equal(DEFAULT_POLL_CRON, "*/2 * * * *");
}

function testSendEnabledGate(): void {
  // The console gate (gmailSendEnabled) is the flag ALONE, with NO credential
  // check -- that is what keeps the Gmail refresh token off the web-facing
  // console. gmailSendConfigured (the worker gate) additionally requires the
  // full creds. Drive the flag directly and assert the split.
  const savedFlag = process.env["GMAIL_SEND_ENABLED"];
  const hadCreds = gmailConfigured();
  try {
    process.env["GMAIL_SEND_ENABLED"] = "true";
    assert.equal(
      gmailSendEnabled(),
      true,
      "flag true -> console gate open regardless of creds",
    );
    // The worker gate still needs creds, so it only opens when creds exist.
    assert.equal(
      gmailSendConfigured(),
      hadCreds,
      "worker gate tracks creds even with the flag on",
    );

    process.env["GMAIL_SEND_ENABLED"] = "false";
    assert.equal(gmailSendEnabled(), false, "flag false -> console gate shut");
    assert.equal(gmailSendConfigured(), false, "worker gate shut with flag off");

    delete process.env["GMAIL_SEND_ENABLED"];
    assert.equal(gmailSendEnabled(), false, "flag unset -> console gate shut");

    process.env["GMAIL_SEND_ENABLED"] = "1";
    assert.equal(gmailSendEnabled(), false, "only exact 'true' opens the gate");
  } finally {
    if (savedFlag === undefined) delete process.env["GMAIL_SEND_ENABLED"];
    else process.env["GMAIL_SEND_ENABLED"] = savedFlag;
  }
  console.log(
    "[smoke] send gate: console flag-only (gmailSendEnabled) vs worker full-creds (gmailSendConfigured)",
  );
}

function testSendMode(): void {
  // Gmail send/draft mode (GH-97): default is "send" (backward compatible),
  // only an exact "draft" flips it, and anything else falls back to "send".
  const saved = process.env["GMAIL_SEND_MODE"];
  try {
    delete process.env["GMAIL_SEND_MODE"];
    assert.equal(gmailSendMode(), "send", "unset defaults to send");
    process.env["GMAIL_SEND_MODE"] = "";
    assert.equal(gmailSendMode(), "send", "empty defaults to send");
    process.env["GMAIL_SEND_MODE"] = "draft";
    assert.equal(gmailSendMode(), "draft", "'draft' is respected");
    process.env["GMAIL_SEND_MODE"] = "SEND";
    assert.equal(gmailSendMode(), "send", "unrecognized falls back to send");
    process.env["GMAIL_SEND_MODE"] = "nonsense";
    assert.equal(gmailSendMode(), "send", "unrecognized falls back to send");
  } finally {
    if (saved === undefined) delete process.env["GMAIL_SEND_MODE"];
    else process.env["GMAIL_SEND_MODE"] = saved;
  }

  // The 'drafted' delivery status (GH-97) is part of the DeliveryStatus
  // union: this assignment fails typecheck if it is ever dropped, so the
  // draft-mode terminal state can never silently disappear.
  const drafted: DeliveryStatus = "drafted";
  assert.equal(drafted, "drafted", "delivery status list includes 'drafted'");
  console.log("[smoke] send mode: default send, 'draft' respected, 'drafted' status present");
}

async function main(): Promise<void> {
  loadEnv();
  testParseMultipart();
  testParseHtmlOnly();
  testParseAttachmentSkipped();
  testBuildRawReply();
  testUnicodeSubjectAndBody();
  testHeaderInjection();
  testStripQuotedReply();
  testHelpers();
  testDispatchMatching();
  testRouting();
  testConfigGate();
  testSendEnabledGate();
  testSendMode();
  console.log("[smoke] gmail: all offline assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
