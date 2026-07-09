"use client";

import { useState } from "react";

export type Theme = "dark" | "light";

/**
 * Theme switcher per the Console.dc.html nav spec. The choice is persisted
 * in a cookie so the server can stamp data-theme on <html> during SSR and
 * the page never flashes the wrong palette.
 */
export function ThemeToggle({ initialTheme }: { initialTheme: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  function toggle(): void {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset["theme"] = next;
    document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      title="Toggle theme"
      aria-label="Toggle theme"
    >
      {theme === "dark" ? "☾" : "☀"}
    </button>
  );
}
