"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** sessionStorage key for the saved mobile list scroll position. */
export function listScrollKey(pathname: string): string {
  return `inbox-list-scroll:${pathname}`;
}

/** Matches the A7 mobile breakpoint in globals.css. */
export const MOBILE_MEDIA_QUERY = "(max-width: 720px)";

/**
 * Mobile list scroll restoration (A7, GH-35). On a phone the list and the
 * detail are alternating full-screen views of the same route, so the
 * browser's own scroll restoration cannot bring the list back to where the
 * operator was. ItemRow saves window.scrollY to sessionStorage when a row
 * is tapped at mobile width; this component, rendered only when the list
 * is showing (no ?item selection), restores that position once and clears
 * it. Desktop is untouched: nothing is saved or restored above the
 * breakpoint, and with no saved value this renders and does nothing.
 */
export function ListScrollRestore() {
  const pathname = usePathname();

  useEffect(() => {
    if (!window.matchMedia(MOBILE_MEDIA_QUERY).matches) return;
    const key = listScrollKey(pathname);
    const stored = sessionStorage.getItem(key);
    if (stored == null) return;
    sessionStorage.removeItem(key);
    const y = Number(stored);
    if (Number.isFinite(y)) window.scrollTo(0, y);
  }, [pathname]);

  return null;
}
