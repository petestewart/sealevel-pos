"use client";

import { useCallback, useEffect, useState } from "react";

import { plainText } from "@/lib/richtext";
import { readTicketPayload } from "@/lib/displayticket";

import TicketScene from "./TicketScene";

import type { TicketPayload } from "@/lib/displayticket";

/**
 * The idle screen and the pairing exchange (T112).
 *
 * Unpaired, it asks /api/display/state for a six-digit code and the
 * SECRET that goes with it. The code is on the screen for a teacher to
 * read; the secret stays in this component's memory and never is. The
 * poll presents both, so the cookie can only be issued to the browser
 * that displayed the code, not to whoever read it over the counter.
 *
 * Paired, it holds the SSE stream open. Nothing consumes a scene yet;
 * what the stream buys today is the heartbeat, which is what the POS
 * header's connection mark reads, and the guarantee that a reload lands
 * on the server's picture rather than on this component's.
 */

interface Config {
  banner: string | null;
  dryRun: boolean;
  target: string;
}

/** T114: what the stream put on this screen, or null for idle. Only the
 *  ticket exists today; the waiver, the sign-up and the contract are
 *  items 3 to 6 and an unknown kind deliberately renders the idle screen
 *  rather than guessing. */
type Scene = { kind: "ticket"; payload: TicketPayload };

type Pairing =
  | { state: "loading" }
  | { state: "unpaired"; code: string; secret: string; error: string | null }
  | { state: "paired"; name: string | null; durable: boolean };

/** A code reads as three and three: it is read aloud across a counter. */
function spaced(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export default function DisplayScreen() {
  const [config, setConfig] = useState<Config | null>(null);
  const [pairing, setPairing] = useState<Pairing>({ state: "loading" });
  const [durable, setDurable] = useState(true);
  /** Whether the stream is up, so a display that lost the server says so
   *  rather than sitting there looking fine. */
  const [live, setLive] = useState(false);
  /** T114: the scene the server says is up. */
  const [scene, setScene] = useState<Scene | null>(null);

  /* The banner and the mode, from the answer /api/config gives a browser
   * with no session at all: banner text, dry run and the target. */
  useEffect(() => {
    const read = () => {
      fetch("/api/config")
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!body) return;
          setConfig({
            banner: typeof body.banner === "string" ? body.banner : null,
            dryRun: body.dryRun === true,
            target: String(body.target ?? ""),
          });
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, []);

  const takeCode = useCallback(async () => {
    try {
      const res = await fetch("/api/display/state");
      const body = await res.json();
      if (body?.durable === false) setDurable(false);
      else if (body?.durable === true) setDurable(true);
      if (body?.paired === true) {
        setPairing({
          state: "paired",
          name: body.name ?? null,
          durable: body.durable !== false,
        });
        return;
      }
      if (typeof body?.code === "string" && typeof body?.secret === "string") {
        setPairing({
          state: "unpaired",
          code: body.code,
          secret: body.secret,
          error: null,
        });
      }
    } catch {
      /* The server is not answering. The poll below tries again. */
    }
  }, []);

  useEffect(() => {
    void takeCode();
  }, [takeCode]);

  /* Unpaired: poll with the code AND the secret until a teacher pairs it,
   * then take the cookie. A code that expired (five minutes) is replaced
   * rather than left on the screen looking valid. */
  useEffect(() => {
    if (pairing.state !== "unpaired") return;
    const code = pairing.code;
    const secret = pairing.secret;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/display/state?code=${encodeURIComponent(code)}&secret=${encodeURIComponent(secret)}`,
        );
        const body = await res.json().catch(() => null);
        if (stopped) return;
        if (body?.paired === true) {
          setPairing({
            state: "paired",
            name: body.name ?? null,
            durable: body.durable !== false,
          });
          return;
        }
        if (res.status === 404 || body?.expired === true) {
          void takeCode();
        }
      } catch {
        /* Keep the code on screen and try again. */
      }
    };
    const timer = setInterval(() => void tick(), 2_000);
    /* Five minutes and one second: the code is dead by then anyway. */
    const refresh = setTimeout(() => void takeCode(), 5 * 60_000 + 1_000);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(refresh);
    };
  }, [pairing, takeCode]);

  /* Paired: hold the stream. EventSource reconnects on its own, so the
   * only job here is to say whether it is up and to fall back to the
   * pairing screen when the server no longer knows this display (a
   * restart with no database, or an unpair). */
  useEffect(() => {
    if (pairing.state !== "paired") return;
    let source: EventSource | null = null;
    let stopped = false;
    try {
      source = new EventSource("/api/display/stream");
    } catch {
      return;
    }
    const onOpen = () => setLive(true);
    /* T114: one place that turns a `present` into a scene. An unknown
     * kind is the idle screen and ONE log line: a student must never be
     * shown a half-rendered guess at something this build does not know
     * how to draw, and a teacher must not be left wondering why the
     * screen did not change. */
    let warned = "";
    const onPresent = (ev: MessageEvent) => {
      setLive(true);
      let data: { kind?: unknown; payload?: unknown } | null = null;
      try {
        const parsed: unknown = JSON.parse(ev.data);
        if (parsed && typeof parsed === "object") {
          data = parsed as { kind?: unknown; payload?: unknown };
        }
      } catch {
        return;
      }
      if (data?.kind === "ticket") {
        const ticket = readTicketPayload(data.payload);
        if (ticket.ok) {
          setScene({ kind: "ticket", payload: ticket.value });
          return;
        }
      }
      const kind = String(data?.kind ?? "unknown");
      if (warned !== kind) {
        warned = kind;
        console.warn(`[display] nothing here renders a ${kind} scene yet`);
      }
      setScene(null);
    };
    const onIdle = () => {
      setLive(true);
      setScene(null);
    };
    const onError = () => {
      setLive(false);
      setScene(null);
      /* A 401 means this cookie names nobody any more. Ask the server
       * what it thinks: it will hand back a fresh pairing code. */
      void fetch("/api/display/state")
        .then((r) => r.json())
        .then((body) => {
          if (stopped) return;
          if (body?.paired === false && typeof body?.code === "string") {
            setPairing({
              state: "unpaired",
              code: body.code,
              secret: String(body.secret ?? ""),
              error: null,
            });
          }
        })
        .catch(() => undefined);
    };
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    source.addEventListener("idle", onIdle);
    source.addEventListener("present", onPresent);
    source.addEventListener("cancel", onIdle);
    return () => {
      stopped = true;
      source?.removeEventListener("open", onOpen);
      source?.removeEventListener("error", onError);
      source?.removeEventListener("idle", onIdle);
      source?.removeEventListener("present", onPresent);
      source?.removeEventListener("cancel", onIdle);
      source?.close();
    };
  }, [pairing.state]);

  /* The banner is studio text, and the waiver and a contract's terms will
   * arrive on this screen later as Mindbody's own HTML, so everything
   * remote goes through plainText here as a matter of course. Never
   * dangerouslySetInnerHTML: this iPad is in a student's hands. */
  const banner = plainText(config?.banner ?? "");

  /* The mode mark. The "never remove the banner" rule is the teacher's,
   * but a display a teacher glances at must not lie either: a live studio
   * writing for real shows nothing here. */
  const mark =
    config === null
      ? null
      : config.target === "sandbox"
        ? "Sandbox"
        : config.dryRun
          ? "Dry run"
          : null;

  /* T114: a scene owns the middle of the screen; the banner and the mode
   * mark stay where they are, because what this iPad is pointed at is as
   * true during a sale as it is at rest. */
  if (pairing.state === "paired" && scene !== null) {
    return (
      <main className="display">
        {banner.length > 0 ? <p className="display-banner">{banner}</p> : null}
        <div className="display-scene">
          <TicketScene payload={scene.payload} />
        </div>
        {mark ? <p className="display-mark">{mark}</p> : null}
      </main>
    );
  }

  return (
    <main className="display">
      {banner.length > 0 ? <p className="display-banner">{banner}</p> : null}
      <div className="display-middle">
        <h1 className="display-greeting">Welcome to Sealevel Hot Yoga</h1>
        {pairing.state === "unpaired" ? (
          <>
            <p className="display-lead">
              This screen is not paired yet. In Settings on the front desk
              iPad, open Customer display and enter:
            </p>
            <p className="display-code">{spaced(pairing.code)}</p>
            <p className="display-note">
              The code lasts five minutes, then a new one appears here.
            </p>
          </>
        ) : pairing.state === "paired" ? (
          <>
            <p className="display-lead">
              {live
                ? "Ready. The front desk will put anything you need to read or sign on this screen."
                : "Reconnecting to the front desk."}
            </p>
            {!durable ? (
              <p className="display-note">
                This pairing is held in memory only, so a server restart will
                need it done again.
              </p>
            ) : null}
          </>
        ) : (
          <p className="display-lead">Starting up.</p>
        )}
      </div>
      {mark ? <p className="display-mark">{mark}</p> : null}
    </main>
  );
}
