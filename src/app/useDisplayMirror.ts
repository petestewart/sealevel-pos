"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { TicketPayload } from "@/lib/displayticket";

import { cancelOnDisplay, presenterId } from "./presenter";

/**
 * The teacher's half of the ticket scene (T201, Phase 2.5 item 2).
 *
 * The sale screen mirrors the priced cart to the customer display as it
 * is built (D3, Pete: "Live"), and puts the post-sale summary up when the
 * charge lands. This hook is the whole of that traffic, in one place, so
 * the rules live together:
 *
 * - **Nothing is sent unless a display is paired AND connected.** No
 *   display is the state of every counter today, and a POST per cart tap
 *   to a server that will 409 them all is noise in the call log and in
 *   the network tab.
 * - **One present in flight at a time, latest wins.** A burst of cart
 *   taps settles into ONE present: the newest payload is queued, the
 *   intermediate ones are dropped, and nothing is sent until the one in
 *   flight has answered. A mirror that raced itself would be showing a
 *   student the ticket from two taps ago.
 * - **`reason: "busy"` is silent.** Something else holds the screen (a
 *   waiver, a sign-up, or a summary still thanking the last student).
 *   The design says the mirror is informational, so it is skipped without
 *   a word and resumes on the next priced change. Nothing surfaces to the
 *   teacher, who did not ask for this and cannot act on it.
 *
 * Nothing here calls Mindbody. It POSTs /api/display/present and
 * /api/display/cancel, which are the two routes a scene travels through.
 */

/** A burst of cart taps settles into one present. The pricing loop
 *  already debounces 400ms before it asks Mindbody, so this is only what
 *  covers a fresh ANSWER arriving twice in quick succession. */
const PRESENT_DEBOUNCE_MS = 200;

export interface DisplayMirror {
  /** Whether a display is paired and connected right now. */
  connected: boolean;
  /** True when the last live present landed, so the sale screen can say
   *  the student can see this. False the moment the cart is cancelled,
   *  the display goes away, or something else takes the screen. */
  showing: boolean;
  /** Mirror the ticket. Debounced, single-flight, latest wins. T241:
   *  `clientId` is the ticket's client ("" for a walk-in), which the
   *  server keeps on its own half of the request so a card the student
   *  types on this ticket is bound to that client. It never reaches the
   *  display. */
  live: (payload: TicketPayload | null, clientId?: string) => void;
  /** T241: the request id of the live ticket of ours that is up, or
   *  null. A pick is only acted on for a ticket this screen is showing. */
  requestId: () => string | null;
  /** Put the post-sale summary up. Sent once, immediately: the hub takes
   *  it back down itself after its few seconds. */
  summary: (payload: TicketPayload) => void;
}

export function useDisplayMirror(
  active: boolean,
  opts: {
    /** T241: a `tender-pick` event off the teacher's stream this hook
     *  already holds, handed to the screen's `useTenderPick`. One stream
     *  rather than another EventSource: the iPad already holds several,
     *  and a browser on HTTP/1.1 gives one origin six connections. */
    onPick?: (value: unknown) => void;
  } = {},
): DisplayMirror {
  const onPickRef = useRef(opts.onPick);
  onPickRef.current = opts.onPick;
  const [connected, setConnected] = useState(false);
  const [showing, setShowing] = useState(false);

  /* Paired and connected, from the same two sources the header's mark
   * reads (T200): the events stream when it is up, and a 30 second poll
   * so the answer is still right when the stream is refused or dropped. */
  const read = useCallback(() => {
    fetch("/api/admin/display")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body) return;
        setConnected(body.paired === true && body.connected === true);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    read();
    const timer = setInterval(read, 30_000);
    return () => clearInterval(timer);
  }, [read]);

  useEffect(() => {
    let source: EventSource | null = null;
    try {
      source = new EventSource("/api/display/events");
    } catch {
      return;
    }
    const mark = (next: boolean) => () => {
      setConnected(next);
      if (!next) setShowing(false);
    };
    const on = mark(true);
    const off = mark(false);
    const pick = (ev: Event) => {
      try {
        onPickRef.current?.(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* An unreadable pick is no pick. */
      }
    };
    /* T241 second review (N3): another tab took this tab's live ticket
     * over (Take over, or a stale ticket retired), so it is no longer up:
     * the next priced change presents again, and meets "busy" if the
     * other tab still holds the screen. */
    const retired = (ev: Event) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          requestId?: unknown;
        };
        if (data.requestId !== liveId.current) return;
        liveId.current = null;
        up.current = false;
        setShowing(false);
      } catch {
        /* An unreadable event changes nothing. */
      }
    };
    source.addEventListener("connected", on);
    source.addEventListener("disconnected", off);
    source.addEventListener("tender-pick", pick);
    source.addEventListener("ticket-retired", retired);
    return () => {
      source?.removeEventListener("connected", on);
      source?.removeEventListener("disconnected", off);
      source?.removeEventListener("tender-pick", pick);
      source?.removeEventListener("ticket-retired", retired);
      source?.close();
    };
  }, []);

  /** The present in flight, and the payload waiting behind it. */
  const busy = useRef(false);
  const queued = useRef<{ payload: TicketPayload; clientId: string } | null>(
    null,
  );
  /** T241: the id the last successful present answered with. */
  const liveId = useRef<string | null>(null);
  /** Whether a live ticket of ours is up, so the cart emptying cancels
   *  it rather than leaving the last line on a student's screen. */
  const up = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const post = useCallback(async (payload: TicketPayload | null, clientId = "") => {
    busy.current = true;
    try {
      if (payload === null) {
        up.current = false;
        liveId.current = null;
        if (alive.current) setShowing(false);
        await cancelOnDisplay();
        return;
      }
      const res = await fetch("/api/display/present", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "ticket",
          payload,
          ...(payload.clientFirstName
            ? { clientFirstName: payload.clientFirstName }
            : {}),
          ...(payload.mode === "live" ? { clientId } : {}),
          /* T241 review: this tab, so the hub keeps two iPads' tickets
             (and a student's pick and card) apart. */
          presenter: presenterId(),
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        up.current = payload.mode === "live";
        liveId.current =
          payload.mode === "live" && typeof body?.requestId === "string"
            ? body.requestId
            : null;
        if (alive.current) setShowing(payload.mode === "live");
        return;
      }
      /* Silent by design: the student is on another scene, or there is no
       * screen to talk to. The mirror resumes on the next priced change.
       * A debug line and nothing else, because this iPad has no console
       * at the counter and a teacher must not be told about a decision
       * they did not make. */
      up.current = false;
      liveId.current = null;
      if (alive.current) setShowing(false);
      console.debug(
        `[display] ticket not shown (${body?.reason ?? res.status})`,
      );
    } catch {
      up.current = false;
      liveId.current = null;
      if (alive.current) setShowing(false);
    } finally {
      busy.current = false;
      /* The latest payload that arrived while this one was in flight.
       * The intermediate ones were dropped on the way in: a student sees
       * the ticket as it stands, not every tap that built it. */
      const next = queued.current;
      queued.current = null;
      if (next !== null) void post(next.payload, next.clientId);
    }
  }, []);

  const live = useCallback(
    (payload: TicketPayload | null, clientId = "") => {
      if (payload === null) {
        /* An emptied cart (or a closed sale screen) takes the ticket down
         * only if one of ours is up: a cancel against a waiver somebody
         * else put on the screen is not this mirror's to send.
         *
         * This runs BEFORE the active/connected gate on purpose: the sale
         * screen closing is exactly the moment `active` goes false, and a
         * cancel skipped there would leave the last ticket on a student's
         * screen until the hub's own expiry. */
        if (!up.current) return;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        queued.current = null;
        void post(null);
        return;
      }
      if (!active || !connected) {
        /* Nothing paired: nothing is sent and nothing is logged. */
        up.current = false;
        return;
      }
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        if (busy.current) {
          queued.current = { payload, clientId };
          return;
        }
        void post(payload, clientId);
      }, PRESENT_DEBOUNCE_MS);
    },
    [active, connected, post],
  );

  const summary = useCallback(
    (payload: TicketPayload) => {
      if (!connected) return;
      /* The sale is over. Two things must not undo the thank you: a
       * queued live ticket from the last cart tap, and the cancel the
       * emptied cart is about to ask for. Both are dropped here, and
       * `up` goes false SYNCHRONOUSLY so the cart-clearing render that
       * follows this tap finds no live ticket of ours to take down. */
      up.current = false;
      liveId.current = null;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (busy.current) {
        queued.current = { payload, clientId: "" };
        return;
      }
      void post(payload);
    },
    [connected, post],
  );

  /* T241 second review (N2): a tab that goes away (closed, reloaded,
   * evicted) takes its own live ticket off the student's screen on the
   * way out, best effort: a keepalive cancel naming this tab and that
   * request, so it can never take down another tab's. A reload comes
   * back as the same presenter (sessionStorage) and simply presents
   * again. */
  useEffect(() => {
    const leave = () => {
      const rid = liveId.current;
      if (rid === null) return;
      liveId.current = null;
      up.current = false;
      void cancelOnDisplay({ requestId: rid, keepalive: true }).catch(
        () => undefined,
      );
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, []);

  const requestId = useCallback(() => liveId.current, []);

  return { connected, showing, live, summary, requestId };
}
