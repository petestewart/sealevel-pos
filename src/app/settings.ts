"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Tunable knobs, held in the browser so they can be changed without a
 * commit and a restart.
 *
 * These are the numbers that have already been wrong once each: the search
 * debounce was tuned for a local index and fired four calls per lookup, the
 * minimum query length let "de" match 209 people, and check-in was
 * optimistic when it should have waited. Each was a constant, a commit and
 * a redeploy to test. Now they are dials.
 *
 * Deliberately client-side only. Anything that decides whether a write
 * reaches Mindbody -- dry run, target, the write guard -- stays in the
 * server environment where a browser cannot touch it. A settings panel
 * that could turn off dry run would defeat the point of dry run.
 */

export interface Settings {
  searchDebounceMs: number;
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
  /** Require a second tap to check in a booking with no pass attached. */
  confirmUnpaid: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  searchDebounceMs: 350,
  minQueryLength: 3,
  searchLimit: 12,
  hoursBack: 2,
  hoursForward: 4,
  optimisticCheckIn: false,
  confirmUnpaid: true,
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
