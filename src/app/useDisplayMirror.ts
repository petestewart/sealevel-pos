"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { TicketPayload } from "@/lib/displayticket";

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
 * - **The tab reconciles on load and on return** (T244, Pete: "when i
 *   switched to another app and went back to this one, it is stuck on a
 *   sales screen even tho the cart is empty and no client is attached").
 *   iPadOS discards a backgrounded Safari tab and reloads it, and the
 *   reloaded page has an empty cart and no memory (`up`) of the ticket it
 *   left up. So on mount, on `visibilitychange` to visible, on
 *   `pageshow` and when the display (re)connects, an empty cart (or a
 *   closed sale screen) sends ONE `scope: "live"` cancel, which the
 *   SERVER applies only to a live ticket or a summary, never to a
 *   waiver, a sign-up, a contract or an approval; a cart that is not
 *   empty is presented again so the display matches this screen.
 * - **The student's Close sticks** (T244). The display's Close tells this
 *   tab (`closed` on the events stream), and the SAME ticket is not
 *   presented again until the cart changes (`closedKey`: the lines and
 *   the name, never a price answer, so a re-price cannot undo it).
 *
 * Nothing here calls Mindbody. It POSTs /api/display/present and
 * /api/display/cancel, which are the two routes a scene travels through.
 */

/** T244: what "the same ticket" means for the student's Close: the name
 *  and the lines as the cart holds them. Totals are left out on purpose,
 *  because a price answer landing is not the teacher changing the cart. */
function closureKey(payload: TicketPayload): string {
  return JSON.stringify({ c: payload.clientFirstName, l: payload.lines });
}

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
  /** Mirror the ticket. Debounced, single-flight, latest wins. */
  live: (payload: TicketPayload | null) => void;
  /** Put the post-sale summary up. Sent once, immediately: the hub takes
   *  it back down itself after its few seconds. */
  summary: (payload: TicketPayload) => void;
  /** T244: the student closed this cart's ticket on their screen, and it
   *  stays closed until the cart changes. */
  closedByCustomer: boolean;
}

export function useDisplayMirror(active: boolean): DisplayMirror {
  const [connected, setConnected] = useState(false);
  const [showing, setShowing] = useState(false);
  const [closedByCustomer, setClosedByCustomer] = useState(false);

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
    /* T244: the student's Close. Only a live ticket of OURS counts (the
     * request id the last present answered), and the cart it showed is
     * remembered so the mirror does not put it straight back. */
    const closed = (ev: MessageEvent) => {
      let data: { requestId?: unknown; mode?: unknown } = {};
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (data.mode !== "live") return;
      if (!up.current || data.requestId !== lastRequestId.current) return;
      up.current = false;
      closedKey.current = lastKey.current;
      setShowing(false);
      setClosedByCustomer(true);
    };
    source.addEventListener("connected", on);
    source.addEventListener("disconnected", off);
    source.addEventListener("closed", closed);
    return () => {
      source?.removeEventListener("connected", on);
      source?.removeEventListener("disconnected", off);
      source?.removeEventListener("closed", closed);
      source?.close();
    };
  }, []);

  /** The present in flight, and the payload waiting behind it. */
  const busy = useRef(false);
  const queued = useRef<TicketPayload | null>(null);
  /** Whether a live ticket of ours is up, so the cart emptying cancels
   *  it rather than leaving the last line on a student's screen. */
  const up = useRef(false);
  /** T244: the request id and closure key of the last live present that
   *  landed, the key of a ticket the student closed, and the newest
   *  payload the sale screen asked for (null: empty cart or closed). */
  const lastRequestId = useRef<string | null>(null);
  const lastKey = useRef<string | null>(null);
  const closedKey = useRef<string | null>(null);
  const latest = useRef<TicketPayload | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const post = useCallback(async (payload: TicketPayload | null) => {
    busy.current = true;
    try {
      if (payload === null) {
        up.current = false;
        if (alive.current) setShowing(false);
        /* T244 review: scoped, so the mirror can only ever take down a
         * live ticket or a summary. Without a per-tab owner (not on this
         * branch) another iPad's reconcile can leave `up` stale here, and
         * an unscoped cancel would then wipe a waiver or sign-up a student
         * is in the middle of. Approvals end through useSaleApproval's
         * own cancel. */
        await fetch("/api/display/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "live" }),
        });
        return;
      }
      /* T244: the student closed this very ticket; nothing changed since. */
      if (
        payload.mode === "live" &&
        closedKey.current !== null &&
        closureKey(payload) === closedKey.current
      ) {
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
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        up.current = payload.mode === "live";
        if (payload.mode === "live") {
          lastRequestId.current =
            typeof body?.requestId === "string" ? body.requestId : null;
          lastKey.current = closureKey(payload);
          /* T244 review: a different cart is now showing, so a Close
           * remembered for an earlier one (e.g. one that raced this
           * present) must not hold back a later return to it. */
          if (closedKey.current !== null && closedKey.current !== lastKey.current) {
            closedKey.current = null;
            if (alive.current) setClosedByCustomer(false);
          }
        }
        if (alive.current) setShowing(payload.mode === "live");
        return;
      }
      /* Silent by design: the student is on another scene, or there is no
       * screen to talk to. The mirror resumes on the next priced change.
       * A debug line and nothing else, because this iPad has no console
       * at the counter and a teacher must not be told about a decision
       * they did not make. */
      up.current = false;
      if (alive.current) setShowing(false);
      console.debug(
        `[display] ticket not shown (${body?.reason ?? res.status})`,
      );
    } catch {
      up.current = false;
      if (alive.current) setShowing(false);
    } finally {
      busy.current = false;
      /* The latest payload that arrived while this one was in flight.
       * The intermediate ones were dropped on the way in: a student sees
       * the ticket as it stands, not every tap that built it. */
      const next = queued.current;
      queued.current = null;
      if (next !== null) void post(next);
    }
  }, []);

  const live = useCallback(
    (payload: TicketPayload | null) => {
      latest.current = payload;
      if (payload === null) {
        /* T244: an empty cart forgets the student's Close, so the next
         * cart is presented whatever it holds. */
        closedKey.current = null;
        setClosedByCustomer(false);
      } else if (
        closedKey.current !== null &&
        closureKey(payload) === closedKey.current
      ) {
        /* The same ticket the student closed: stays closed. */
        return;
      } else {
        closedKey.current = null;
        setClosedByCustomer(false);
      }
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
          queued.current = payload;
          return;
        }
        void post(payload);
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
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (busy.current) {
        queued.current = payload;
        return;
      }
      void post(payload);
    },
    [connected, post],
  );

  /* T244: reconcile on load and on return. One request either way: an
   * empty cart (or a closed sale screen) asks the SERVER to take down a
   * live ticket or a summary and nothing else; a cart that is not empty
   * is presented again through the normal path, so the display matches
   * this screen (busy, closed and unpaired are all still silent). */
  const liveRef = useRef(live);
  liveRef.current = live;
  /** When the last empty-cart reconcile went out: mount, `pageshow` and
   *  the first `connected` all land in the same second of a reload, and
   *  one cancel answers all three. */
  const lastReconcile = useRef(0);
  const reconcile = useCallback(() => {
    const payload = latest.current;
    if (payload === null) {
      const now = Date.now();
      if (now - lastReconcile.current < 2_000) return;
      lastReconcile.current = now;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      queued.current = null;
      up.current = false;
      if (alive.current) setShowing(false);
      void fetch("/api/display/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "live" }),
      }).catch(() => undefined);
      return;
    }
    liveRef.current(payload);
  }, []);

  useEffect(() => {
    reconcile();
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const onShow = () => reconcile();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onShow);
    };
  }, [reconcile]);

  /* And when the display (re)connects: a screen that was away while this
   * tab emptied its cart must not come back to the old ticket. */
  useEffect(() => {
    if (connected) reconcile();
  }, [connected, reconcile]);

  return { connected, showing, live, summary, closedByCustomer };
}
