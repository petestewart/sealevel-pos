"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { TicketPayload } from "@/lib/displayticket";

import { cancelOnDisplay, presenterId } from "./presenter";

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
  | {
      stage: "busy";
      signup?: boolean;
      /** T241 third review: what holds the screen is ANOTHER iPad's
       *  approval, which Take over may not take. */
      foreignApproval?: boolean;
    }
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
  /**
   * T240: whether an approval is outstanding IN ANY FORM, including the
   * round trip between the primary tap and the present's request id
   * coming back (and Take over's apology), when `approval` is still
   * null. The approval names the tender, so a screen locks its tender
   * controls on THIS, not on `approval`: T238's review found the roster
   * dialog's "Use the card instead" live for exactly that round trip.
   */
  pending: boolean;
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
  /**
   * T241: the student picked another way to pay on the approval, and the
   * tender has moved; ask them again with the new one. The approve
   * ticket on the screen is REPLACED in place (same request id, the
   * wait carries on), so the screen does not blink to idle. It NEVER
   * charges, and it does nothing at all with the setting off or with no
   * approval outstanding.
   */
  askAgain: () => void;
  /** T241: the request id of the approval this screen is waiting on (or
   *  that its PIN pad was opened over), or null. */
  requestId: () => string | null;
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
  /** T241: a pick the approval poll's answer carried, handed to the
   *  screen's `useTenderPick`, which acts on each pick once. */
  onPick?: (value: unknown) => void;
  /** T241: a presented approval was taken back down (`requestId`), so a
   *  card the student typed on it is let go of by the server and the
   *  screen can say so. */
  onSceneCancelled?: (requestId: string) => void;
}): SaleApproval {
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [waitingForScreen, setWaitingForScreen] = useState(false);
  /** T240: a present (or Take over's apology before one) is in flight,
   *  so the approval is begun though `approval` is still null. The ref
   *  is what a tap reads, synchronously; the state is what draws. */
  const [presenting, setPresenting] = useState(false);
  const presentingRef = useRef(false);
  const setPresentingBoth = useCallback((on: boolean) => {
    presentingRef.current = on;
    setPresenting(on);
  }, []);

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
  const onPickRef = useRef(input.onPick);
  onPickRef.current = input.onPick;
  const sceneGoneRef = useRef(input.onSceneCancelled);
  sceneGoneRef.current = input.onSceneCancelled;
  /** T241: the cancel last sent for a scene this hook took down. A
   *  present waits for it, so a cancel and the present after it cannot
   *  arrive the other way round and leave the new ticket refused "busy"
   *  behind the old one. */
  const lastCancel = useRef<Promise<unknown> | null>(null);
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
  const present = useCallback(async (replaces?: string): Promise<void> => {
    const ticket = buildRef.current();
    if (ticket === null) {
      /* Nothing to ask about (no client, no line, no price yet). There
       * is no screen state that says so, and the teacher has not been
       * told a lie: the primary tap simply did nothing. (Take over sets
       * `presenting` before it gets here, so it is cleared here too.) */
      setPresentingBoth(false);
      return;
    }
    const mine = gen.current;
    const payload = ticket.payload;
    /* T240: begun, though not yet answered. Cleared below once this
     * attempt resolves, if it is still the live one; an attempt that
     * was ended under it was cleared by whatever ended it. */
    setPresentingBoth(true);
    const settle = () => {
      if (gen.current === mine) setPresentingBoth(false);
    };
    /* T240 review: the approval lands in the ref in the same tick the
     * presenting flag clears, so a tap in the gap before the next render
     * cannot pass begin()'s guard and present the ticket a second time
     * (which the hub would answer busy, over the teacher's own ticket). */
    const land = (next: ApprovalState | null) => {
      approvalRef.current = next;
      setApproval(next);
    };
    try {
      if (lastCancel.current !== null) {
        await lastCancel.current.catch(() => undefined);
      }
      const res = await fetch("/api/display/present", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "ticket",
          /* T241: an approval asked again after a pick replaces its own
             ticket in place. */
          ...(replaces !== undefined ? { replaces } : {}),
          /* T241 review: this tab, which the hub binds the ticket to. */
          presenter: presenterId(),
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
          void cancelOnDisplay();
          return;
        }
        settle();
        land({ stage: "waiting", requestId: body.requestId });
        return;
      }
      if (gen.current !== mine) return;
      settle();
      /* T241 second review (E): an approval asked again in place had
       * already ended (the student cancelled, or it went). Nothing is put
       * up in its place; the teacher reads why and Finalizes again. */
      if (body?.reason === "gone") {
        land(null);
        setNote(
          typeof body?.error === "string"
            ? body.error
            : "The approval ended. Finalize again to ask the customer.",
        );
        return;
      }
      if (body?.reason === "busy") {
        land({
          stage: "busy",
          ...(body?.holdingSignup === true ? { signup: true } : {}),
          ...(body?.foreignApproval === true ? { foreignApproval: true } : {}),
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
        land(null);
        setNote(null);
        staffGoneRef.current?.();
        return;
      }
      const sentence =
        typeof body?.error === "string" && body.error.trim().length > 0
          ? body.error.trim()
          : null;
      if (res.status === 409 || res.status >= 500 || sentence === null) {
        land({ stage: "offline" });
        return;
      }
      land({ stage: "refused", error: sentence });
    } catch {
      /* The request never reached the server, so nothing was presented
         and there is nothing to take down. */
      if (gen.current === mine) {
        settle();
        land({ stage: "offline" });
      }
    }
  }, [setPresentingBoth]);

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
      approvalRef.current = null;
      setApproval(null);
      setNote(line);
      /* T241 review: the scene is over (the customer cancelled, or it
       * went), and a card the student typed on it went with it on the
       * server; the screen lets go of its line too. */
      sceneGoneRef.current?.(requestId);
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(
          `/api/display/approval?requestId=${encodeURIComponent(requestId)}`,
        );
        const body = await res.json().catch(() => null);
        if (stopped || body === null) return;
        /* T241: a pick rides the same answer, so a dropped stream does
         * not lose the student's choice. Acted on once, by its id. */
        if (body.pick && body.status === "pending") onPickRef.current?.(body.pick);
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
    if (approvalRef.current !== null || presentingRef.current) return;
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
    /* T240: a present still in flight is outstanding too. Bumping the
     * generation is what makes it take its own scene back down when its
     * answer arrives, so the student never holds a ticket for a tender
     * the teacher has already changed. */
    const inFlight = presentingRef.current;
    if (held === null && !inFlight) return;
    gen.current += 1;
    setPresentingBoth(false);
    setWaitingForScreen(false);
    setApproval(null);
    /* Synchronously too: two effects in one commit can each end the
     * wait (a cart edit and the tender it clears), and the second must
     * find nothing outstanding rather than cancel twice and overwrite
     * the first one's sentence. */
    approvalRef.current = null;
    setNote(line);
    if (held === null) return;
    const sceneUp =
      held.stage === "waiting" ||
      (held.stage === "pin" && held.resume !== undefined);
    if (sceneUp) {
      lastCancel.current = cancelOnDisplay();
      const gone =
        held.stage === "waiting"
          ? held.requestId
          : held.stage === "pin"
            ? held.resume?.requestId
            : undefined;
      if (gone !== undefined) sceneGoneRef.current?.(gone);
    }
  }, [setPresentingBoth]);

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
    /* T240: the apology is part of the ask; the tender stays locked. */
    setPresentingBoth(true);
    void (async () => {
      await cancelOnDisplay({ takenOver: true }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 3_000));
      /* T209 review: Cancel during the apology means no ticket goes up.
         Three seconds is long enough to change your mind in, and a
         teacher who cancels and watches the ticket appear anyway has
         been told the control does not work. */
      if (gen.current !== mine) return;
      await present();
    })();
  }, [present, setPresentingBoth]);

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
    setPresentingBoth(false);
    setApproval(null);
    setNote(null);
    /* The screen is no longer being waited on; the route cancels a
       pending approval of its own when it takes the PIN. */
    chargeRef.current({ token });
  }, [setPresentingBoth]);

  const reset = useCallback(() => endWait(null), [endWait]);

  /* T241 third review (5): a tab that goes away takes its own approval
   * off the student's screen with it, as the live mirror does, so a tab
   * reopened without its id does not sit behind its own orphan. Best
   * effort, naming this tab and that request. */
  useEffect(() => {
    const leave = () => {
      const held = approvalRef.current;
      const rid =
        held?.stage === "waiting"
          ? held.requestId
          : held?.stage === "pin"
            ? held.resume?.requestId
            : undefined;
      if (rid === undefined) return;
      void cancelOnDisplay({ requestId: rid, keepalive: true }).catch(
        () => undefined,
      );
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, []);

  const requestId = useCallback((): string | null => {
    const held = approvalRef.current;
    if (held?.stage === "waiting") return held.requestId;
    if (held?.stage === "pin") return held.resume?.requestId ?? null;
    return null;
  }, []);

  const askAgain = useCallback(() => {
    /* Never a charge: `begin` charges with the setting off, this does
       nothing at all. */
    if (!onRef.current) return;
    const held = approvalRef.current;
    const replaces =
      held?.stage === "waiting"
        ? held.requestId
        : held?.stage === "pin"
          ? held.resume?.requestId
          : undefined;
    /* T241 review: only an OUTSTANDING approval is asked again. With
     * the wait already over there is nothing to re-ask, and presenting
     * from scratch here would put up an approval (and charge on its
     * Approve) that no teacher tapped for. */
    if (replaces === undefined) return;
    /* The PIN pad, if it was open over the wait, closes: the ticket it
       was about is being asked again. The wait stays on the same id. */
    if (held?.stage === "pin") {
      const next: ApprovalState = { stage: "waiting", requestId: replaces };
      approvalRef.current = next;
      setApproval(next);
    }
    setNote(null);
    gen.current += 1;
    void present(replaces);
  }, [present]);

  return {
    approval,
    note,
    waitingForScreen,
    pending: approval !== null || presenting,
    begin,
    cancel,
    abandon,
    keepWaiting,
    takeOver,
    toPin,
    closePin,
    armed,
    reset,
    askAgain,
    requestId,
  };
}
