import type { Job, JobContext } from "./types.js";

/**
 * Async lane end to end (ARCHITECTURE.md "Two lanes"): a manual-trigger
 * job that drafts a reply to an inbound email and surfaces it as an
 * items row pending human approval. Nothing sends anything; the draft
 * lives in the item payload until a human approves it in the console.
 *
 * Payload: the inbound email (from, subject, body, optional messageId),
 * passed through from the enqueue call.
 */

/** Shape of the inbound email payload this job expects. */
export interface InboundEmailPayload {
  from?: string;
  subject?: string;
  body?: string;
  /** Source message id, used for idempotent enqueue upstream. */
  messageId?: string;
}

function renderEmail(payload: InboundEmailPayload): string {
  return [
    `From: ${payload.from ?? "(unknown sender)"}`,
    `Subject: ${payload.subject ?? "(no subject)"}`,
    "",
    payload.body ?? "(empty body)",
  ].join("\n");
}

export const emailDraft: Job = {
  id: "manual.email_draft",
  enabled: true,
  triggers: [{ kind: "manual" }],
  tools: ["create_item"],
  model: "claude-opus-4-8", // drafting job (locked decisions in CLAUDE.md)
  instructions: (ctx: JobContext) => {
    const payload = (ctx.payload ?? {}) as InboundEmailPayload;
    return `
An inbound email to the studio needs a reply. Draft one; do not send anything.

Inbound email:
---
${renderEmail(payload)}
---

Do this:
1. Write a short, warm, plain reply (a few sentences). No em dashes. Sign off as "the AI Manager".
2. Call create_item exactly once with:
   - type: "email_reply"
   - domain: "email"
   - status: "pending_approval"${
     payload.messageId
       ? `\n   - dedupe_key: ${JSON.stringify(payload.messageId)} (retry safety: if an item with this key already exists, the tool returns it instead of creating a duplicate; treat that as success)`
       : ""
   }
   - payload: { "draft_subject": <reply subject>, "draft_body": <your reply>, "original_email": <the inbound email fields you were given> }
3. Reply with a one-line summary including the created item id.

The draft only becomes real if a human approves it later. Do not claim anything was sent.
`;
  },
};
