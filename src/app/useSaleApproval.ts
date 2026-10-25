"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { TicketPayload } from "@/lib/displayticket";

/**
 * T203's approval, in ONE place (T209).
 *
 * The rule the studio asked for is "the customer approves each sale",
 * and `/api/checkout` enforces it on EVERY charge. T203 wired the asking
 * half into the Cart screen alone, so the roster's "Pay and check in"
 * tap -- a second, older path to the same route -- reached the server
 * with no approval, was refused in words ("The customer has not approved
 * this sale on the customer screen"), and no scene ever appeared on the
 * student's iPad (Pete, third sandbox drive, 2026-09-21). Two charge
 * paths, one precondition, one of them wired: the fix is not a second
 * copy of the flow but the flow lifted out of the sale screen into this
 * hook, which both screens call.
 *
 * What it owns, and nothing else:
 *
 * - presenting the priced ticket as a `ticket`/`approve` request
 *   (`POST /api/display/present`), with the CART the server hashes
 *   beside it. The browser never sends a hash: a promise that the ticket
 *   has not changed, made by the thing that changes it, is not a
 *   promise (T203, `src/lib/cartsha.ts`);
 * - the wait -- a 1 second poll of `/api/display/approval`, which
 *   survives a dropped stream, a sleep and a reload;
 * - the three ways that wait can end without the customer's tap: a busy
 *   screen (Wait, Take over), a screen that is not there, and the D1
 *   PIN override;
 * - handing the charge either the approval's id or the PIN's token.
 *
 * What it deliberately does NOT own: the charge. The caller passes its
 * own, unchanged, and this only decides WHEN it runs and WHAT
 * authorization rides on it. Nothing here calls Mindbody, and nothing
 * here decides whether a write reaches it: the setting is enforced on
 * the server, on every charge, whatever this browser believes.
 */

/**
 * Where the customer's approval has got to. Null is "not asked for, or
 * nothing outstanding".
 *
 *   waiting  -- the ticket is on the customer screen
 *   busy     -- something else holds that screen (the design's three-way
 *               choice: Wait, Take over, Approve sale)
 *   offline  -- no screen to ask on, so the PIN is the way forward
 *   pin      -- the D1 override dialog is open
 */
export type ApprovalState =
  | { stage: "waiting"; requestId: string }
  /* T204: `signup` means a STUDENT is signing themselves up on that
   *  screen, which is the one case the wording names and Take over
   *  interrupts a person rather than a scene. */
  | { stage: "busy"; signup?: boolean }
  | { stage: "offline" }
  /* T209 review: the server refused the present for a reason that is
   *  NOT the screen's state, and said why. Its own sentence is what the
   *  teacher reads, because "The customer screen is not connected." over
   *  a connected screen is a lie that costs them the next two minutes. */
  | { stage: "refused"; error: string }
  /* `resume` is the request the PIN pad was opened OVER, when it was
   *  opened from a live wait. Cancelling the pad goes back to it: the
   *  ticket is still on the student's screen, so the panel and the poll
   *  have to come back or their tap lands on nothing (T209 review). */
  | { stage: "pin"; because: string; resume?: { requestId: string } };

/** What the approval hands the charge: the display request's id, or the
 *  PIN token that stood in for it. Exactly one, and only when the
 *  setting is on; the route ignores both when it is off. */
export interface ApprovalRide {
  id?: string;
  token?: string;
}

/** The ticket as it is asked about: what the STUDENT reads, and the cart
 *  the SERVER hashes. Null means there is nothing to ask about yet. */
export interface ApprovalTicket {
  payload: TicketPayload;
  /** The same `items`/`giftCards`/`discount`/`clientId` shape the
   *  browser sends to /api/price-cart and /api/checkout. */
  cart: unknown;
}

export interface SaleApproval {
  approval: ApprovalState | null;
  /** The quiet sentence left behind when an approval ended without a
   *  charge ("Customer cancelled"). The ticket stays as built. */
  note: string | null;
  /** Whether the teacher chose "Wait" on a busy screen, so the present
   *  is retried until it goes through. */
  waitingForScreen: boolean;
  /** The primary tap. With the setting off this is the charge and
   *  nothing else; with it on the ticket goes up and the charge follows
   *  the customer's own tap. */
  begin: () => void;
  /** The panel's Cancel: the ticket stays exactly as built. Takes no
   *  argument, deliberately, because it is handed straight to an
   *  onClick and a MouseEvent must not arrive as a note. */
  cancel: () => void;
  /**
   * T209 review: end an outstanding approval because the TICKET moved
   * under it, leaving the teacher one sentence. The scene comes off the
   * student's screen at the moment of the edit, which is what makes
   * "an outstanding approval goes with the tender" literally true: the
   * alternative, found in review, was a customer tapping Approve on a
   * ticket whose charge could no longer run, with no sentence anywhere.
   * A no-op when nothing is outstanding.
   */
  abandon: (note: string) => void;
  /** The design's "Wait": keep asking for a busy screen. */
  keepWaiting: () => void;
  /** The design's "Take over". */
  takeOver: () => void;
  /** "Approve sale": open the D1 PIN dialog. */
  toPin: () => void;
  /** The PIN dialog's Cancel. */
  closePin: () => void;
  /** A PIN was accepted: charge on its one-shot token. */
  armed: (token: string) => void;
  /** Drop everything outstanding (a new ticket, a finished sale), and
   *  take the scene off the student's screen with it. */
  reset: () => void;
}

export function useSaleApproval(input: {
  /** `customer_confirms_sale`, as /api/config reported it. It decides
   *  what this DRAWS; the server reads the setting itself on every
   *  charge, so a stale copy can cost a teacher a refusal and can never
   *  cost a student an unapproved charge. */
  on: boolean;
  /** The ticket to ask about, built fresh at the moment of the ask. */
  build: () => ApprovalTicket | null;
  /** The caller's own charge, unchanged. */
  charge: (approved?: ApprovalRide) => void;
  /**
   * T209 review: what the charge path already does when Mindbody stops
   * honouring the teacher's token (T50). `/api/display/present` sits
   * behind the same `requireActor` and answers the same 401
   * `reason: "staff"`, so a present refused that way is a sign-in gone,
   * not a screen gone, and it must read as one.
   */
  onStaffSessionEnded?: () => void;
}): SaleApproval {
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [waitingForScreen, setWaitingForScreen] = useState(false);

  /* The three inputs are read through refs, updated in the render body,
   * for two separate reasons. The charge and the builder are rebuilt
   * every render and must NOT be effect dependencies: the wait is keyed
   * by the request id, and re-running the poll per render would restart
   * it on every keystroke elsewhere on the screen. The setting is read
   * at the moment of the tap. */
  const onRef = useRef(input.on);
  onRef.current = input.on;
  const buildRef = useRef(input.build);
  buildRef.current = input.build;
  const chargeRef = useRef(input.charge);
  chargeRef.current = input.charge;
  const staffGoneRef = useRef(input.onStaffSessionEnded);
  staffGoneRef.current = input.onStaffSessionEnded;
  /**
   * T209 review: which attempt is the live one.
   *
   * Two things here run across an await and could land after the
   * teacher has moved on: `present`, whose request EXISTS on the server
   * by the time its answer arrives, and Take over, which deliberately
   * waits three seconds for the display's apology before it presents.
   * Cancel during either used to be ignored, so Cancel on the apology
   * put the ticket up anyway. Everything that ends or restarts the flow
   * bumps this, and both of those check it before they touch state; a
   * present whose generation has gone takes its own scene back down
   * rather than stranding it.
   */
  const gen = useRef(0);
  /** Synchronous mirror of `approval`, so a tap reads this render's
   *  truth rather than the render the handler was built in. */
  const approvalRef = useRef<ApprovalState | null>(approval);
  approvalRef.current = approval;

  /**
   * Put the priced ticket on the customer screen and wait for the tap.
   *
   * Nothing is charged here. The server records the cart's sha256 on the
   * request's own server-side half and /api/checkout compares it to the
   * cart it is about to charge, so this is a question, not a promise.
   * A screen that is busy, dark or unpaired lands on the three-way
   * choice the design gives (Wait, Take over, Approve sale); none of
   * them is a way past the setting, because the only two things that
   * satisfy it are the customer's own tap and a teacher's PIN.
   */
  const present = useCallback(async (): Promise<void> => {
    const ticket = buildRef.current();
    if (ticket === null) {
      /* Nothing to ask about (no client, no line, no price yet). There
       * is no screen state that says so, and the teacher has not been
       * told a lie: the primary tap simply did nothing. */
      return;
    }
    const mine = gen.current;
    const payload = ticket.payload;
    try {
      const res = await fetch("/api/display/present", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "ticket",
          payload,
          ...(payload.clientFirstName
            ? { clientFirstName: payload.clientFirstName }
            : {}),
          /* The cart the server hashes. It never reaches the display:
             the hash and the client id live on the request's private
             half, which the student's screen never sees. */
          cart: ticket.cart,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && typeof body?.requestId === "string") {
        if (gen.current !== mine) {
          /* The teacher cancelled (or the ticket changed) while this was
             in flight, and the scene now EXISTS on the server. Take it
             back down rather than leaving a student holding a ticket
             nobody is waiting on. */
          void fetch("/api/display/cancel", { method: "POST" });
          return;
        }
        setApproval({ stage: "waiting", requestId: body.requestId });
        return;
      }
      if (gen.current !== mine) return;
      if (body?.reason === "busy") {
        setApproval({
          stage: "busy",
          ...(body?.holdingSignup === true ? { signup: true } : {}),
        });
        return;
      }
      /**
       * T209 review: WHY it was refused decides what the teacher reads.
       *
       * - 401 `reason: "staff"` is the sign-in gone (T50), which the
       *   charge path already reports up. The panel goes away and the
       *   gate comes back; a sentence about the customer screen here
       *   would send a teacher to look at the wrong iPad. (The app's
       *   own 401 chokepoint in page.tsx sees this answer too and
       *   raises the gate; this is the same handling the charge path
       *   does explicitly, not a second mechanism.)
       * - 409 is `presentRequest`'s own answer about the SCREEN:
       *   unpaired, disconnected, or busy (handled above). That really
       *   is "not connected", and the PIN is the way forward.
       * - a 5xx, or anything with no sentence in it, says nothing this
       *   screen can pass on, so it falls back to the same line.
       * - everything else (a 400 from the payload check, a 403, a 502
       *   with a body) has a sentence of the SERVER's, and that is what
       *   the panel shows. Approve sale is offered either way: the
       *   teacher is never trapped by a refusal they cannot read.
       */
      if (res.status === 401 && body?.reason === "staff") {
        setApproval(null);
        setNote(null);
        staffGoneRef.current?.();
        return;
      }
      const sentence =
        typeof body?.error === "string" && body.error.trim().length > 0
          ? body.error.trim()
          : null;
      if (res.status === 409 || res.status >= 500 || sentence === null) {
        setApproval({ stage: "offline" });
        return;
      }
      setApproval({ stage: "refused", error: sentence });
    } catch {
      /* The request never reached the server, so nothing was presented
         and there is nothing to take down. */
      if (gen.current === mine) setApproval({ stage: "offline" });
    }
  }, []);

  /**
   * While the ticket is on the customer screen, ask how it went.
   *
   * A poll rather than the teacher's SSE stream, deliberately: this runs
   * for the few seconds of one approval, it survives a stream that was
   * dropped or never opened, and the answer it needs is one boolean. The
   * moment the customer approves, the charge goes out with the
   * approval's id and no further tap, which is the design's promise.
   * A refusal, a cancel and a screen that went dark all close the wait
   * with a plain sentence and leave the ticket exactly as built.
   */
  useEffect(() => {
    if (approval?.stage !== "waiting") return;
    const requestId = approval.requestId;
    let stopped = false;
    const finish = (line: string | null) => {
      stopped = true;
      setApproval(null);
      setNote(line);
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(
          `/api/display/approval?requestId=${encodeURIComponent(requestId)}`,
        );
        const body = await res.json().catch(() => null);
        if (stopped || body === null) return;
        if (body.status === "completed" && body.approved === true) {
          stopped = true;
          setApproval(null);
          setNote(null);
          chargeRef.current({ id: requestId });
          return;
        }
        if (body.status === "refused") {
          finish("Customer cancelled");
          return;
        }
        if (body.status === "cancelled" || body.status === "unknown") {
          finish("Customer screen disconnected");
          return;
        }
        if (body.connected === false) finish("Customer screen disconnected");
      } catch {
        /* One missed poll is not an answer; the next one asks again. */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [approval]);

  /** The design's "Wait": keep asking for the screen until it is free,
   *  or until the teacher cancels. */
  useEffect(() => {
    if (approval?.stage !== "busy" || !waitingForScreen) return;
    const timer = setInterval(() => void present(), 2_000);
    return () => clearInterval(timer);
  }, [approval, waitingForScreen, present]);

  /**
   * The primary tap, when the studio asks the customer first.
   *
   * With the setting off this is the caller's charge and nothing else,
   * which is today's behaviour unchanged. With it on, the first tap
   * presents the ticket for approval and the charge follows the
   * customer's own tap; nothing auto-charges, and the server refuses a
   * charge that carries no approval whatever this browser believes.
   */
  const begin = useCallback(() => {
    if (!onRef.current) {
      chargeRef.current();
      return;
    }
    if (approvalRef.current !== null) return;
    setNote(null);
    setWaitingForScreen(false);
    gen.current += 1;
    void present();
  }, [present]);

  /**
   * End whatever is outstanding, leaving `line` behind (null for the
   * teacher's own Cancel, a sentence when the ticket moved under it).
   *
   * The scene comes off the student's screen whenever one is up, which
   * includes the PIN pad opened OVER a live wait: the ticket is still
   * on their iPad while that pad is open. A no-op when nothing is
   * outstanding, which is what keeps it away from the post-sale summary
   * (the approval is already spent and null by the time the charge that
   * raises the summary returns).
   */
  const endWait = useCallback((line: string | null) => {
    const held = approvalRef.current;
    if (held === null) return;
    gen.current += 1;
    setWaitingForScreen(false);
    setApproval(null);
    setNote(line);
    const sceneUp =
      held.stage === "waiting" ||
      (held.stage === "pin" && held.resume !== undefined);
    if (sceneUp) void fetch("/api/display/cancel", { method: "POST" });
  }, []);

  /* Handed straight to an onClick, so it takes no argument: a
     MouseEvent must never arrive where a note is expected. */
  const cancel = useCallback(() => endWait(null), [endWait]);
  const abandon = useCallback(
    (note: string) => endWait(note),
    [endWait],
  );

  const keepWaiting = useCallback(() => setWaitingForScreen(true), []);

  const takeOver = useCallback(() => {
    /* Take over: the screen apologises for a few seconds before the
       ticket goes up, so the student it interrupted is not simply
       replaced by somebody else's sale. */
    setWaitingForScreen(false);
    gen.current += 1;
    const mine = gen.current;
    void (async () => {
      await fetch("/api/display/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ takenOver: true }),
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 3_000));
      /* T209 review: Cancel during the apology means no ticket goes up.
         Three seconds is long enough to change your mind in, and a
         teacher who cancels and watches the ticket appear anyway has
         been told the control does not work. */
      if (gen.current !== mine) return;
      await present();
    })();
  }, [present]);

  const toPin = useCallback(() => {
    const held = approvalRef.current;
    setWaitingForScreen(false);
    setApproval({
      stage: "pin",
      because:
        held?.stage === "offline"
          ? "The customer screen is not connected."
          : held?.stage === "refused"
            ? held.error
            : held?.stage === "busy"
              ? held.signup === true
                ? "Someone was signing up on the customer screen."
                : "The customer screen is busy."
              : "The customer has not approved on the screen.",
      /* T209 review: opened over a live wait, so cancelling the pad can
         put the wait back rather than stranding the ticket. Nothing is
         cancelled here: the student's screen is untouched by a teacher
         reaching for the keypad. */
      ...(held?.stage === "waiting"
        ? { resume: { requestId: held.requestId } }
        : {}),
    });
  }, []);

  /**
   * T209 review: cancelling the PIN pad is not cancelling the sale.
   *
   * Opened over a live wait, the ticket is still on the student's
   * screen, so this goes back to that wait: the panel returns, the poll
   * resumes from the same request id, and their Approve still charges
   * once. Opened over anything else there was nothing to go back to.
   * Nothing is charged and nothing is cancelled either way.
   */
  const closePin = useCallback(() => {
    const held = approvalRef.current;
    setApproval(
      held?.stage === "pin" && held.resume !== undefined
        ? { stage: "waiting", requestId: held.resume.requestId }
        : null,
    );
  }, []);

  const armed = useCallback((token: string) => {
    setApproval(null);
    setNote(null);
    /* The screen is no longer being waited on; the route cancels a
       pending approval of its own when it takes the PIN. */
    chargeRef.current({ token });
  }, []);

  const reset = useCallback(() => endWait(null), [endWait]);

  return {
    approval,
    note,
    waitingForScreen,
    begin,
    cancel,
    abandon,
    keepWaiting,
    takeOver,
    toPin,
    closePin,
    armed,
    reset,
  };
}
