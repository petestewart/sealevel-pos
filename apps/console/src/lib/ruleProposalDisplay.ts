import type { RuleEvidence } from "@ai-manager/core";

/**
 * Client-safe display helpers for rule_proposal items (the learning
 * loop's approval cards), split out of ruleProposalView.ts on the
 * signoffPreview.ts pattern: this module imports ONLY types from
 * @ai-manager/core, so a "use client" component can import it without
 * webpack chasing the core barrel into pg/bullmq/ioredis (Node built-ins
 * that cannot resolve in a browser bundle and fail the console build).
 * ruleProposalView.ts re-exports these, so server-side importers are
 * unchanged.
 */

/** Short operator-facing label for one evidence signal kind. */
export function evidenceKindLabel(kind: RuleEvidence["kind"]): string {
  switch (kind) {
    case "edit":
      return "Edited before approval";
    case "revision":
      return "Redo requested";
    case "rejection":
      return "Rejected";
    case "no_reply":
      return "Marked no reply";
    case "spam":
      return "Confirmed spam";
    case "trash":
      return "Trashed";
  }
}
