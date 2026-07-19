import {
  kbProposalOf,
  kbWriteOf,
  recordKbWrite,
  type KbWriteRecord,
} from "../db/kbItems.js";
import { getItemById, type Item } from "../db/items.js";
import { KbClient } from "../tools/kb.js";

/**
 * The kb.write worker job (Job B of the KB write-back loop, GH-113;
 * design doc docs/design/kb-write-back.md). Runs ONLY after a human
 * approved a kb_update proposal in the console -- the approval is the
 * write authorization, exactly like the email send path -- and commits
 * the change through the MCP server's gated write_wiki_page tool
 * (sealevel-mcp-server PR #26) as the DISTINCT kb-writer service
 * identity.
 *
 * Credential separation: this module builds its own KbClient from
 * SEALEVEL_MCP_KB_WRITER_TOKEN (same SEALEVEL_MCP_URL). The drafting
 * toolset (tools/kb.ts) keeps its read token and never sees this one; the
 * server scopes each token independently, so even a fully compromised
 * drafting run holds a read-only credential.
 *
 * Provenance is built HERE, from the decided item row (approver, item id,
 * source email reference, summary) -- never from a model, which never
 * holds the write tool and so can neither forge nor omit it.
 *
 * Idempotency and outcomes:
 *  - Deterministic BullMQ jobId (kbwrite-<itemId>) makes double-enqueue a
 *    windowed no-op; the server treats identical content as an
 *    already-applied success without a duplicate audit row, so retries
 *    can never double-commit.
 *  - Every outcome lands on the item as payload.kb_write
 *    (written | stale | denied | failed | skipped), surfaced in the
 *    console's Knowledge view. `stale` (the page changed between propose
 *    and approve) and `denied` (protected page / identity) are terminal
 *    for THIS proposal: the honest recovery is a fresh proposal against
 *    the current page, not a blind retry. `failed` retries via BullMQ
 *    and, past that, via reopen + re-approve in the console.
 *  - Without the writer token the job records `skipped`: the human
 *    decision stands, nothing pretends to have written, and re-approving
 *    after the token is configured retries the write.
 */

/** Whether the writer connection is configured in the environment. */
export function kbWriterConfigured(): boolean {
  return Boolean(
    process.env["SEALEVEL_MCP_URL"] &&
      process.env["SEALEVEL_MCP_KB_WRITER_TOKEN"],
  );
}

/** Writer client singleton, keyed on config so env changes take effect. */
let writerClient: KbClient | undefined;
let writerClientKey: string | undefined;

function getWriterClient(): KbClient {
  const url = process.env["SEALEVEL_MCP_URL"] ?? "";
  const token = process.env["SEALEVEL_MCP_KB_WRITER_TOKEN"] ?? "";
  const key = `${url}\n${token}`;
  if (!writerClient || writerClientKey !== key) {
    writerClient = new KbClient(url, token);
    writerClientKey = key;
  }
  return writerClient;
}

/** What one kb.write run did, for the worker's log line. */
export interface KbWriteJobResult {
  status: KbWriteRecord["status"] | "already_written" | "not_writable";
  detail?: string;
}

/**
 * Injectable dependencies so the offline smoke can exercise every branch
 * against a mocked MCP endpoint and a fake item store; production callers
 * pass nothing.
 */
export interface KbWriteDeps {
  configured?: boolean;
  loadItem?: (id: string) => Promise<Item | null>;
  record?: (id: string, rec: Omit<KbWriteRecord, "at">) => Promise<void>;
  callTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
}

/** Parse the write tool's structured JSON result out of its text content. */
export function parseWriteToolResult(
  text: string,
): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

/**
 * Commit one approved kb_update item to the wiki. Returns a structured
 * result; throws only on a retryable failure (after recording 'failed'),
 * so BullMQ retries. Ineligible items (reopened, rejected, malformed,
 * already written) return without throwing: a retry cannot change them.
 */
export async function writeApprovedKbUpdate(
  itemId: string,
  deps: KbWriteDeps = {},
): Promise<KbWriteJobResult> {
  const loadItem = deps.loadItem ?? getItemById;
  const record = deps.record ?? recordKbWrite;
  const configured = deps.configured ?? kbWriterConfigured();

  const item = await loadItem(itemId);
  if (!item || item.type !== "kb_update") {
    console.warn(`[kb-write] item ${itemId}: not a kb_update item; skipping`);
    return { status: "not_writable", detail: "not a kb_update item" };
  }
  const decision = item.payload["decision"] as
    | { action?: unknown; by?: { id?: unknown; name?: unknown }; at?: unknown }
    | undefined;
  if (item.status !== "resolved" || decision?.action !== "approved") {
    // Reopened or rejected since the enqueue: the human took it back.
    console.log(
      `[kb-write] item ${itemId}: no longer an approved kb_update; nothing to write`,
    );
    return { status: "not_writable", detail: "not approved" };
  }
  const existing = kbWriteOf(item.payload);
  if (existing?.status === "written") {
    console.log(`[kb-write] item ${itemId}: already written; skipping`);
    return { status: "already_written" };
  }
  const proposal = kbProposalOf(item.payload);
  if (!proposal) {
    // Unrecoverable: a retry cannot repair the payload.
    await record(itemId, {
      status: "failed",
      error: "The proposal payload is malformed and cannot be written.",
    });
    console.warn(`[kb-write] item ${itemId}: malformed proposal payload`);
    return { status: "failed", detail: "malformed proposal" };
  }

  if (!configured) {
    // Honest config gate, like every other config-gated path: the
    // decision is recorded, nothing pretends to have written, and
    // re-approving after configuration retries.
    await record(itemId, {
      status: "skipped",
      error:
        "The KB writer token is not configured, so the approved update was not written. Configure SEALEVEL_MCP_KB_WRITER_TOKEN, then reopen and approve again to retry.",
    });
    console.warn(
      `[kb-write] item ${itemId}: writer token not configured; recorded skipped`,
    );
    return { status: "skipped" };
  }

  // Provenance from the decided row, not from any model output.
  const by = decision.by ?? {};
  const approverName = typeof by.name === "string" ? by.name : "unknown";
  const approverId = typeof by.id === "string" ? by.id : "unknown";
  const source = (item.payload["source"] ?? {}) as Record<string, unknown>;
  const sourceBits = [
    `kb_update item ${itemId}`,
    typeof source["message_id"] === "string"
      ? `email ${source["message_id"]}`
      : null,
    typeof source["revert_of_item_id"] === "string"
      ? `revert of item ${source["revert_of_item_id"]}`
      : null,
  ].filter(Boolean);
  const provenance = {
    approved_by: `${approverName} (${approverId})`,
    source_ref: sourceBits.join(", "),
    reason:
      proposal.summary.trim() ||
      proposal.rationale.trim() ||
      "Approved knowledge base update.",
  };

  let resultText: string;
  try {
    const callTool =
      deps.callTool ??
      ((name: string, args: Record<string, unknown>) =>
        getWriterClient().callTool(name, args));
    resultText = await callTool("write_wiki_page", {
      name: proposal.target_page,
      content: proposal.proposed_content,
      base_hash: proposal.base_hash,
      provenance,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await record(itemId, { status: "failed", error: message });
    // Transient (network, session, server): throw so BullMQ retries.
    throw new Error(`[kb-write] item ${itemId} failed: ${message}`);
  }

  const parsed = parseWriteToolResult(resultText);
  const status = parsed ? strField(parsed, "status") : "";
  switch (status) {
    case "written": {
      const hash = parsed ? strField(parsed, "hash") : "";
      await record(itemId, {
        status: "written",
        ...(hash ? { new_hash: hash } : {}),
      });
      console.log(
        `[kb-write] item ${itemId}: wrote page "${proposal.target_page}" (hash ${hash || "?"})`,
      );
      return { status: "written" };
    }
    case "conflict": {
      // Stale base: the page changed between propose and approve. Honest
      // terminal outcome for this proposal; the console surfaces it and
      // the recovery is a FRESH proposal against the current page (see
      // the design doc's status note). Not retried: a retry would hit the
      // same guard.
      const error =
        strField(parsed ?? {}, "error") ||
        "The page changed since this proposal was computed. Nothing was written.";
      await record(itemId, { status: "stale", error });
      console.warn(
        `[kb-write] item ${itemId}: stale base for "${proposal.target_page}"; nothing written`,
      );
      return { status: "stale", detail: error };
    }
    case "denied":
    case "invalid": {
      const error =
        strField(parsed ?? {}, "error") || "The server refused the write.";
      await record(itemId, { status: "denied", error });
      console.warn(
        `[kb-write] item ${itemId}: write denied for "${proposal.target_page}": ${error}`,
      );
      return { status: "denied", detail: error };
    }
    default: {
      const error = parsed
        ? strField(parsed, "error") ||
          `unexpected write result status "${status}"`
        : `unparseable write result: ${resultText.slice(0, 200)}`;
      await record(itemId, { status: "failed", error });
      // Unknown/server-error shape: throw so BullMQ retries.
      throw new Error(`[kb-write] item ${itemId} failed: ${error}`);
    }
  }
}
