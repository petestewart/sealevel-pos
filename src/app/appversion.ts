"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * T246: is a newer build running on the server than the one this page
 * loaded with? Pete: "could we add a reload button? i need it to run the
 * new deployed versions as theyre deployed".
 *
 * The page's version is the FIRST answer it gets (`/api/config` on the
 * teacher's iPad, `/api/display/version` or the stream on the customer
 * screen), held at module scope, so it lasts exactly as long as this
 * page load does: a component remounting does not forget it and a reload
 * starts over. Every later answer is compared with it. One race is left
 * open on purpose: a deploy landing between the page's scripts arriving
 * and its first answer makes the page believe it is already new, and it
 * is caught by the deploy after that, or by Reload app.
 *
 * Nothing here reloads. The teacher's iPad offers a Reload button and
 * the customer screen decides for itself when it is idle; both read
 * `updateReady` from here.
 */

let loaded: string | null = null;
let latest: string | null = null;
const subs = new Set<() => void>();

/** Record a version a server answered with. Anything that is not a
 *  non-empty string (an older server, an error body) is ignored. */
export function noteServerVersion(v: unknown): void {
  if (typeof v !== "string" || v.length === 0) return;
  if (loaded === null) loaded = v;
  if (latest === v) return;
  latest = v;
  for (const sub of subs) sub();
}

export function updateReady(): boolean {
  return loaded !== null && latest !== null && latest !== loaded;
}

/** The version the server last answered with, or null. */
export function latestVersion(): string | null {
  return latest;
}

function subscribe(sub: () => void): () => void {
  subs.add(sub);
  return () => {
    subs.delete(sub);
  };
}

export function useUpdateReady(): boolean {
  return useSyncExternalStore(subscribe, updateReady, () => false);
}

/** Run `check` whenever the page comes back into view: the tab turning
 *  visible, and `pageshow` (a Home Screen app returning from the
 *  background, or a page restored from the back-forward cache). */
export function useCheckOnReturn(check: () => void): void {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", check);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", check);
    };
  }, [check]);
}

/* --- Writes in flight (teacher's iPad) --------------------------------
 * The Reload button refuses while one is on the wire: a reload would
 * drop the answer to a charge or a check-in on the floor. Counted by the
 * fetch observer FrontDeskPage already wraps every request in, so no
 * write path had to change to be counted. */

let writesInFlight = 0;

export function beginWatchedWrite(): void {
  writesInFlight += 1;
}

export function endWatchedWrite(): void {
  writesInFlight = Math.max(0, writesInFlight - 1);
}

export function writeInFlight(): boolean {
  return writesInFlight > 0;
}

/** Whether a fetch is a write to this app's own API: not a GET or HEAD,
 *  same origin, under /api/. */
export function isWatchedWrite(
  input: Parameters<typeof window.fetch>[0],
  init: Parameters<typeof window.fetch>[1],
): boolean {
  try {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method === "GET" || method === "HEAD") return false;
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      window.location.origin,
    );
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}
