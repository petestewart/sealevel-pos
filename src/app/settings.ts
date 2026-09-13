"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Tunable knobs, held in the browser so they can be changed without a
 * commit and a restart.
 *
 * These are the numbers that have already been wrong once each: the
 * minimum query length let "de" match 209 people, and check-in was
 * optimistic when it should have waited. Each was a constant, a commit and
 * a redeploy to test. Now they are dials. (The search debounce used to be
 * one of them; it retired with the live search itself when search became
 * submit-triggered, T16. A stored value for it merges harmlessly and is
 * ignored.)
 *
 * Deliberately client-side only. Anything that decides whether a write
 * reaches Mindbody -- dry run, target, the write guard -- stays in the
 * server environment where a browser cannot touch it. A settings panel
 * that could turn off dry run would defeat the point of dry run.
 */

export interface Settings {
  minQueryLength: number;
  searchLimit: number;
  /** Hours of schedule to show either side of now. */
  hoursBack: number;
  hoursForward: number;
  /**
   * Flip the check-in row before Mindbody answers. Faster, and wrong at a
   * counter: see the note in CLAUDE.md. Here so the difference can be felt
   * rather than argued about.
   */
  optimisticCheckIn: boolean;
  /** Gate an unpaid booking's check-in behind the pay-and-check-in
   *  dialog (T25). Off checks unpaid rows straight in for free, the
   *  pre-Phase-2 behavior. */
  confirmUnpaid: boolean;
  /** T52 (Pete): "if there are none in that class, and the 'in class'
   *  filter is on, the 'in class' filter should turn off and the
   *  non-filtered results should display. this can be a setting". On,
   *  the attach modal widens a submitted query that matched nobody in
   *  the class to everyone, one call; off, it says nobody matched and
   *  waits. */
  autoWidenSearch: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  minQueryLength: 3,
  searchLimit: 12,
  hoursBack: 2,
  hoursForward: 4,
  optimisticCheckIn: false,
  confirmUnpaid: true,
  autoWidenSearch: true,
};

const KEY = "sealevel-pos.settings";

function load(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    /** Merge over the defaults so a setting added later does not arrive
     *  undefined for anyone with an older stored blob. */
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings(): {
  settings: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
} {
  /**
   * Start from the defaults on both server and first client render, then
   * adopt stored values in an effect. Reading localStorage during render
   * would make the markup differ between server and client.
   */
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    setSettings(load());
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setSettings(load());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const set = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      setSettings((current) => {
        const next = { ...current, [key]: value };
        try {
          window.localStorage.setItem(KEY, JSON.stringify(next));
          /** Same-tab writes do not fire `storage`, so tell any other
           *  component on this page directly. */
          window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
        } catch {
          /* private mode, or storage disabled; the setting still applies
           * for this session. */
        }
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return { settings, set, reset };
}
