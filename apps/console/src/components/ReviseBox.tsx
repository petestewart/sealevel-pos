"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
  redoSignal = 0,
  onWorkingChange,
}: {
  itemId: string;
  /** Stored payload.last_answer, shown as the inline note (server data). */
  lastAnswer: LastAnswerData | null;
  /**
   * Monotonic counter from the parent card's "Redo draft" icon (which
   * lives next to the draft header, not in this box). Each increment
   * triggers one redo run; 0 means never pressed.
   */
  redoSignal?: number;
  /** Lets the parent disable its redo icon while a run is in flight. */
  onWorkingChange?: (working: boolean) => void;
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

  useEffect(() => {
    onWorkingChange?.(working);
    // On unmount (e.g. entering edit mode mid-run), clear the parent's
    // mirror so it can't stick true while this box is gone.
    return () => onWorkingChange?.(false);
  }, [working, onWorkingChange]);

  // Synchronous double-submit guard: state-based `working` only flips
  // after a re-render, so key auto-repeat (held Enter fires keydown every
  // ~30ms) could enqueue duplicate server actions before the textarea
  // disables. This ref flips in the same tick as the first submit.
  const submitting = useRef(false);
  // ORDER MATTERS: this reset effect must stay declared BEFORE the queued-
  // redo effect below. When a run ends, this clears the guard first so the
  // redo effect (re-running on the same phase change) can drain a queued
  // press instead of reading a stale submitting=true and dropping it.
  useEffect(() => {
    if (!working) submitting.current = false;
  }, [working]);

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

  function submitInstruction() {
    if (submitting.current) return;
    submitting.current = true;
    start(
      () => submitReviseInstructionAction(itemId, trimmed),
      trimmed,
      "Working on it",
    );
  }

  // The parent's redo icon increments redoSignal; run once per increment.
  // The seen ref ignores the initial value (including a remount while a
  // signal is outstanding). A press landing in the one-paint gap where a
  // run just started but the parent's disabled mirror hasn't caught up is
  // NOT consumed here -- phase.kind in the deps re-runs the effect when
  // the run finishes and the queued press executes then, instead of being
  // silently dropped.
  const seenRedoSignal = useRef(redoSignal);
  useEffect(() => {
    if (redoSignal === seenRedoSignal.current) return;
    if (phase.kind === "working" || submitting.current) return;
    seenRedoSignal.current = redoSignal;
    submitting.current = true;
    start(
      () => redoDraftAction(itemId),
      "Redo the draft from scratch",
      "Redoing the draft from scratch",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redoSignal, phase.kind]);

  return (
    <div className="revise-box">
      <label className="micro-label revise-label" htmlFor={`revise-${itemId}`}>
        Ask the AI
      </label>
      <div className="revise-hint">
        Revise the draft or ask a question about this email.
      </div>
      <div className="revise-inputwrap">
        <textarea
          id={`revise-${itemId}`}
          className="revise-input"
          placeholder={'Try "shorten this" or "what class is she asking about?"'}
          value={instruction}
          maxLength={INSTRUCTION_MAX_LENGTH}
          disabled={working}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter inserts a newline. Ignore Enter
            // during IME composition (isComposing, plus keyCode 229 for
            // engines that clear the flag before the commit keystroke).
            if (e.key !== "Enter" || e.shiftKey) return;
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
              return;
            e.preventDefault();
            if (trimmed && !working) submitInstruction();
          }}
        />
        <button
          type="button"
          className="revise-send"
          disabled={working || trimmed.length === 0}
          aria-label="Send to AI"
          title="Send to AI"
          onClick={(e) => {
            e.preventDefault();
            submitInstruction();
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {trimmed.length > 0 ? (
        <div className="revise-actions">
          <span className="revise-count">
            {trimmed.length}/{INSTRUCTION_MAX_LENGTH}
          </span>
        </div>
      ) : null}

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
