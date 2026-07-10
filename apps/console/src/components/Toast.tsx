"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Lightweight toast system for the inbox (A2, GH-30). A single transient
 * message confirms an in-place decision (approve / reject / save & approve)
 * without a full-page reload. One toast at a time: a new decision replaces
 * the previous message rather than stacking, which keeps rapid consecutive
 * decides from spamming a pile of toasts.
 *
 * The provider lives in the /items layout so it survives soft navigation
 * between ?item selections (the layout is not remounted when the detail
 * pane advances to the next item), letting the toast persist across the
 * advance. Progressive enhancement: with no JS this never mounts and the
 * server action + revalidate still produces correct state.
 *
 * Copy is TRUTHFUL (nothing auto-sends in v1): the toast confirms the
 * decision was recorded, never that a message was sent. No em dashes.
 */

const AUTO_HIDE_MS = 4200;

interface ToastState {
  /** Monotonic id so re-showing the same text still restarts the timer. */
  key: number;
  message: string;
}

interface ToastApi {
  show(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, [clearTimer]);

  const show = useCallback((message: string) => {
    seq.current += 1;
    setToast({ key: seq.current, message });
  }, []);

  // Restart the auto-hide timer whenever a new toast (by key) appears, so a
  // rapid second decide extends the window rather than letting the first
  // toast's timer hide the second one early.
  useEffect(() => {
    if (!toast) return;
    clearTimer();
    timer.current = setTimeout(() => setToast(null), AUTO_HIDE_MS);
    return clearTimer;
  }, [toast, clearTimer]);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
        {toast ? (
          <div key={toast.key} className="toast">
            <span className="toast-dot" aria-hidden="true" />
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={dismiss}
            >
              {"×"}
            </button>
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
