/**
 * T70: which palette the screen uses. The CSS has one light block on
 * :root and one dark block on :root[data-theme="dark"], so the choice is
 * made here, once, by putting that attribute on <html>: from the sun
 * toggle's stored choice when a teacher made one, and from the iPad's
 * own setting otherwise (and again whenever that setting changes).
 *
 * BOOT_SCRIPT runs inline from layout.tsx before the first paint so a
 * dark iPad never flashes light; it is the same rule as `applyTheme`,
 * written out because it has to be a string.
 */

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "pos.theme";

export const BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  KEY,
)});var d=c==="dark"||(c!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light");}catch(e){}})();`;

export function readThemeChoice(): ThemeChoice {
  try {
    const c = window.localStorage.getItem(KEY);
    return c === "dark" || c === "light" ? c : "system";
  } catch {
    return "system";
  }
}

export function resolvedTheme(): "light" | "dark" {
  const c = readThemeChoice();
  if (c !== "system") return c;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(): "light" | "dark" {
  const t = resolvedTheme();
  document.documentElement.setAttribute("data-theme", t);
  return t;
}

export function setThemeChoice(choice: ThemeChoice): "light" | "dark" {
  try {
    if (choice === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: the choice lasts until reload, which is fine */
  }
  return applyTheme();
}

/** The sun toggle: light becomes dark and dark becomes light, stored. */
export function toggleTheme(): "light" | "dark" {
  return setThemeChoice(resolvedTheme() === "dark" ? "light" : "dark");
}

/** Follows the iPad's setting while the choice is "system". */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const on = () => {
    if (readThemeChoice() === "system") applyTheme();
  };
  mq.addEventListener("change", on);
  return () => mq.removeEventListener("change", on);
}
