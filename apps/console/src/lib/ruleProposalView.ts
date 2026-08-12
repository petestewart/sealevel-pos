import {
  ruleInsertOf,
  ruleProposalOf,
  type Item,
  type RuleEvidence,
  type RuleInsertRecord,
} from "@ai-manager/core";
import { formatCardTimestamp, formatDateTime } from "./emailDisplay";

/**
 * View-model helpers for rule_proposal items (learning loop, GH-127),
 * mirroring how kbView.ts serves kb_update items: the pending card and
 * the decided detail derive from the same validated shape here.
 */

/** Serializable card data for a rule_proposal item. */
export interface RuleProposalCardData {
  id: string;
  ruleText: string;
  /** Miner confidence (0..1), or null when absent. */
  confidence: number | null;
  evidence: RuleEvidence[];
  /** The mined window, pre-formatted, or null when absent. */
  minedWindow: { from: string; to: string; signals: number } | null;
  /** True when a human edited the rule text before deciding. */
  edited: boolean;
  receivedTime: string;
  receivedFull: string;
  /** The rule-insert outcome (payload.rule_insert), or null. */
  ruleInsert: RuleInsertRecord | null;
}

function formatWindowDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return formatDateTime(date);
}

export function toRuleProposalCardData(
  item: Item,
): RuleProposalCardData | null {
  const proposal = ruleProposalOf(item.payload);
  if (!proposal) return null;
  const window = proposal.mined_window;
  const from = formatWindowDate(window.from);
  const to = formatWindowDate(window.to);
  return {
    id: String(item.id),
    ruleText: proposal.rule_text,
    confidence:
      proposal.confidence > 0 && proposal.confidence <= 1
        ? proposal.confidence
        : null,
    evidence: proposal.evidence,
    minedWindow:
      to.length > 0 ? { from, to, signals: window.signals } : null,
    edited: item.payload["proposal_edited"] === true,
    receivedTime: formatCardTimestamp(item.created_at),
    receivedFull: formatDateTime(item.created_at),
    ruleInsert: ruleInsertOf(item.payload),
  };
}

export { evidenceKindLabel } from "./ruleProposalDisplay";

/**
 * Operator-facing copy for a rule-insert outcome on a decided proposal
 * (no em dashes), the learning analogue of kbWriteStatusCopy.
 */
export function ruleInsertStatusCopy(record: RuleInsertRecord | null): {
  tone: "pending" | "ok" | "error";
  text: string;
} {
  if (!record) {
    return {
      tone: "pending",
      text: "No rule was added. Approving this proposal adds the rule to Settings.",
    };
  }
  if (record.status === "inserted") {
    return {
      tone: "ok",
      text: "Rule added to Settings. It applies to every future draft and can be edited or deleted there.",
    };
  }
  return {
    tone: "error",
    text: `Rule not added. ${record.error ?? ""} Reopen and approve again to retry.`.replace(
      /\s+/g,
      " ",
    ),
  };
}
