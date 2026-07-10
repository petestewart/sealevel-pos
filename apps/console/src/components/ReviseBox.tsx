"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { INSTRUCTION_MAX_LENGTH } from "../lib/reviseLimits";
import {
  pollReviseAction,
  redoDraftAction,
  submitReviseInstructionAction,
  type RevisePollResult,
  type ReviseSnapshot,
  type ReviseSubmitResult,
} from "../app/approvals/reviseActions";

/**
 * "Ask the AI" box on the pending detail pane (A3b, GH-37): the operator
 * types a one-shot instruction ("shorten this") or question ("what class
 * is she asking about?"), the server enqueues item.revise, and this
 * component polls until the item payload changes (docs/item-revise.md).
 * A revision refreshes the pane (new draft + rationale + history); an
 * answer renders inline here without touching the draft. Redo draft
 * enqueues a from-scratch rewrite through the same path.
 *
 * Polling is bounded: ~1.5s ticks, a "still working" note after ~30s,
 * and a give-up message after ~2 minutes so a stopped worker never
 * leaves the box hanging forever.
 */

const POLL_INTERVAL_MS = 1500;
const POLL_SLOW_AFTER = 20; // ~30s: reassure, keep waiting
const POLL_MAX_ATTEMPTS = 80; // ~2 minutes: give up with guidance

const TIMEOUT_MESSAGE =
  "No result after 2 minutes. The worker may not be running; check it and try again.";

export interface LastAnswerData {
  question: string;
  answer: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "working"; label: string; slow: boolean }
  | { kind: "done"; note: string }
  | { kind: "error"; message: string };

export function ReviseBox({
  itemId,
  lastAnswer,
}: {
  itemId: string;
  /** Stored payload.last_answer, shown as the inline note (server data). */
  lastAnswer: LastAnswerData | null;
}) {
  const router = useRouter();
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Fresh answer from a just-finished poll, shown until the server
  // re-render delivers the same thing through the lastAnswer prop.
  const [freshAnswer, setFreshAnswer] = useState<LastAnswerData | null>(null);
  // Monotonic run token: a stale polling loop (unmounted component or a
  // superseded run) sees a mismatch and stops touching state.
  const runToken = useRef(0);
  useEffect(() => {
    return () => {
      runToken.current += 1;
    };
  }, []);

  const working = phase.kind === "working";

  async function poll(
    jobId: string,
    snapshot: ReviseSnapshot,
    question: string,
    token: number,
    label: string,
  ): Promise<void> {
    for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (runToken.current !== token) return;

      let result: RevisePollResult;
      try {
        result = await pollReviseAction(itemId, jobId, snapshot);
      } catch {
        continue; // transient poll failure: keep trying within the budget
      }
      if (runToken.current !== token) return;

      switch (result.status) {
        case "working":
          if (attempt >= POLL_SLOW_AFTER) {
            setPhase({ kind: "working", label, slow: true });
          }
          continue;
        case "revised":
          // A revision clears payload.last_answer server-side; drop the
          // locally-cached answer too so a stale Q&A doesn't linger.
          setFreshAnswer(null);
          setPhase({ kind: "done", note: "Draft updated." });
          setInstruction("");
          router.refresh();
          return;
        case "answered":
          setFreshAnswer({ question, answer: result.answer });
          setPhase({ kind: "done", note: "Answered below. Draft unchanged." });
          setInstruction("");
          router.refresh();
          return;
        case "noop":
          setPhase({
            kind: "error",
            message:
              "The AI made no changes for that instruction. Try rewording it.",
          });
          return;
        case "failed":
          setPhase({ kind: "error", message: result.error });
          return;
      }
    }
    if (runToken.current === token) {
      setPhase({ kind: "error", message: TIMEOUT_MESSAGE });
    }
  }

  function start(
    submit: () => Promise<ReviseSubmitResult>,
    question: string,
    label: string,
  ) {
    const token = ++runToken.current;
    setPhase({ kind: "working", label, slow: false });
    void (async () => {
      let result: ReviseSubmitResult;
      try {
        result = await submit();
      } catch {
        if (runToken.current === token) {
          setPhase({
            kind: "error",
            message: "Could not submit the request. Try again.",
          });
        }
        return;
      }
      if (runToken.current !== token) return;
      if (!result.ok) {
        setPhase({ kind: "error", message: result.error });
        return;
      }
      await poll(result.jobId, result.snapshot, question, token, label);
    })();
  }

  const trimmed = instruction.trim();
  const answer = freshAnswer ?? lastAnswer;

  return (
    <div className="revise-box">
      <label className="micro-label revise-label" htmlFor={`revise-${itemId}`}>
        Ask the AI
      </label>
      <div className="revise-hint">
        Revise the draft or ask a question about this email.
      </div>
      <textarea
        id={`revise-${itemId}`}
        className="revise-input"
        placeholder={'Try "shorten this" or "what class is she asking about?"'}
        value={instruction}
        maxLength={INSTRUCTION_MAX_LENGTH}
        disabled={working}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && trimmed && !working) {
            e.preventDefault();
            start(
              () => submitReviseInstructionAction(itemId, trimmed),
              trimmed,
              "Working on it",
            );
          }
        }}
      />
      <div className="revise-actions">
        <Button
          type="button"
          variant="outlined"
          disabled={working || trimmed.length === 0}
          onClick={(e) => {
            e.preventDefault();
            start(
              () => submitReviseInstructionAction(itemId, trimmed),
              trimmed,
              "Working on it",
            );
          }}
        >
          Send to AI
        </Button>
        <Button
          type="button"
          variant="outlined"
          disabled={working}
          onClick={(e) => {
            e.preventDefault();
            start(
              () => redoDraftAction(itemId),
              "Redo the draft from scratch",
              "Redoing the draft from scratch",
            );
          }}
        >
          Redo draft
        </Button>
        {trimmed.length > 0 ? (
          <span className="revise-count">
            {trimmed.length}/{INSTRUCTION_MAX_LENGTH}
          </span>
        ) : null}
      </div>

      {phase.kind === "working" ? (
        <div className="revise-status" role="status">
          <span className="revise-spinner" aria-hidden="true" />
          {phase.label}...
          {phase.slow ? " Still working. This can take a minute." : ""}
        </div>
      ) : null}
      {phase.kind === "done" ? (
        <div className="revise-status revise-status--done" role="status">
          {phase.note}
        </div>
      ) : null}
      {phase.kind === "error" ? (
        <div className="revise-status revise-status--error" role="alert">
          {phase.message}
        </div>
      ) : null}

      {answer ? (
        <div className="revise-answer">
          <div className="revise-answer-q">{answer.question}</div>
          <div className="revise-answer-a">{answer.answer}</div>
        </div>
      ) : null}
    </div>
  );
}
