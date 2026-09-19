"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  COMP_DETAIL_MAX,
  COMP_DETAIL_MIN,
  COMP_KIND_LABELS,
  COMP_KINDS,
  compNeedsDetail,
  compReasonLine,
  isPinShape,
  PIN_MAX,
  PIN_MIN,
  type CompKind,
  type CompReason,
} from "@/lib/comp";
import { OVERRIDE_PURPOSE } from "@/lib/override";

/**
 * T112: the dialog behind Override on the refused-line notice.
 *
 * Pete: "this needs to have the ability to override, like other things in
 * the app. teacher PIN and reason can be given."
 *
 * "Like other things in the app" is the whole specification of this file:
 * it is T79's discount dialog's shape and T48's authorization, not a
 * second way of proving who is at the counter. The reason is a KIND from
 * the stored list with T67's note rule, the PIN goes to
 * /api/teacher/verify exactly as a discount's does, and the token that
 * comes back is the one-shot value the sale hands to /api/checkout. No new
 * reason kind, no PIN stored or logged anywhere, and nothing here decides
 * whether a write reaches Mindbody.
 *
 * Four steps, each statically sized:
 *   reason  -> the kind and its note
 *   pin     -> the teacher's own PIN
 *   ready   -> "Overriding as <name>", and the tap that ATTEMPTS it
 *   refused -> Mindbody's own sentence, and what to do instead
 *
 * The "ready" tap calls /api/override-pass, which asks Mindbody whether
 * the pass prices for this client under this teacher's token. It moves no
 * money and sells nothing: a yes arms the override and the ordinary Pay
 * flow does the selling. A no lands on the refused step, which never
 * implies the teacher did something wrong and never leaves them tapping
 * again for a different answer.
 */

/** The offer this dialog was opened for. */
export interface OverrideTarget {
  /** The refused pass's Service id, as the cart line carries it. */
  metadataId: string;
  name: string;
  /** Mindbody's sentence, word for word, as the notice shows it. */
  refusal: string;
}

/** What the server said the substitute is, priced live. Mirrors
 *  /api/override-pass's answer, which mirrors ResolvedSubstitute. */
export interface SubstituteOffer {
  metadataId: string;
  name: string;
  price: number;
  sellAt: number;
  discount: number;
  taxRate: number | null;
  taxExempt: boolean;
  sentence: string;
}

/** What the dialog hands back when the teacher has authorized something.
 *  `substitute` null is Pete's first outcome (the pass itself, which
 *  Mindbody has just agreed to price under this teacher's token). */
export interface OverrideArmed {
  mode: "attempt" | "substitute";
  reason: CompReason;
  teacher: { id: number; name: string };
  token: string;
  substitute: SubstituteOffer | null;
}

type Step = "reason" | "pin" | "ready" | "refused";

const EMPTY_DRAFT: { kind: CompKind | null; detail: string } = {
  kind: null,
  detail: "",
};

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function OverrideDialog(props: {
  target: OverrideTarget;
  clientId: string | null;
  onCancel: () => void;
  onArmed: (armed: OverrideArmed) => void;
}) {
  const { target, clientId, onCancel, onArmed } = props;
  const [step, setStep] = useState<Step>("reason");
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [pin, setPin] = useState("");
  const pinRef = useRef("");
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const pinBusyRef = useRef(false);
  const [pinShake, setPinShake] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [verified, setVerified] = useState<{
    teacher: { id: number; name: string };
    token: string;
  } | null>(null);
  /** The attempt in flight, and what it answered. */
  const [asking, setAsking] = useState(false);
  const [refusal, setRefusal] = useState<{
    sentence: string;
    advice: string;
    substitute: SubstituteOffer | null;
  } | null>(null);
  /** An error that is not a refusal of the pass: a dead session, a
   *  permission gap, a transport failure. Said as itself. */
  const [attemptError, setAttemptError] = useState<string | null>(null);

  const lockedFor = Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [lockedUntil]);

  const reasonValid =
    draft.kind !== null &&
    draft.detail.trim().length <= COMP_DETAIL_MAX &&
    (!compNeedsDetail(draft.kind) ||
      draft.detail.trim().length >= COMP_DETAIL_MIN);

  const pinTap = useCallback((key: string) => {
    if (pinBusyRef.current) return;
    setPinMsg(null);
    const cur = pinRef.current;
    const next =
      key === "back"
        ? cur.slice(0, -1)
        : cur.length >= PIN_MAX
          ? cur
          : cur + key;
    pinRef.current = next;
    setPin(next);
  }, []);

  const submitPin = useCallback(async () => {
    const digits = pinRef.current;
    if (pinBusyRef.current || !isPinShape(digits)) return;
    pinBusyRef.current = true;
    setPinBusy(true);
    setPinMsg(null);
    try {
      const res = await fetch("/api/teacher/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        /* T94 review: the PURPOSE is signed into the token, so a PIN
         * typed here authorizes an override and nothing else. */
        body: JSON.stringify({ pin: digits, purpose: OVERRIDE_PURPOSE }),
      });
      const body = await res.json().catch(() => ({}));
      pinRef.current = "";
      setPin("");
      if (
        res.ok &&
        body?.ok === true &&
        typeof body?.teacher?.id === "number" &&
        typeof body?.token === "string" &&
        body.token.length > 0
      ) {
        setVerified({
          teacher: {
            id: body.teacher.id,
            name: String(body.teacher.name ?? ""),
          },
          token: body.token,
        });
        setStep("ready");
        return;
      }
      if (res.status === 429) {
        const secs = Number(body?.retryAfterSeconds ?? 30);
        setLockedUntil(Date.now() + (Number.isFinite(secs) ? secs : 30) * 1000);
        setNow(Date.now());
      } else if (res.status === 401) {
        setPinMsg(
          typeof body?.error === "string"
            ? body.error
            : "That is not your PIN.",
        );
        setPinShake((g) => g + 1);
      } else {
        setPinMsg(
          typeof body?.error === "string"
            ? body.error
            : "Could not check that PIN. Try again.",
        );
      }
    } catch {
      pinRef.current = "";
      setPin("");
      setPinMsg("Could not reach the server. Try again.");
    } finally {
      pinBusyRef.current = false;
      setPinBusy(false);
    }
  }, []);

  /* T48: the keyboard stands in for the pad on the PIN step only. */
  useEffect(() => {
    if (step !== "pin") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) pinTap(e.key);
      else if (e.key === "Backspace") pinTap("back");
      else if (e.key === "Enter") void submitPin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, pinTap, submitPin]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !asking) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, asking]);

  /** The ATTEMPT: one explicit tap, one question to Mindbody, no money. */
  const attempt = async () => {
    if (asking || verified === null || draft.kind === null) return;
    setAsking(true);
    setAttemptError(null);
    const reason: CompReason = {
      kind: draft.kind,
      detail: draft.detail.trim(),
    };
    try {
      const res = await fetch("/api/override-pass", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(clientId ? { clientId } : {}),
          override: {
            token: verified.token,
            reason,
            metadataId: target.metadataId,
            pass: target.name,
            refusal: target.refusal,
            mode: "attempt",
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok === true) {
        onArmed({
          mode: "attempt",
          reason,
          teacher: verified.teacher,
          token: verified.token,
          substitute: null,
        });
        return;
      }
      if (res.ok && body?.ok === false && body?.suppressed === true) {
        setAttemptError(
          "This iPad is not writing to Mindbody right now, so the question " +
            "was never asked. Nothing was charged and your PIN was not used.",
        );
        setStep("refused");
        return;
      }
      if (res.ok && body?.ok === false) {
        const sub = body?.substitute;
        setRefusal({
          sentence: String(body?.refusal ?? "Mindbody did not accept it."),
          advice: String(body?.advice ?? ""),
          substitute:
            sub && typeof sub?.metadataId === "string"
              ? {
                  metadataId: sub.metadataId,
                  name: String(sub.name ?? "the substitute pass"),
                  price: Number(sub.price),
                  sellAt: Number(sub.sellAt),
                  discount: Number(sub.discount),
                  taxRate:
                    typeof sub.taxRate === "number" ? sub.taxRate : null,
                  taxExempt: sub.taxExempt === true,
                  sentence: String(sub.sentence ?? ""),
                }
              : null,
        });
        setStep("refused");
        return;
      }
      setAttemptError(
        typeof body?.error === "string"
          ? body.error
          : `Could not ask Mindbody (HTTP ${res.status}).`,
      );
      setStep("refused");
    } catch (err) {
      setAttemptError(
        `Could not reach the server: ${
          err instanceof Error ? err.message : String(err)
        } Nothing was charged and your PIN was not used.`,
      );
      setStep("refused");
    } finally {
      setAsking(false);
    }
  };

  /** Pete's fallback, taken. The same PIN token authorizes it: it was
   *  verified and never spent, and the substitution's discount is what it
   *  is authorizing now. */
  const takeSubstitute = () => {
    const sub = refusal?.substitute;
    if (!sub || verified === null || draft.kind === null) return;
    onArmed({
      mode: "substitute",
      reason: { kind: draft.kind, detail: draft.detail.trim() },
      teacher: verified.teacher,
      token: verified.token,
      substitute: sub,
    });
  };

  const scrimDown = useRef(false);
  return (
    <div
      className="modal-scrim"
      role="presentation"
      onPointerDown={(e) => {
        scrimDown.current = e.target === e.currentTarget;
      }}
      onClick={() => {
        const down = scrimDown.current;
        scrimDown.current = false;
        if (down && !asking) onCancel();
      }}
    >
      <div
        className="modal modal-sale modal-amount modal-reason"
        role="dialog"
        aria-modal="true"
        aria-label={
          step === "pin"
            ? "Who is overriding this?"
            : step === "refused"
              ? "Mindbody refused the pass again"
              : "Override this pass"
        }
        onClick={(e) => e.stopPropagation()}
      >
        {step === "reason" ? (
          <>
            <p className="modal-title">Override this pass</p>
            {/* Mindbody's sentence stays on screen, word for word, the
                way T100 keeps it on the notice: a teacher who does not
                know why it was refused cannot explain it to the person
                at the counter. */}
            <p className="reason-sub">
              {target.name}: {target.refusal}
            </p>
            <p className="reason-note muted-note">
              Overriding asks Mindbody for this pass again under your own
              login. It may refuse again, and it will say why.
            </p>
            <p className="pad-kicker" id="override-reason-label">
              Reason
            </p>
            <div
              className="pad-chips reason-chips"
              role="group"
              aria-labelledby="override-reason-label"
            >
              {COMP_KINDS.map((kind) => (
                <button
                  key={kind}
                  className={draft.kind === kind ? "pad-chip on" : "pad-chip"}
                  aria-pressed={draft.kind === kind}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      kind: d.kind === kind ? null : kind,
                    }))
                  }
                >
                  {COMP_KIND_LABELS[kind]}
                </button>
              ))}
            </div>
            <textarea
              className="reason-input reason-note-field"
              value={draft.detail}
              maxLength={COMP_DETAIL_MAX}
              autoComplete="off"
              rows={1}
              disabled={draft.kind === null}
              placeholder={
                draft.kind === null
                  ? "Choose a reason first"
                  : draft.kind === "trade"
                    ? "What was traded?"
                    : "Add a note"
              }
              aria-label="Note for the override"
              onChange={(e) =>
                setDraft((d) => ({ ...d, detail: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (reasonValid) setStep("pin");
                }
              }}
            />
            <div className="modal-actions">
              <button className="modal-cancel" onClick={onCancel}>
                Cancel
              </button>
              <button
                className="modal-confirm go"
                disabled={!reasonValid}
                title={
                  draft.kind === null
                    ? "Choose a reason"
                    : reasonValid
                      ? "Next: your PIN"
                      : `Write at least ${COMP_DETAIL_MIN} characters`
                }
                onClick={() => setStep("pin")}
              >
                Next
              </button>
            </div>
          </>
        ) : null}

        {step === "pin" ? (
          <>
            <p className="modal-title">Who is overriding this?</p>
            <p className="reason-sub">Enter your PIN.</p>
            <div
              key={`dots-${pinShake}`}
              className={
                pinMsg !== null && lockedFor === 0 && pin === ""
                  ? "lock-dots pin-dots shake"
                  : "lock-dots pin-dots"
              }
              aria-label={`${pin.length} digits entered`}
            >
              {Array.from({ length: PIN_MAX }).map((_, i) => (
                <span
                  key={i}
                  className={i < pin.length ? "lock-dot" : "lock-dot empty"}
                />
              ))}
            </div>
            {lockedFor > 0 ? (
              <p className="lock-msg">
                Too many attempts. Try again in {lockedFor}s.
              </p>
            ) : pinMsg ? (
              <p className="lock-msg">{pinMsg}</p>
            ) : (
              <p className="lock-msg lock-msg-empty" aria-hidden="true">
                &nbsp;
              </p>
            )}
            <div className="pad-keys">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => (
                <button
                  key={k}
                  className="pad-key"
                  disabled={pinBusy || lockedFor > 0}
                  onClick={() => pinTap(k)}
                >
                  {k}
                </button>
              ))}
              <button
                className="pad-key"
                aria-label="Delete last digit"
                disabled={pinBusy || lockedFor > 0}
                onClick={() => pinTap("back")}
              >
                &#9003;
              </button>
              <button
                className="pad-key"
                disabled={pinBusy || lockedFor > 0}
                onClick={() => pinTap("0")}
              >
                0
              </button>
              <span aria-hidden="true" />
            </div>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                disabled={pinBusy}
                onClick={() => {
                  pinRef.current = "";
                  setPin("");
                  setPinMsg(null);
                  setStep("reason");
                }}
              >
                Back
              </button>
              <button
                className="modal-confirm go"
                disabled={pinBusy || lockedFor > 0 || pin.length < PIN_MIN}
                title={
                  pin.length < PIN_MIN
                    ? `Enter ${PIN_MIN} to ${PIN_MAX} digits`
                    : "Check this PIN"
                }
                onClick={() => void submitPin()}
              >
                {pinBusy ? "Checking..." : "Done"}
              </button>
            </div>
          </>
        ) : null}

        {step === "ready" && verified !== null ? (
          <>
            <p className="modal-title">Override this pass</p>
            <p className="reason-who">Overriding as {verified.teacher.name}</p>
            <p className="reason-note">
              {target.name}: {target.refusal}
            </p>
            <p className="reason-note">
              {compReasonLine({
                kind: draft.kind ?? "other",
                detail: draft.detail.trim(),
              })}
            </p>
            <p className="reason-note muted-note">
              This asks Mindbody only. Nothing is charged until you take a
              payment.
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                disabled={asking}
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                className="modal-confirm go"
                disabled={asking}
                onClick={() => void attempt()}
              >
                {asking ? "Asking Mindbody..." : "Ask Mindbody"}
              </button>
            </div>
          </>
        ) : null}

        {step === "refused" ? (
          <>
            <p className="modal-title">Mindbody refused it again</p>
            {attemptError !== null ? (
              <p className="reason-sub">{attemptError}</p>
            ) : (
              <>
                {/* Mindbody's own words, first and unedited. */}
                <p className="reason-sub">{refusal?.sentence}</p>
                <p className="reason-note">{refusal?.advice}</p>
              </>
            )}
            {refusal?.substitute ? (
              <>
                <p className="reason-note">{refusal.substitute.sentence}</p>
                <div className="modal-actions">
                  <button className="modal-cancel" onClick={onCancel}>
                    Close
                  </button>
                  <button className="modal-confirm go" onClick={takeSubstitute}>
                    Sell {refusal.substitute.name} at{" "}
                    {money(refusal.substitute.sellAt)}
                  </button>
                </div>
              </>
            ) : (
              <div className="modal-actions">
                <button className="modal-confirm go" onClick={onCancel}>
                  Close
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
