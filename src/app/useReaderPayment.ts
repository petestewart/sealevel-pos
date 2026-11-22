"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * T227: the Square card reader, for BOTH charge screens (the Cart screen
 * and the roster's "Pay and check in"; T209's lesson: one piece, used by
 * every charge path from the day it is written).
 *
 * Two parts:
 * - `status`: whether the tile is drawn at all (the switch) and whether
 *   it can be used now (paired, set up, the database), with the reason,
 *   read on mount, every 30 seconds and when the page comes back.
 * - `hold(body)`: puts the ticket's rehearsed total on the Terminal and
 *   waits, polling each second, until the card is APPROVED (a hold, money
 *   not taken) or the attempt ends. It resolves with the attempt id to
 *   send to /api/checkout as `reader: { attemptId }`, or with the words
 *   that say why nothing was charged. `view` is what the panel draws
 *   meanwhile, and `cancel()` is its Cancel.
 *
 * Nothing here takes money: the checkout does, after the sale stands.
 */

export interface ReaderStatus {
  enabled: boolean;
  ready: boolean;
  why: string | null;
  mode: string;
  paired: boolean;
}

export interface ReaderView {
  attemptId: string | null;
  state: string;
  words: string;
  amountCents: number | null;
  cancellable: boolean;
  cardBrand: string | null;
  lastFour: string | null;
}

export type HoldResult =
  | { ok: true; attemptId: string; cardBrand: string | null; lastFour: string | null }
  | { ok: false; message: string; unknown: boolean };

const POLL_MS = 1000;
/** A little over the server's own 90 second wait for a card, so the
 *  server's cancel is what ends a silent reader, not this tab. */
const GIVE_UP_MS = 110_000;

export function useReaderPayment() {
  const [status, setStatus] = useState<ReaderStatus | null>(null);
  const [view, setView] = useState<ReaderView | null>(null);
  const attempt = useRef<string | null>(null);
  const cancelled = useRef(false);

  const readStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/reader/status");
      if (!res.ok) {
        setStatus(null);
        return;
      }
      const body = await res.json();
      setStatus({
        enabled: body.enabled === true,
        ready: body.ready === true,
        why: typeof body.why === "string" ? body.why : null,
        mode: String(body.mode ?? "sandbox"),
        paired: body.paired === true,
      });
    } catch {
      /* Keep the last answer: a blip must not hide a tile mid-sale. */
    }
  }, []);

  useEffect(() => {
    void readStatus();
    const timer = setInterval(() => void readStatus(), 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void readStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [readStatus]);

  const cancel = useCallback(async () => {
    cancelled.current = true;
    const id = attempt.current;
    if (id === null) return;
    setView((v) => (v ? { ...v, words: "Cancelling on the reader.", cancellable: false } : v));
    try {
      await fetch(`/api/reader/attempt/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    } catch {
      /* The poll reads how it ended; the server's sweep releases a hold
       * nobody claims. */
    }
  }, []);

  const hold = useCallback(
    async (body: Record<string, unknown>, idemKey: string): Promise<HoldResult> => {
      cancelled.current = false;
      attempt.current = null;
      setView({
        attemptId: null,
        state: "created",
        words: "Starting the card reader.",
        amountCents: null,
        cancellable: false,
        cardBrand: null,
        lastFour: null,
      });
      let started: any = null;
      try {
        const res = await fetch("/api/reader/collect", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": idemKey },
          body: JSON.stringify(body),
        });
        started = await res.json().catch(() => null);
        if (!res.ok || started?.ok !== true) {
          setView(null);
          return {
            ok: false,
            message: String(started?.error ?? `The card reader did not start (HTTP ${res.status}). Nothing was charged.`),
            unknown: false,
          };
        }
      } catch {
        setView(null);
        return {
          ok: false,
          message:
            "The card reader did not answer. If the reader shows the amount, cancel it there. Nothing was charged.",
          unknown: false,
        };
      }
      const id: string = started.attempt.id;
      attempt.current = id;
      const show = (a: any) =>
        setView({
          attemptId: id,
          state: String(a.state),
          words: String(a.words),
          amountCents: typeof a.amountCents === "number" ? a.amountCents : null,
          cancellable: a.cancellable === true,
          cardBrand: a.cardBrand ?? null,
          lastFour: a.lastFour ?? null,
        });
      show(started.attempt);
      const began = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        let a: any = null;
        try {
          const res = await fetch(`/api/reader/attempt/${encodeURIComponent(id)}`);
          a = (await res.json().catch(() => null))?.attempt ?? null;
        } catch {
          a = null;
        }
        if (a !== null) {
          show(a);
          if (a.state === "authorized") {
            return { ok: true, attemptId: id, cardBrand: a.cardBrand ?? null, lastFour: a.lastFour ?? null };
          }
          if (a.state === "cancelled") {
            setView(null);
            return { ok: false, message: String(a.words), unknown: false };
          }
          if (a.state === "unresolved") {
            setView(null);
            return { ok: false, message: String(a.words), unknown: true };
          }
        }
        if (Date.now() - began > GIVE_UP_MS) {
          if (!cancelled.current) await cancel();
          setView(null);
          return {
            ok: false,
            message:
              "The card reader stopped answering, so it was cancelled. If the reader still shows the amount, cancel it there. Nothing was charged.",
            unknown: false,
          };
        }
      }
    },
    [cancel],
  );

  /** The sale has answered: the panel goes. */
  const done = useCallback(() => {
    attempt.current = null;
    setView(null);
  }, []);

  return { status, readStatus, view, hold, cancel, done };
}
