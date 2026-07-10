"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the server-rendered counts (nav pending pill, sidebar inbox pills)
 * fresh without a manual reload. It calls router.refresh(), which re-fetches
 * the server components and reconciles them in place, so client state owned by
 * the list/detail interaction (open editor, current selection, typed text) is
 * preserved across a tick.
 *
 * Two triggers:
 *  - window focus: refresh immediately, so switching back to a stale tab shows
 *    current counts right away;
 *  - a periodic poll (~60s): catches changes made by a background job or in
 *    another tab while this one stays focused.
 *
 * The poll is paused whenever the tab is hidden (no busy-looping in the
 * background); it resumes and refreshes once on the visibilitychange back to
 * visible. Renders nothing.
 */
const POLL_MS = 60_000;

export function CountRefresher() {
  const router = useRouter();

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let lastRefresh = 0;

    // Returning to a backgrounded tab fires both focus and visibilitychange;
    // collapse near-simultaneous triggers into a single refresh.
    const refresh = () => {
      const now = Date.now();
      if (now - lastRefresh < 1_000) return;
      lastRefresh = now;
      router.refresh();
    };

    const startPolling = () => {
      if (interval !== undefined) return;
      interval = setInterval(() => {
        // Guard belt-and-suspenders: never fire while hidden.
        if (document.visibilityState === "visible") refresh();
      }, POLL_MS);
    };

    const stopPolling = () => {
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
    };

    const onFocus = () => refresh();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
        startPolling();
      } else {
        stopPolling();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Only start the interval if we begin visible; a tab restored from the
    // background starts polling on its first visibilitychange.
    if (document.visibilityState === "visible") startPolling();

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopPolling();
    };
  }, [router]);

  return null;
}
