"use client";

import { useCallback, useEffect, useState } from "react";

import { plainText } from "@/lib/richtext";
import { readTicketPayload } from "@/lib/displayticket";
import { readContractPayload } from "@/lib/displaycontract";
import { readSignupPayload } from "@/lib/displaysignup";
import { readWaiverPayload } from "@/lib/displaywaiver";

import ContractScene from "./ContractScene";
import SignupScene from "./SignupScene";
import TicketScene from "./TicketScene";
import WaiverScene from "./WaiverScene";

import type { ContractPayload } from "@/lib/displaycontract";
import type { SignupPayload } from "@/lib/displaysignup";
import type { TicketPayload } from "@/lib/displayticket";
import type { WaiverPayload } from "@/lib/displaywaiver";

/**
 * The idle screen and the pairing exchange (T200).
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

/** T201: what the stream put on this screen, or null for idle. Only the
 *  ticket exists today; the waiver, the sign-up and the contract are
 *  items 3 to 6 and an unknown kind deliberately renders the idle screen
 *  rather than guessing. */
type Scene =
  /* T203: the ticket carries its request id now, because the APPROVE
   *  mode is answered from this screen; live and summary ignore it. */
  | { kind: "ticket"; requestId: string; payload: TicketPayload }
  /* T202: the waiver carries its request id, because this is the first
   *  scene the STUDENT answers: completing and refusing both name it. */
  | { kind: "waiver"; requestId: string; payload: WaiverPayload }
  /* T204: the self-serve sign-up, the one scene the STUDENT puts up. */
  | { kind: "register"; requestId: string; payload: SignupPayload }
  /* T205: the membership contract, signed the way the waiver is. */
  | { kind: "contract"; requestId: string; payload: ContractPayload };

/** T202: how long "Thank you" stays after a signature, on this screen's
 *  own clock. The hub sends `idle` when the teacher's iPad finalises the
 *  release, which is usually within the second; this is what keeps the
 *  student from watching the screen blink back to Ready before they have
 *  looked up. Eight seconds, the same window the summary gets. */
const THANKS_MS = 8_000;

/** T203: how long "Please start again in a moment" stands after a
 *  teacher took the screen over. A little longer than the three seconds
 *  their iPad waits before presenting, so the apology never blinks. */
const TAKEOVER_MS = 4_000;

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
  /** T201: the scene the server says is up. */
  const [scene, setScene] = useState<Scene | null>(null);
  /** T202: the thank you after a signature. Held on this screen so the
   *  student sees it whatever the server does next. */
  const [thanks, setThanks] = useState<string | null>(null);
  /** T203: the line a "Take over" leaves on the screen for a few seconds
   *  before the next scene, so a student is not simply interrupted. */
  const [notice, setNotice] = useState<string | null>(null);
  /** T204: the self-serve sign-up's own tap, and what to say when the
   *  server will not have it (the front desk is using the screen). */
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const startSignup = useCallback(async () => {
    setStartError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/display/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "signup" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setStartError(
          typeof body?.error === "string"
            ? body.error
            : "That did not start. Please ask the front desk.",
        );
      }
      /* The scene arrives on the stream, like every other scene: the
       * server's picture is the one that wins. */
    } catch {
      setStartError("No answer from the front desk. Please try again.");
    } finally {
      setStarting(false);
    }
  }, []);

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
    /* T201: one place that turns a `present` into a scene. An unknown
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
      if (data?.kind === "waiver") {
        const waiver = readWaiverPayload(data.payload);
        const requestId =
          typeof (data as { requestId?: unknown }).requestId === "string"
            ? String((data as { requestId?: unknown }).requestId)
            : "";
        if (waiver.ok && requestId.length > 0) {
          setThanks(null);
          setNotice(null);
          setScene({ kind: "waiver", requestId, payload: waiver.value });
          return;
        }
      }
      if (data?.kind === "contract") {
        const contract = readContractPayload(data.payload);
        const requestId =
          typeof (data as { requestId?: unknown }).requestId === "string"
            ? String((data as { requestId?: unknown }).requestId)
            : "";
        if (contract.ok && requestId.length > 0) {
          setThanks(null);
          setNotice(null);
          setScene({ kind: "contract", requestId, payload: contract.value });
          return;
        }
      }
      if (data?.kind === "register") {
        const signup = readSignupPayload(data.payload);
        const requestId =
          typeof (data as { requestId?: unknown }).requestId === "string"
            ? String((data as { requestId?: unknown }).requestId)
            : "";
        if (signup.ok && requestId.length > 0) {
          setThanks(null);
          setNotice(null);
          setScene({ kind: "register", requestId, payload: signup.value });
          return;
        }
      }
      if (data?.kind === "ticket") {
        const ticket = readTicketPayload(data.payload);
        if (ticket.ok) {
          setThanks(null);
          setNotice(null);
          setScene({
            kind: "ticket",
            requestId:
              typeof (data as { requestId?: unknown }).requestId === "string"
                ? String((data as { requestId?: unknown }).requestId)
                : "",
            payload: ticket.value,
          });
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
    /* T203: a cancel that says `takenOver` is the teacher needing this
     * screen for somebody else. The apology stands for a few seconds and
     * the next `present` clears it; an ordinary cancel is still idle. */
    const onCancel = (ev: MessageEvent) => {
      let takenOver = false;
      try {
        const parsed: unknown = JSON.parse(ev.data);
        takenOver =
          parsed !== null &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).takenOver === true;
      } catch {
        /* An unreadable cancel is still a cancel. */
      }
      setLive(true);
      setScene(null);
      setThanks(null);
      setNotice(takenOver ? "Please start again in a moment." : null);
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
    source.addEventListener("cancel", onCancel);
    return () => {
      stopped = true;
      source?.removeEventListener("open", onOpen);
      source?.removeEventListener("error", onError);
      source?.removeEventListener("idle", onIdle);
      source?.removeEventListener("present", onPresent);
      source?.removeEventListener("cancel", onCancel);
      source?.close();
    };
  }, [pairing.state]);

  /* T203: and so does the take-over apology. */
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), TAKEOVER_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /* T202: the thank you leaves on its own, whether or not the server has
   * anything to say. */
  useEffect(() => {
    if (thanks === null) return;
    const timer = setTimeout(() => setThanks(null), THANKS_MS);
    return () => clearTimeout(timer);
  }, [thanks]);

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

  /* T201: a scene owns the middle of the screen; the banner and the mode
   * mark stay where they are, because what this iPad is pointed at is as
   * true during a sale as it is at rest. */
  if (pairing.state === "paired" && notice !== null && scene === null) {
    return (
      <main className="display">
        {banner.length > 0 ? <p className="display-banner">{banner}</p> : null}
        <div className="display-middle">
          <h1 className="display-greeting">One moment</h1>
          <p className="display-notice">{notice}</p>
        </div>
        {mark ? <p className="display-mark">{mark}</p> : null}
      </main>
    );
  }

  if (pairing.state === "paired" && thanks !== null && scene === null) {
    return (
      <main className="display">
        {banner.length > 0 ? <p className="display-banner">{banner}</p> : null}
        <div className="display-middle">
          <h1 className="display-greeting">
            {thanks.length > 0 ? `Thank you, ${thanks}` : "Thank you"}
          </h1>
          <p className="display-lead">That is all we need.</p>
        </div>
        {mark ? <p className="display-mark">{mark}</p> : null}
      </main>
    );
  }

  if (pairing.state === "paired" && scene !== null) {
    return (
      <main className="display">
        {banner.length > 0 ? <p className="display-banner">{banner}</p> : null}
        <div className="display-scene">
          {scene.kind === "contract" ? (
            <ContractScene
              requestId={scene.requestId}
              payload={scene.payload}
              onDone={(who) => {
                /* Done with the screen the moment the server has the
                   signature; the hub's own idle (when the teacher's iPad
                   purchases) arrives behind this. */
                setScene(null);
                setThanks(who ?? "");
              }}
            />
          ) : scene.kind === "register" ? (
            <SignupScene
              requestId={scene.requestId}
              payload={scene.payload}
              onDone={(who) => {
                /* T204: the student is done with the screen the moment
                 * the server has their sign-up. The thank you is this
                 * screen's own, for the few seconds before idle. */
                setScene(null);
                setThanks(who ?? "");
              }}
            />
          ) : scene.kind === "ticket" ? (
            <TicketScene
              payload={scene.payload}
              requestId={scene.requestId}
              onAnswered={(approved) => {
                /* The scene is done with the screen the moment the
                 * server has the answer; the hub's own idle (when the
                 * teacher's iPad charges, or drops the approval) comes
                 * in behind this. */
                setScene(null);
                if (approved) setThanks(plainText(scene.payload.clientFirstName ?? ""));
              }}
            />
          ) : (
            <WaiverScene
              requestId={scene.requestId}
              payload={scene.payload}
              onDone={(who) => {
                /* The scene is done with the screen the moment the
                 * server has the signature; the hub's own `idle` (when
                 * the teacher's iPad finalises) arrives behind this. */
                setScene(null);
                setThanks(who ?? "");
              }}
            />
          )}
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
            {/* T204: the one thing a student may start themselves. It
                needs no teacher decision, and it is what keeps a new
                student out of the queue during a rush. Only when the
                stream is up: a button that cannot reach the server is
                worse than no button. */}
            {live ? (
              <button
                className="display-start"
                disabled={starting}
                onClick={() => void startSignup()}
              >
                {starting ? "One moment" : "New here? Sign up"}
              </button>
            ) : null}
            {startError ? (
              <p className="display-note" role="status">
                {startError}
              </p>
            ) : null}
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
