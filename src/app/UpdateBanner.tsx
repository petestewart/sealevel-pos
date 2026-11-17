"use client";

import { useEffect, useState, type ReactNode } from "react";

import { useUpdateReady, writeInFlight } from "./appversion";

/**
 * T246: picking up a new deploy on the teacher's iPad. Pete: "could we
 * add a reload button? i need it to run the new deployed versions as
 * theyre deployed". The counter is a Home Screen web app, so there is no
 * browser reload to reach for.
 *
 * Three pieces, none of which calls Mindbody or touches a sale:
 *
 * - `UpdateBanner`: "A new version is ready." with a 64px Reload, when
 *   the server's version differs from the one this page loaded with. It
 *   NEVER reloads by itself, because a sale, a check-in or an approval
 *   may be in progress, and its Reload refuses in words while a charge
 *   or any write to the app's API is on the wire.
 * - `ReloadApp`: the manual control, which always reloads. In the
 *   account modal and the customer display Options menu.
 * - `ReloadDisplay`: "Reload customer screen", which asks the hub to
 *   tell the display; the display reloads at once if idle, otherwise
 *   when the student is done, and the teacher gets one line saying which.
 */

/** Words for a scene a student is in, for "when the ... ends". */
const HELD_WORDS: Record<string, string> = {
  live: "the ticket on it is cleared",
  summary: "its thank-you screen ends",
  approval: "the student answers the approval",
  waiver: "the student finishes the waiver",
  signup: "the student finishes signing up",
  contract: "the student finishes the membership",
};

export default function UpdateBanner(props: {
  /** Why a reload must wait right now (a charge in flight, a gift card
   *  id still to write), or null. */
  busyWhy: string | null;
}) {
  const ready = useUpdateReady();
  const [why, setWhy] = useState<string | null>(null);

  /* The banner's height is part of --nav-space while it shows, so the
   * roster, the sale overlay and every modal end above it. */
  useEffect(() => {
    const root = document.documentElement;
    if (ready) root.setAttribute("data-update-ready", "");
    else root.removeAttribute("data-update-ready");
    return () => root.removeAttribute("data-update-ready");
  }, [ready]);

  /* A refusal's sentence goes once the reason has. */
  useEffect(() => {
    if (why === null) return;
    const timer = setTimeout(() => setWhy(null), 6_000);
    return () => clearTimeout(timer);
  }, [why]);

  if (!ready) return null;
  return (
    <div className="update-banner" role="status">
      <p className="update-banner-text">
        {why ?? "A new version is ready."}
      </p>
      <button
        type="button"
        className="update-banner-btn"
        onClick={() => {
          if (props.busyWhy !== null) {
            setWhy(props.busyWhy);
            return;
          }
          if (writeInFlight()) {
            setWhy("Something is still being saved. Reload in a moment.");
            return;
          }
          window.location.reload();
        }}
      >
        Reload
      </button>
    </div>
  );
}

/** "Reload app": always reloads, whatever is on screen. */
export function ReloadApp(props: { buttonClass: string }) {
  return (
    <button
      type="button"
      className={props.buttonClass}
      onClick={() => window.location.reload()}
    >
      Reload app
    </button>
  );
}

/** "Reload customer screen", with the one line that says what happened. */
export function ReloadDisplay(props: {
  buttonClass: string;
  /** Drawn beside the button, in the same row. */
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  const ask = async () => {
    setBusy(true);
    setLine(null);
    try {
      const res = await fetch("/api/display/reload", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setLine(String(body?.error ?? `That did not work (HTTP ${res.status}).`));
        return;
      }
      if (body?.delivered !== true) {
        setLine("The customer screen is not connected, so it could not be told.");
        return;
      }
      const held = typeof body?.held === "string" ? HELD_WORDS[body.held] : undefined;
      setLine(
        held
          ? `The customer screen will reload when ${held}.`
          : "The customer screen is reloading now.",
      );
    } catch {
      setLine("That did not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="display-reset">
      <div className="display-reset-buttons">
        <button
          type="button"
          className={props.buttonClass}
          disabled={busy}
          onClick={() => void ask()}
        >
          {busy ? "Asking" : "Reload customer screen"}
        </button>
        {props.children}
      </div>
      {line !== null ? (
        <p className="display-reset-line" role="status">
          {line}
        </p>
      ) : null}
    </div>
  );
}
