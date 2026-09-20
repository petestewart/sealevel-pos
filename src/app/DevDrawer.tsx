"use client";

import { useCallback, useEffect, useState } from "react";

import { DEFAULT_SETTINGS, type Settings, useSettings } from "./settings";
import { readThemeChoice, setThemeChoice, type ThemeChoice } from "./theme";
import { ProbeView, type ProbeResult, type Teacher } from "./StaffModal";

/**
 * A drawer that slides up from the bottom showing the Mindbody traffic this
 * app actually generated: method, path, status, latency, request body,
 * response body.
 *
 * Recorded server-side, so it shows what Mindbody really received and said,
 * not what our own API routes chose to forward. It renders nothing unless
 * /api/devlog answers, which it only does when devtools are enabled, so
 * this is inert on the counter iPad.
 */

interface CallRecord {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number | null;
  ms: number;
  outcome: string;
  /** T49: the staff id the call ran as, when a signed-in teacher's. */
  actor: number | null;
  /** T109: that teacher's session token, in full, on the call that used
   *  it (Pete: "log staff session tokens"). Shown next to the staff id in
   *  the expanded record and in what `copy` puts on the clipboard, which
   *  is where someone debugging one call looks. Not on the collapsed row:
   *  a token is longer than the path it would push off the screen. */
  actorToken: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

function statusClass(call: CallRecord): string {
  if (call.outcome !== "sent") return "dev-suppressed";
  if (call.status === null) return "";
  return call.status >= 400 ? "dev-bad" : "dev-good";
}

/**
 * T85: the drawer's pill is gone and the nav bar's Dev item takes its
 * place, so whether the drawer is open and whether devtools answered at
 * all are page.tsx's: the bar needs both to render the item and light it.
 * Cmd+D stays here, with the keydown that has always been the drawer's.
 */
export default function DevDrawer({
  open,
  onOpenChange,
  onAvailableChange,
  onTargetSwitched,
  onConfigChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True once /api/devlog answers, false while it 404s. */
  onAvailableChange: (available: boolean) => void;
  /** T89: the counter was just pointed at the other studio. The page
   *  re-reads /api/config for the banner and sends everyone back to the
   *  sign-in gate, since every staff session has just ended. */
  onTargetSwitched: (next: string, notice: string) => void;
  /** T89: something in /api/config changed from in here (this browser's
   *  own dry run), so the page re-reads it rather than waiting for its
   *  30 second tick. The mode banner is the whole reason: it must never
   *  say LIVE while this iPad is suppressing its writes. */
  onConfigChanged: () => void;
}) {
  const [available, setAvailable] = useState(false);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  /** Which call id was just copied, for the momentary "copied" label. */
  const [copied, setCopied] = useState<number | "all" | null>(null);
  const [tab, setTab] = useState<"calls" | "settings" | "bundles" | "shelf">(
    "settings",
  );
  /* Every open lands on the settings tab, whatever was showing last. */
  useEffect(() => {
    if (open) setTab("settings");
  }, [open]);
  const { settings, set, reset } = useSettings();

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/devlog");
      if (!res.ok) return setAvailable(false);
      const body = await res.json();
      setAvailable(true);
      setCalls(body.calls ?? []);
    } catch {
      setAvailable(false);
    }
  }, []);

  /* T85: the nav bar renders its Dev item off this. */
  useEffect(() => {
    onAvailableChange(available);
  }, [available, onAvailableChange]);

  useEffect(() => {
    void poll();
  }, [poll]);

  /**
   * Poll whether the drawer is open or not (Pete, fifth live test: the
   * pill read "API 0" until the drawer had been opened once, which reads
   * as "nothing is being recorded" -- the server records every call from
   * the moment it starts, and the count should say so). Open, it is live
   * at 1.5s; closed, it ticks slowly enough to cost nothing on a machine
   * that is also serving the counter, and only ever hits our own route.
   */
  useEffect(() => {
    const t = setInterval(() => void poll(), open ? 1500 : 6000);
    return () => clearInterval(t);
  }, [open, poll]);

  /**
   * Cmd+D (Ctrl+D elsewhere) toggles the drawer. Both are taken by the
   * browser -- bookmark on Mac, bookmark-or-delete elsewhere -- so this
   * has to preventDefault, which is acceptable for a tool that only
   * exists in dev builds.
   */
  useEffect(() => {
    if (!available) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [available, open, onOpenChange]);

  /**
   * navigator.clipboard needs a secure context, which http://<lan-ip>:3000
   * on an iPad is not, so fall back to a hidden textarea and execCommand.
   * Copying a payload off the tablet is exactly when this matters most.
   */
  const copy = useCallback(async (text: string, id: number | "all") => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(el);
      }
    }
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  }, []);

  const asText = (call: CallRecord): string =>
    [
      `${call.method} ${call.path}`,
      `${call.outcome} ${call.status ?? ""} ${call.ms}ms  ${call.at}` +
        (call.actor !== null ? `  actor=${call.actor}` : "") +
        (call.actorToken ? `  token=${call.actorToken}` : ""),
      call.requestBody ? `\n--- request ---\n${call.requestBody}` : "",
      `\n--- response ---\n${call.responseBody ?? "(empty)"}`,
    ]
      .filter(Boolean)
      .join("\n");

  if (!available) return null;

  const failures = calls.filter(
    (c) => c.outcome === "sent" && c.status !== null && c.status >= 400,
  ).length;

  return (
    <>
      <section className={open ? "dev-drawer open" : "dev-drawer"}>
        <header className="dev-head">
          {/* Settings first and open by default, the call log last and
              called logs (Pete: "when Settings is opened, have it open to
              the settings tab", "change Calls to Logs and move that tab
              all the way over to the right"). */}
          <button
            className={tab === "settings" ? "dev-tab on" : "dev-tab"}
            onClick={() => setTab("settings")}
          >
            settings
          </button>
          <button
            className={tab === "bundles" ? "dev-tab on" : "dev-tab"}
            onClick={() => setTab("bundles")}
          >
            bundles
          </button>
          <button
            className={tab === "shelf" ? "dev-tab on" : "dev-tab"}
            onClick={() => setTab("shelf")}
          >
            shelf
          </button>
          <button
            className={tab === "calls" ? "dev-tab on" : "dev-tab"}
            onClick={() => setTab("calls")}
          >
            logs
          </button>
          {tab === "calls" ? (
            <>
              <button
                onClick={() =>
                  copy(calls.map(asText).join("\n\n====\n\n"), "all")
                }
              >
                {copied === "all" ? "copied" : "copy all"}
              </button>
              <button
                onClick={async () => {
                  await fetch("/api/devlog", { method: "DELETE" });
                  setCalls([]);
                }}
              >
                clear
              </button>
            </>
          ) : tab === "settings" ? (
            <button onClick={reset}>reset to defaults</button>
          ) : null}
          {/* T85: the pill carried the call count, the failure badge and
              the only close; the nav bar's Dev item is a label and not a
              readout, so all three live in the head now. The count is
              live whether the drawer is open or not (Pete, fifth live
              test: a stale count reads as "nothing is being recorded"). */}
          <span className="dev-count">
            API {calls.length}
            {failures > 0 ? <span className="dev-badge">{failures}</span> : null}
          </span>
          <button className="dev-close" onClick={() => onOpenChange(false)}>
            close
          </button>
        </header>

        <div className="dev-body">
          {tab === "settings" ? (
            <SettingsPanel
              settings={settings}
              set={set}
              open={open}
              onTargetSwitched={onTargetSwitched}
              onConfigChanged={onConfigChanged}
            />
          ) : tab === "bundles" ? (
            <BundlesPanel />
          ) : tab === "shelf" ? (
            <ShelfPanel />
          ) : calls.length === 0 ? (
            <p className="muted">No calls yet.</p>
          ) : (
            calls.map((call) => (
              <div key={call.id} className="dev-call">
                <button
                  className="dev-row"
                  onClick={() =>
                    setExpanded((e) => (e === call.id ? null : call.id))
                  }
                >
                  <span className={`dev-status ${statusClass(call)}`}>
                    {call.outcome === "sent" ? call.status : call.outcome}
                  </span>
                  <span className="dev-method">{call.method}</span>
                  <span className="dev-path">{call.path}</span>
                  {call.actor !== null ? (
                    <span className="dev-actor">actor={call.actor}</span>
                  ) : null}
                  <span className="dev-ms">{call.ms}ms</span>
                </button>
                {expanded === call.id ? (
                  <div className="dev-detail">
                    <div className="dev-detail-head">
                      <span className="muted">{call.at}</span>
                      <button onClick={() => copy(asText(call), call.id)}>
                        {copied === call.id ? "copied" : "copy"}
                      </button>
                    </div>
                    {call.actorToken ? (
                      <>
                        {/* T109: the token this call ran under, beside the
                            staff id the row already names. It wraps, since
                            a token is long and the point is reading it
                            whole. */}
                        <div className="dev-label">
                          actor token (staff {call.actor})
                        </div>
                        <pre>{call.actorToken}</pre>
                      </>
                    ) : null}
                    {call.requestBody ? (
                      <>
                        <div className="dev-label">request</div>
                        <pre>{call.requestBody}</pre>
                      </>
                    ) : null}
                    <div className="dev-label">response</div>
                    <pre>{call.responseBody ?? "(empty)"}</pre>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}

const NUMBERS: {
  key: keyof Settings;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "searchDebounceMs", label: "Search debounce", hint: "ms", min: 0, max: 1500, step: 50 },
  { key: "minQueryLength", label: "Minimum query", hint: "letters", min: 1, max: 6, step: 1 },
  { key: "searchLimit", label: "Search results", hint: "max", min: 3, max: 50, step: 1 },
  { key: "hoursBack", label: "Default class", hint: "hours back", min: 0, max: 12, step: 1 },
];

const FLAGS: { key: keyof Settings; label: string; hint: string }[] = [
  {
    key: "optimisticCheckIn",
    label: "Optimistic check-in",
    hint: "flip the row before Mindbody answers (faster, can show a check-in that failed)",
  },
  {
    key: "confirmUnpaid",
    label: "Unpaid opens Pay and check in",
    hint: "gate a booking with no pass behind the pay dialog (off = check in free directly)",
  },
  {
    key: "autoWidenSearch",
    label: "Widen a search that finds nobody in class",
    hint: "in the attach modal, a query matching nobody in the class moves the segment to All and searches everyone as you type (T52)",
  },
];

function SettingsPanel({
  settings,
  set,
  open,
  onTargetSwitched,
  onConfigChanged,
}: {
  settings: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  /** T89 review: the drawer stays mounted while it is shut, so the panel
   *  re-reads /api/config every time it OPENS. Without that, `targetAdmin`
   *  is whatever it was when the roster mounted: an admin who hands the
   *  counter over through "sign in as someone else" left the switch drawn
   *  for a teacher who is not one. The route refuses them either way, but
   *  a control that cannot work must not be on the screen. */
  open: boolean;
  onTargetSwitched: (next: string, notice: string) => void;
  onConfigChanged: () => void;
}) {
  /* T29: the one quiet line saying which store is behind the DB features.
   * "none" is full fallback mode and is normal for local work. */
  const [storage, setStorage] = useState<string | null>(null);
  /* T78: where staff sessions live ("postgres" survives a restart; a
   * "memory (...)" mode names what is missing), from the same read. */
  const [staffSessions, setStaffSessions] = useState<string | null>(null);
  /* T89: the target as anyone may read it, and whether the teacher signed
   * in here may SWITCH it (POS_ADMIN_STAFF_IDS). Non-admins get the one
   * read-only line; the switch does not exist for them, and the route
   * refuses them regardless of what this renders. */
  const [mode, setMode] = useState<{
    target: string;
    targetSource: string;
    siteId: string | null;
    dryRun: boolean;
    dryRunSource: string | null;
    targetAdmin: boolean;
    /** T111: the write guard's list, because this tab is now the ONLY
     *  place the quiet (live, writing, unrestricted) case is written
     *  down: the main screen's banner is gone in that state. */
    writeClientIds: string[];
  } | null>(null);
  const readMode = useCallback(() => {
    fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!body) return;
        if (typeof body.storage === "string") setStorage(body.storage);
        if (typeof body.staffSessions === "string") {
          setStaffSessions(body.staffSessions);
        }
        setMode({
          target: String(body.target ?? ""),
          targetSource: String(body.targetSource ?? "env"),
          siteId: body.siteId ?? null,
          dryRun: body.dryRun === true,
          dryRunSource: body.dryRunSource ?? null,
          targetAdmin: body.targetAdmin === true,
          writeClientIds: Array.isArray(body.writeClientIds)
            ? body.writeClientIds.map((id: unknown) => String(id))
            : [],
        });
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!open) return;
    readMode();
  }, [readMode, open]);
  return (
    <div className="dev-settings">
      {mode?.targetAdmin ? (
        <TargetPanel open={open} onSwitched={onTargetSwitched} />
      ) : mode !== null ? (
        <>
          <div className="dev-label">mindbody target</div>
          <p className="dev-target-now">
            {mode.target === "prod" ? "Production" : "Sandbox"} site{" "}
            {mode.siteId ?? "not configured"}.{" "}
            {mode.targetSource === "setting"
              ? "Stored setting."
              : "From MINDBODY_TARGET in the server environment."}
          </p>
        </>
      ) : null}
      {/* T111: the write guard, in words, in the tab. Pete took the mode
          banner off the main screen for the ordinary production state
          ("The settings pop up should show that info enough without
          polluting the main screen"), so the counter's only written
          record of an UNRESTRICTED live counter is here. A guard that is
          narrowing writes still raises the banner on the main screen; this
          line is what says "no guard" when nothing else does. */}
      {mode !== null ? (
        <p className="muted">
          {mode.writeClientIds.length > 0
            ? `Write guard: POS_WRITE_CLIENT_IDS limits writes to client ${mode.writeClientIds.join(", ")}. A write for anybody else is logged and suppressed.`
            : "Write guard: off (POS_WRITE_CLIENT_IDS empty), so writes are allowed for every client."}
        </p>
      ) : null}
      <BrowserDryRun
        mode={mode}
        onChange={() => {
          readMode();
          onConfigChanged();
        }}
      />
      <DisplayPanel open={open} />
      <ConfirmSalePanel open={open} admin={mode?.targetAdmin === true} />
      <ContractSignaturePanel open={open} admin={mode?.targetAdmin === true} />
      <SignupModePanel open={open} admin={mode?.targetAdmin === true} />
      <p className="muted">
        The rest is stored in this browser. Applies immediately, no restart.
        The server's own dry run and the write guard stay in the server
        environment and are deliberately not here: the control above can
        only add suppression for this iPad, never take it away.
      </p>
      {storage !== null ? (
        <p className="muted">
          storage: {storage}
          {storage === "none"
            ? " (no DATABASE_URL; bundles, waiver receipts and banner use their fallbacks)"
            : ""}
        </p>
      ) : null}
      {staffSessions !== null ? (
        <p className="muted">staff sessions: {staffSessions}</p>
      ) : null}
      {NUMBERS.map((field) => (
        <label key={field.key} className="dev-setting">
          <span className="dev-setting-label">
            {field.label}
            <span className="muted"> {field.hint}</span>
          </span>
          <input
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            value={String(settings[field.key])}
            onChange={(e) =>
              set(field.key, Number(e.target.value) as never)
            }
          />
          {settings[field.key] !== DEFAULT_SETTINGS[field.key] ? (
            <span className="dev-changed">
              default {String(DEFAULT_SETTINGS[field.key])}
            </span>
          ) : null}
        </label>
      ))}
      {FLAGS.map((field) => (
        <label key={field.key} className="dev-setting">
          <span className="dev-setting-label">
            {field.label}
            <span className="muted"> {field.hint}</span>
          </span>
          <input
            type="checkbox"
            checked={Boolean(settings[field.key])}
            onChange={(e) => set(field.key, e.target.checked as never)}
          />
        </label>
      ))}
      <ThemeSetting />
      <TeacherPanel />
    </div>
  );
}

/* --- Customer display (T200) ------------------------------------------
 *
 * Pair and unpair the second iPad. Anyone who can open the drawer may use
 * it, and it is gated by the device session and a signed-in teacher and
 * nothing else: pairing decides which SCREEN a waiver appears on, never
 * whether a write happens or which studio it lands in, and "a teacher
 * setting up the counter is the point" (docs/design/customer-display.md).
 *
 * The code entry is a plain numeric field, which the "no amount in a text
 * field" rule does not touch: it is not an amount, it is six digits read
 * off a screen once, and the OS keyboard is the right tool for that.
 */

interface DisplayInfo {
  paired: boolean;
  name: string | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
  connected: boolean;
  busy: boolean;
  storage: string;
  durable: boolean;
}

/** "12 seconds ago", for the last heartbeat. Plain and approximate: the
 *  question this answers is only "is that screen awake". */
function ago(iso: string | null): string {
  if (iso === null) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "never";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function DisplayPanel({ open }: { open: boolean }) {
  const [info, setInfo] = useState<DisplayInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/display");
      if (!res.ok) return;
      setInfo((await res.json()) as DisplayInfo);
    } catch {
      /* The block stays quiet; nothing else depends on it. */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    /* While the drawer is open, often enough that "connected" is true
     * rather than remembered. */
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load, open]);

  const pair = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/admin/display/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok !== true) {
        setError(String(body?.error ?? `HTTP ${res.status}`));
        return;
      }
      setCode("");
      setDone("Paired. The customer screen goes to its welcome screen.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const unpair = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/admin/display/unpair", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(String(body?.error ?? `HTTP ${res.status}`));
        return;
      }
      setAsking(false);
      setDone("Unpaired. That iPad shows a new pairing code.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null;

  return (
    <>
      <div className="dev-label">customer display</div>
      <p className="muted">
        {info === null
          ? "The display cannot be read here."
          : info.paired
            ? `Paired${info.name ? `: ${info.name}` : ""}. ` +
              (info.connected
                ? `Connected, last seen ${ago(info.lastSeenAt)}.`
                : `Not connected, last seen ${ago(info.lastSeenAt)}.`) +
              (info.durable
                ? ""
                : " No database, so a server restart needs it paired again.")
            : "Not paired. Open /display on the customer iPad and enter the six digits it shows."}
      </p>
      {done ? <p className="dev-changed">{done}</p> : null}
      {error ? <p className="dev-target-error">{error}</p> : null}
      <div className="dev-target-buttons">
        <input
          className="dev-display-code"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={7}
          placeholder="000000"
          aria-label="Pairing code from the customer display"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
        />
        <button
          type="button"
          className="dev-target-btn dev-target-go"
          disabled={busy || code.trim().length !== 6}
          onClick={() => void pair()}
        >
          {busy ? "Pairing" : "Pair"}
        </button>
      </div>
      {info?.paired ? (
        asking ? (
          <div className="dev-target-ask">
            <p className="dev-target-question">
              Unpair the customer display? It shows a new code and anything on
              it goes away.
            </p>
            <div className="dev-target-buttons">
              <button
                type="button"
                className="dev-target-btn"
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dev-target-btn dev-target-go stop"
                disabled={busy}
                onClick={() => void unpair()}
              >
                Yes, unpair
              </button>
            </div>
          </div>
        ) : (
          <div className="dev-target-buttons">
            <button
              type="button"
              className="dev-target-btn"
              disabled={busy}
              onClick={() => {
                setError(null);
                setDone(null);
                setAsking(true);
              }}
            >
              Unpair
            </button>
          </div>
        )
      ) : null}
    </>
  );
}

/* --- Customer approves each sale (T203) -------------------------------
 *
 * Phase 2.5 item 4's setting, in the drawer for the reason T89's target
 * is: it is a studio-wide policy with nowhere else to live, and a
 * redeploy is the wrong price for changing one. It is shown to everyone
 * and switched only by a named admin (POS_ADMIN_STAFF_IDS), because
 * turning it OFF stays admin-only (design doc, Scene 2).
 *
 * It is the THIRD recorded exception to "nothing in this drawer may
 * loosen a write rail", and like the other two it is safe in only one
 * direction: with it on, /api/checkout refuses MORE charges, never
 * fewer. Dry run and the write guard are still not here.
 */

interface ConfirmInfo {
  customerConfirmsSale: boolean;
  customerConfirmsSaleSource: string;
  envVar: string;
  configured: boolean;
  available: boolean;
}

function ConfirmSalePanel({
  open,
  admin,
}: {
  open: boolean;
  admin: boolean;
}) {
  const [info, setInfo] = useState<ConfirmInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      /* Everyone reads the line from /api/config, which needs no admin;
       * an admin reads the fuller answer, which says whether there is a
       * store to write to. */
      const res = await fetch(admin ? "/api/admin/customer-confirms" : "/api/config");
      if (!res.ok) return;
      const body = await res.json();
      setInfo({
        customerConfirmsSale: body.customerConfirmsSale === true,
        customerConfirmsSaleSource: String(
          body.customerConfirmsSaleSource ?? "env",
        ),
        envVar: String(body.envVar ?? "POS_CUSTOMER_CONFIRMS_SALE"),
        configured: body.configured !== false,
        available: body.available !== false,
      });
    } catch {
      /* The block stays quiet; nothing else depends on it. */
    } finally {
      setLoaded(true);
    }
  }, [admin]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const setTo = async (next: boolean) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/admin/customer-confirms", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(String(body?.error ?? `HTTP ${res.status}`));
        return;
      }
      setAsking(false);
      setDone(
        next
          ? "On. Every sale now waits for the customer to approve it, or for a teacher's PIN."
          : "Off. Charge charges, as before.",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded || info === null) return null;
  const on = info.customerConfirmsSale;
  const stored = info.customerConfirmsSaleSource === "setting";
  return (
    <>
      <div className="dev-label">customer approves each sale</div>
      <p className="muted">
        {on ? "On" : "Off"}.{" "}
        {stored
          ? "Stored setting."
          : `From ${info.envVar} in the server environment.`}{" "}
        {on
          ? "The Charge tap puts the ticket on the customer screen first, and the server refuses a charge the customer has not approved. A teacher's PIN stands in when the screen cannot be used."
          : "Charge charges, and the customer screen shows the ticket and the thank you only."}
      </p>
      {done ? <p className="dev-changed">{done}</p> : null}
      {error ? <p className="dev-target-error">{error}</p> : null}
      {admin ? (
        !info.configured || !info.available ? (
          <p className="muted">
            {info.configured
              ? `The database is not answering, so ${info.envVar} in the server environment decides and this cannot be changed here.`
              : `No database configured (DATABASE_URL unset), so ${info.envVar} in the server environment decides and this cannot be changed here.`}
          </p>
        ) : asking ? (
          <div className="dev-target-ask">
            <p className="dev-target-question">
              {on
                ? "Stop asking the customer to approve each sale?"
                : "Ask the customer to approve every sale on their screen?"}
            </p>
            <div className="dev-target-buttons">
              <button
                type="button"
                className="dev-target-btn"
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dev-target-btn dev-target-go"
                disabled={busy}
                onClick={() => void setTo(!on)}
              >
                {busy ? "Saving" : on ? "Yes, turn it off" : "Yes, turn it on"}
              </button>
            </div>
          </div>
        ) : (
          <div className="dev-target-buttons">
            <button
              type="button"
              className="dev-target-btn"
              disabled={busy}
              onClick={() => {
                setError(null);
                setDone(null);
                setAsking(true);
              }}
            >
              {on ? "Turn off approvals" : "Turn on approvals"}
            </button>
          </div>
        )
      ) : null}
    </>
  );
}

/* --- Membership needs a customer signature (T205) ---------------------
 *
 * Phase 2.5 item 6's setting, beside the one above and reading the same
 * way, because the two are one policy about one screen. Shown to
 * everyone, switched only by a named admin (POS_ADMIN_STAFF_IDS).
 *
 * It is the FOURTH recorded exception to "nothing in this drawer may
 * loosen a write rail", and it is safe in the same one direction: with
 * it on, /api/purchase-contract refuses MORE memberships, never fewer.
 * Turning it OFF is what needs an admin. Dry run and the write guard are
 * still not here.
 */

interface ContractSignatureInfo {
  contractRequiresSignature: boolean;
  contractRequiresSignatureSource: string;
  envVar: string;
  configured: boolean;
  available: boolean;
}

function ContractSignaturePanel({
  open,
  admin,
}: {
  open: boolean;
  admin: boolean;
}) {
  const [info, setInfo] = useState<ContractSignatureInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      /* Everyone reads the line from /api/config; an admin reads the
       * fuller answer, which says whether there is a store to write
       * to. */
      const res = await fetch(
        admin ? "/api/admin/contract-signature" : "/api/config",
      );
      if (!res.ok) return;
      const body = await res.json();
      setInfo({
        contractRequiresSignature: body.contractRequiresSignature === true,
        contractRequiresSignatureSource: String(
          body.contractRequiresSignatureSource ?? "env",
        ),
        envVar: String(body.envVar ?? "POS_CONTRACT_REQUIRES_SIGNATURE"),
        configured: body.configured !== false,
        available: body.available !== false,
      });
    } catch {
      /* The block stays quiet; nothing else depends on it. */
    } finally {
      setLoaded(true);
    }
  }, [admin]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const setTo = async (next: boolean) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/admin/contract-signature", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(String(body?.error ?? `HTTP ${res.status}`));
        return;
      }
      setAsking(false);
      setDone(
        next
          ? "On. A membership now needs the customer's signature on their screen, or a teacher's PIN."
          : "Off. A membership sells as it did before, with no signature.",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded || info === null) return null;
  const on = info.contractRequiresSignature;
  const stored = info.contractRequiresSignatureSource === "setting";
  return (
    <>
      <div className="dev-label">membership needs a signature</div>
      <p className="muted">
        {on ? "On" : "Off"}.{" "}
        {stored
          ? "Stored setting."
          : `From ${info.envVar} in the server environment (unset means on).`}{" "}
        {on
          ? "The membership dialog puts the contract on the customer screen to sign, and the server refuses a membership nobody signed. A teacher's PIN stands in when the screen cannot be used."
          : "A membership sells with no signature asked for, and the customer screen is not used."}
      </p>
      {done ? <p className="dev-changed">{done}</p> : null}
      {error ? <p className="dev-target-error">{error}</p> : null}
      {admin ? (
        !info.configured || !info.available ? (
          <p className="muted">
            {info.configured
              ? `The database is not answering, so ${info.envVar} in the server environment decides and this cannot be changed here.`
              : `No database configured (DATABASE_URL unset), so ${info.envVar} in the server environment decides and this cannot be changed here.`}
          </p>
        ) : asking ? (
          <div className="dev-target-ask">
            <p className="dev-target-question">
              {on
                ? "Stop asking the customer to sign a membership contract?"
                : "Ask the customer to sign every membership contract on their screen?"}
            </p>
            <div className="dev-target-buttons">
              <button
                type="button"
                className="dev-target-btn"
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dev-target-btn dev-target-go"
                disabled={busy}
                onClick={() => void setTo(!on)}
              >
                {busy ? "Saving" : on ? "Yes, turn it off" : "Yes, turn it on"}
              </button>
            </div>
          </div>
        ) : (
          <div className="dev-target-buttons">
            <button
              type="button"
              className="dev-target-btn"
              disabled={busy}
              onClick={() => {
                setError(null);
                setDone(null);
                setAsking(true);
              }}
            >
              {on ? "Turn off signatures" : "Turn on signatures"}
            </button>
          </div>
        )
      ) : null}
    </>
  );
}

/* --- What happens when a student signs themselves up (T207) -----------
 *
 * Beside the two above, and deliberately not one of them. The settings
 * above are the third and fourth recorded exceptions to "nothing in this
 * drawer may loosen a write rail", and each is safe in only one
 * direction. This one is an ORDINARY setting: automatic and review make
 * the same three writes (/api/client-create, /api/book, /api/checkin)
 * from the same browser under the same teacher's token and the same dry
 * run and write guard, and all it decides is whether a teacher taps
 * before a create their iPad would make anyway. No server route reads
 * it to refuse anything.
 *
 * It is admin-edited all the same, for the reason the other two are: it
 * is a studio-wide policy, and a studio should know who changed it.
 */

interface SignupModeInfo {
  signupMode: string;
  signupModeSource: string;
  envVar: string;
  configured: boolean;
  available: boolean;
}

function SignupModePanel({ open, admin }: { open: boolean; admin: boolean }) {
  const [info, setInfo] = useState<SignupModeInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      /* Everyone reads the line from /api/config; an admin reads the
       * fuller answer, which says whether there is a store to write
       * to. */
      const res = await fetch(admin ? "/api/admin/signup-mode" : "/api/config");
      if (!res.ok) return;
      const body = await res.json();
      setInfo({
        signupMode: body.signupMode === "review" ? "review" : "automatic",
        signupModeSource: String(body.signupModeSource ?? "env"),
        envVar: String(body.envVar ?? "POS_SIGNUP_MODE"),
        configured: body.configured !== false,
        available: body.available !== false,
      });
    } catch {
      /* The block stays quiet; nothing else depends on it. */
    } finally {
      setLoaded(true);
    }
  }, [admin]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const setTo = async (next: "automatic" | "review") => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/admin/signup-mode", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(String(body?.error ?? `HTTP ${res.status}`));
        return;
      }
      setAsking(false);
      setDone(
        next === "automatic"
          ? "Automatic. A finished sign-up is created and booked into the class on screen with no tap."
          : "Review. A finished sign-up waits in the tray for a teacher to tap Create.",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded || info === null) return null;
  const automatic = info.signupMode !== "review";
  const stored = info.signupModeSource === "setting";
  const next = automatic ? "review" : "automatic";
  return (
    <>
      <div className="dev-label">customer screen sign-ups</div>
      <p className="muted">
        {automatic ? "Automatic" : "Review"}.{" "}
        {stored
          ? "Stored setting."
          : `From ${info.envVar} in the server environment (unset means automatic).`}{" "}
        {automatic
          ? "A student who finishes signing up is created here, booked into the class on screen, and checked in, with no tap. A name only stays in the tray when a person is needed."
          : "A student who finishes signing up waits in the tray until a teacher taps Create."}
      </p>
      {done ? <p className="dev-changed">{done}</p> : null}
      {error ? <p className="dev-target-error">{error}</p> : null}
      {admin ? (
        !info.configured || !info.available ? (
          <p className="muted">
            {info.configured
              ? `The database is not answering, so ${info.envVar} in the server environment decides and this cannot be changed here.`
              : `No database configured (DATABASE_URL unset), so ${info.envVar} in the server environment decides and this cannot be changed here.`}
          </p>
        ) : asking ? (
          <div className="dev-target-ask">
            <p className="dev-target-question">
              {automatic
                ? "Hold every sign-up in the tray until a teacher taps Create?"
                : "Create and check in every finished sign-up with no tap?"}
            </p>
            <div className="dev-target-buttons">
              <button
                type="button"
                className="dev-target-btn"
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dev-target-btn dev-target-go"
                disabled={busy}
                onClick={() => void setTo(next)}
              >
                {busy
                  ? "Saving"
                  : automatic
                    ? "Yes, review each one"
                    : "Yes, do it automatically"}
              </button>
            </div>
          </div>
        ) : (
          <div className="dev-target-buttons">
            <button
              type="button"
              className="dev-target-btn"
              disabled={busy}
              onClick={() => {
                setError(null);
                setDone(null);
                setAsking(true);
              }}
            >
              {automatic ? "Switch to review" : "Switch to automatic"}
            </button>
          </div>
        )
      ) : null}
    </>
  );
}

/* --- Mindbody target (T89) --------------------------------------------
 *
 * The one setting in this tab that is NOT stored in the browser: which
 * studio the counter talks to, stored server-side in app_settings and
 * switched through PUT /api/admin/target, which is gated by the device
 * session, the devtools flag, a signed-in teacher and both credential
 * sets being present in the server environment.
 *
 * Pete asked for it ("flip between sandbox and prod with a setting
 * rather than a redeploy") and, told this relaxes the rail that kept
 * write-reaching decisions out of the drawer, said "go". Dry run and the
 * write guard did NOT come with it, and the block says so in a line:
 * switching to prod lands in dry run unless the deployment turned it
 * off, which is the whole point of keeping them in the environment.
 */

interface TargetInfo {
  target: string;
  targetSource: string;
  siteId: string | null;
  dryRun: boolean;
  /** T111: "env" or "browser", so the panel can say WHOSE dry run it is.
   *  /api/admin/target has served it since T89. */
  dryRunSource?: string | null;
  configured: boolean;
  available: boolean;
  targets: { target: string; siteId: string | null; missing: string[] }[];
}

const studioWord = (t: string) => (t === "prod" ? "Production" : "Sandbox");

function TargetPanel({
  open,
  onSwitched,
}: {
  /** As SettingsPanel: re-read whenever the drawer opens, never from a
   *  mount that may predate the teacher who is looking at it. */
  open: boolean;
  onSwitched: (next: string, notice: string) => void;
}) {
  const [info, setInfo] = useState<TargetInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** The target the confirm is asking about, or null for no question. */
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/target");
      if (!res.ok) {
        setLoaded(true);
        return;
      }
      setInfo((await res.json()) as TargetInfo);
    } catch {
      /* The block stays quiet; the banner still says where we are. */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const other =
    info === null ? null : info.target === "prod" ? "sandbox" : "prod";
  const otherReady =
    info === null || other === null
      ? null
      : (info.targets.find((t) => t.target === other) ?? null);
  const missing = otherReady?.missing ?? [];

  const switchTo = async (next: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/admin/target", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.switched !== true) {
        setError(String(body?.error ?? `HTTP ${res.status}`));
        if (body?.target) setInfo(body as TargetInfo);
        return;
      }
      setInfo(body as TargetInfo);
      setAsking(null);
      setDone(
        `Switched to ${studioWord(next).toLowerCase()} site ${body.siteId ?? "?"}. ` +
          "Every teacher signs in again.",
      );
      onSwitched(
        next,
        `The studio target changed to ${next}. Sign in again.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <p className="muted">Loading the target.</p>;
  if (info === null) {
    return (
      <p className="muted">
        The target cannot be read here. The banner above still names it.
      </p>
    );
  }

  return (
    <>
      <div className="dev-label">mindbody target</div>
      <p className="dev-target-now">
        {studioWord(info.target)} site {info.siteId ?? "not configured"}.{" "}
        {info.targetSource === "setting"
          ? "Stored setting."
          : "From MINDBODY_TARGET in the server environment."}
      </p>
      <p className="muted">
        {/* T111: the source too, not just on or off, since the banner that
            used to name it is gone in the ordinary production state. */}
        Dry run is{" "}
        {info.dryRun
          ? info.dryRunSource === "browser"
            ? "on for this iPad only"
            : "on for the whole server"
          : "off"}
        . Dry run and the write guard
        stay in the server environment and this switch cannot change them, so
        a switch to production still writes nothing until POS_DRY_RUN=false is
        deployed.
      </p>
      {!info.configured || !info.available ? (
        <p className="muted">
          {info.configured
            ? "The database is configured but not answering, so the target cannot be switched here; MINDBODY_TARGET in the server environment decides."
            : "No database configured (DATABASE_URL unset), so MINDBODY_TARGET in the server environment decides and the target cannot be switched here."}
        </p>
      ) : missing.length > 0 && other !== null ? (
        <p className="muted">
          Cannot switch to {other}: the server environment is missing{" "}
          {missing.join(", ")}.
        </p>
      ) : null}
      {done ? <p className="dev-changed">{done}</p> : null}
      {error ? <p className="dev-target-error">{error}</p> : null}
      {other !== null && asking === other ? (
        <div className="dev-target-ask">
          <p className="dev-target-question">
            Switch this counter to {other.toUpperCase()}? Every teacher signs
            in again.
          </p>
          <div className="dev-target-buttons">
            <button
              type="button"
              className="dev-target-btn"
              disabled={busy}
              onClick={() => setAsking(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={
                other === "prod"
                  ? "dev-target-btn dev-target-go stop"
                  : "dev-target-btn dev-target-go"
              }
              disabled={busy}
              onClick={() => void switchTo(other)}
            >
              {busy ? "Switching" : `Yes, switch to ${other}`}
            </button>
          </div>
        </div>
      ) : other !== null ? (
        <div className="dev-target-buttons">
          <button
            type="button"
            className="dev-target-btn"
            disabled={
              busy || missing.length > 0 || !info.configured || !info.available
            }
            onClick={() => {
              setError(null);
              setDone(null);
              setAsking(other);
            }}
          >
            Switch to {other}
          </button>
        </div>
      ) : null}
    </>
  );
}

/* --- Dry run on this iPad (T89) ---------------------------------------
 *
 * A dry run for ONE browser, in a cookie the server reads per request. It
 * can only ADD suppression: the server's POS_DRY_RUN being on wins (the
 * control then reads as forced on) and the sandbox forces both off, so
 * the worst this can do is stop this iPad writing. That is why it is
 * visible to anyone with the drawer while the target switch is not: one
 * only ever makes the counter safer, the other decides which studio a
 * real write lands in.
 */

const DRY_RUN_COOKIE = "pos_dry_run";

function BrowserDryRun({
  mode,
  onChange,
}: {
  mode: {
    dryRun: boolean;
    dryRunSource: string | null;
    target: string;
  } | null;
  onChange: () => void;
}) {
  if (mode === null) return null;
  const forced = mode.dryRun && mode.dryRunSource === "env";
  const sandbox = mode.target === "sandbox";
  const on = mode.dryRunSource === "browser";
  const set = (next: boolean) => {
    try {
      document.cookie = next
        ? `${DRY_RUN_COOKIE}=1; path=/; max-age=31536000; samesite=lax`
        : `${DRY_RUN_COOKIE}=; path=/; max-age=0; samesite=lax`;
    } catch {
      /* Cookies disabled: nothing changes, and the next read says so. */
    }
    onChange();
  };
  return (
    <>
      <div className="dev-label">dry run on this iPad</div>
      <p className="muted">
        {sandbox
          ? "The sandbox never suppresses writes, here or in the server environment: that is what a sandbox is for."
          : forced
            ? "Forced on for the whole server by POS_DRY_RUN. Nothing this browser does can turn it off."
            : on
              ? "On for this browser only. Writes from this iPad are logged and suppressed; every other iPad still writes."
              : "Off. Writes from this iPad reach Mindbody. Turning this on suppresses them for this browser only."}
      </p>
      <div className="dev-target-buttons">
        <button
          type="button"
          className={on ? "dev-target-btn dev-target-go" : "dev-target-btn"}
          disabled={forced || sandbox}
          onClick={() => set(!on)}
        >
          {on ? "Turn off dry run here" : "Turn on dry run here"}
        </button>
      </div>
    </>
  );
}

/* T70: the sun toggle in the top bar stores light or dark; this is the
 * one place to hand the choice back to the iPad's own setting. */
function ThemeSetting() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => {
    setChoice(readThemeChoice());
  }, []);
  return (
    <label className="dev-setting">
      <span className="dev-setting-label">
        theme
        <span className="muted">
          {" "}
          system follows the iPad; the sun icon in the top bar stores light
          or dark
        </span>
      </span>
      <select
        value={choice}
        onChange={(e) => {
          const next = e.target.value as ThemeChoice;
          setThemeChoice(next);
          setChoice(next);
        }}
      >
        <option value="system">system</option>
        <option value="light">light</option>
        <option value="dark">dark</option>
      </select>
    </label>
  );
}

/* T49: the signed-in teacher and the permission probe, so what a
 * teacher's Mindbody login can do is checkable from the drawer as well
 * as from the sign-in modal. Reads the same two routes. */
function TeacherPanel() {
  const [teacher, setTeacher] = useState<Teacher | null | undefined>(
    undefined,
  );
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/teacher")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live) setTeacher(body?.teacher ?? null);
      })
      .catch(() => {
        if (live) setTeacher(null);
      });
    return () => {
      live = false;
    };
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/teacher/probe");
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (body?.staffSessionEnded) setTeacher(null);
        setError(String(body?.error ?? `HTTP ${res.status}`));
        setProbe(null);
        return;
      }
      setProbe(body as ProbeResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="dev-label">signed-in teacher</div>
      {teacher === undefined ? (
        <p className="muted">Loading.</p>
      ) : teacher === null ? (
        <p className="muted">
          Nobody. Writes run as the studio account; sign in from the header
          to run them as a teacher.
        </p>
      ) : (
        <>
          <p className="muted">
            {teacher.name} (staff {teacher.id}). Writes carry actor=
            {teacher.id} in the calls tab.
          </p>
          <ProbeView probe={probe} busy={busy} error={error} onRun={run} />
        </>
      )}
    </>
  );
}

/* --- Bundles tab (T29) -----------------------------------------------
 * The minimal admin surface for database bundles and the banner text,
 * living here because the drawer is already PIN-gated and devtools-gated,
 * which is the right audience for now (a proper admin surface outside the
 * dev drawer is recorded future work on T29). Everything talks to
 * /api/admin/bundles and /api/admin/banner, which 404 without devtools
 * exactly like /api/devlog, so this tab is inert wherever the drawer is.
 */

/** Mirrors src/lib/bundles.ts BundleLine; re-declared rather than
 *  imported, like SaleScreen's ShelfBundle, so no server module is pulled
 *  into the client bundle. */
interface AdminBundleLine {
  type: "Product" | "Service";
  id: string | number;
  quantity: number;
}

/** A bundles row as /api/admin/bundles serves it. */
interface AdminBundle {
  id: number;
  name: string;
  lines: AdminBundleLine[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The slice of a catalog item the picker needs. */
interface PickerItem {
  type: "Product" | "Service";
  id: string | number;
  name: string;
  price: number;
}

function BundlesPanel() {
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [bundles, setBundles] = useState<AdminBundle[]>([]);
  const [items, setItems] = useState<PickerItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  /* Create form. */
  const [name, setName] = useState("");
  const [lines, setLines] = useState<AdminBundleLine[]>([]);
  const [pick, setPick] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [saving, setSaving] = useState(false);

  /* Banner field. */
  const [bannerDb, setBannerDb] = useState<string | null>(null);
  const [bannerEnv, setBannerEnv] = useState<string | null>(null);
  const [bannerDraft, setBannerDraft] = useState("");
  const [bannerBusy, setBannerBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bundles");
      if (!res.ok) {
        setLoaded(true);
        setAvailable(false);
        return;
      }
      const body = await res.json();
      setAvailable(Boolean(body.available));
      setConfigured(Boolean(body.configured));
      setBundles(body.bundles ?? []);
      setLoaded(true);
    } catch {
      setLoaded(true);
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    fetch("/api/catalog")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!body) return;
        const all = [
          ...(body.products ?? []),
          ...(body.passes ?? []),
          ...(body.packages ?? []),
        ] as PickerItem[];
        setItems(all);
      })
      .catch(() => undefined);
    fetch("/api/admin/banner")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!body) return;
        setBannerDb(body.dbText ?? null);
        setBannerEnv(body.envText ?? null);
        setBannerDraft(body.dbText ?? "");
      })
      .catch(() => undefined);
  }, [refresh]);

  const itemKeyOf = (type: string, id: string | number) => `${type}:${id}`;
  const nameOf = useCallback(
    (line: AdminBundleLine): string => {
      const item = items.find(
        (i) => i.type === line.type && String(i.id) === String(line.id),
      );
      return item ? item.name : `${line.type} ${line.id} (not in catalog)`;
    },
    [items],
  );

  const addLine = () => {
    const item = items.find((i) => itemKeyOf(i.type, i.id) === pick);
    if (!item) return;
    setLines((prev) => {
      const have = prev.find(
        (l) => l.type === item.type && String(l.id) === String(item.id),
      );
      if (have) {
        return prev.map((l) =>
          l === have
            ? { ...l, quantity: Math.min(l.quantity + quantity, 99) }
            : l,
        );
      }
      return [
        ...prev,
        { type: item.type, id: item.id, quantity: Math.min(quantity, 99) },
      ];
    });
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), lines }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? `create failed (${res.status})`);
      } else {
        setName("");
        setLines([]);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (bundle: AdminBundle) => {
    setError(null);
    try {
      const res = await fetch("/api/admin/bundles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: bundle.id, enabled: !bundle.enabled }),
      });
      const body = await res.json();
      if (!res.ok) setError(body?.error ?? `update failed (${res.status})`);
      else await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveBanner = async (text: string | null) => {
    setBannerBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/banner", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? `banner save failed (${res.status})`);
      } else {
        setBannerDb(body.dbText ?? null);
        setBannerDraft(body.dbText ?? "");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBannerBusy(false);
    }
  };

  if (!loaded) return <p className="muted">Loading.</p>;

  if (!available) {
    return (
      <div className="dev-settings">
        <p className="muted">
          {configured
            ? "Database configured but not reachable; bundles come from src/lib/bundles.ts and the banner from POS_BANNER_TEXT until it answers."
            : "No database configured (DATABASE_URL unset). Bundles come from src/lib/bundles.ts and the banner from POS_BANNER_TEXT. See docker-compose.yml to run one locally."}
        </p>
      </div>
    );
  }

  return (
    <div className="dev-settings">
      <p className="muted">
        Database bundles, served to the Favorites shelf when this table has
        rows (enabled ones only); otherwise src/lib/bundles.ts. Ids are per
        site: a line that does not resolve against the loaded catalog drops
        its whole bundle at render, with a console warning.
      </p>
      {error ? <p className="dev-bad">{error}</p> : null}

      {bundles.length === 0 ? (
        <p className="muted">No bundles stored yet.</p>
      ) : (
        bundles.map((b) => (
          <div key={b.id} className="dev-setting">
            <span className="dev-setting-label">
              {b.name}
              <span className="muted">
                {" "}
                {b.lines
                  .map((l) => `${l.quantity} x ${nameOf(l)}`)
                  .join(", ")}
              </span>
            </span>
            <label className="dev-bundle-toggle">
              <span className="muted">{b.enabled ? "enabled" : "disabled"}</span>
              <input
                type="checkbox"
                checked={b.enabled}
                onChange={() => void toggle(b)}
              />
            </label>
          </div>
        ))
      )}

      <div className="dev-label">new bundle</div>
      <div className="dev-setting">
        <input
          type="text"
          className="dev-text"
          placeholder="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="dev-setting">
        <select
          className="dev-text"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
        >
          <option value="">pick a catalog item</option>
          {items.map((i) => (
            <option key={itemKeyOf(i.type, i.id)} value={itemKeyOf(i.type, i.id)}>
              {i.name} (${i.price.toFixed(2)})
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={99}
          step={1}
          value={String(quantity)}
          onChange={(e) =>
            setQuantity(Math.max(1, Math.min(99, Number(e.target.value) || 1)))
          }
        />
        <button onClick={addLine} disabled={pick === ""}>
          add line
        </button>
      </div>
      {lines.map((l) => (
        <div key={itemKeyOf(l.type, l.id)} className="dev-setting">
          <span className="dev-setting-label">
            {l.quantity} x {nameOf(l)}
          </span>
          <button
            onClick={() =>
              setLines((prev) =>
                prev.filter(
                  (x) => itemKeyOf(x.type, x.id) !== itemKeyOf(l.type, l.id),
                ),
              )
            }
          >
            remove
          </button>
        </div>
      ))}
      <div className="dev-setting">
        <button
          onClick={() => void create()}
          disabled={saving || name.trim().length === 0 || lines.length === 0}
        >
          {saving ? "creating" : "create bundle"}
        </button>
        <span className="muted">
          No delete: disable is the safe verb, and a disabled bundle keeps
          its lines.
        </span>
      </div>

      <div className="dev-label">studio banner</div>
      <p className="muted">
        Stored in app_settings and shown on the counter and lock screens.
        Clearing falls back to POS_BANNER_TEXT
        {bannerEnv ? ` (currently "${bannerEnv}")` : " (currently unset)"}.
      </p>
      <div className="dev-setting">
        <input
          type="text"
          className="dev-text"
          placeholder="banner text"
          value={bannerDraft}
          onChange={(e) => setBannerDraft(e.target.value)}
        />
        <button
          onClick={() => void saveBanner(bannerDraft)}
          disabled={bannerBusy || bannerDraft.trim().length === 0}
        >
          save
        </button>
        <button
          onClick={() => void saveBanner(null)}
          disabled={bannerBusy || bannerDb === null}
        >
          clear
        </button>
      </div>
    </div>
  );
}

/* --- Shelf tab (T74) -------------------------------------------------
 * The admin surface for the shelf config: which catalog items never
 * reach the shelf, and which pass sub-category each pricing option files
 * under. Same audience and gates as the Bundles tab (PIN, then devtools),
 * same density, nothing teacher-facing. Talks to /api/admin/shelf, which
 * 404s without devtools exactly like /api/devlog.
 *
 * One Save writes the whole config; nothing here is seeded, Pete hides
 * and groups what he wants himself.
 */

/** Mirrors src/lib/shelfconfig.ts, re-declared like the bundle shapes so
 *  no server module is pulled into the client bundle. */
interface ShelfAdminItem {
  type: "Product" | "Service" | "Package" | "Contract" | "GiftCard";
  id: string | number;
  key: string;
  name: string;
  price: number;
  /** Where the counter files it as saved (the route computes it the
   *  way /api/catalog does); absent from a pre-placement answer. */
  placement?: string;
  /** T97, gift cards only: the custom amount product, which the number
   *  pad sells any amount through, so it carries no hide toggle. */
  editable?: boolean;
}

interface ShelfAdminGroup {
  label: string;
  ids: string[];
}

/** T112: mirrors shelfconfig.ts PassSubstitute. */
interface ShelfAdminSubstitute {
  refusedId: string;
  substituteId: string;
  matchPrice: boolean;
}

interface ShelfAdminConfig {
  hidden: string[];
  groups: ShelfAdminGroup[];
  /** T86: the pass sub-categories in rail order. */
  groupOrder?: string[];
  /** T86: retail products moved to another counter category. */
  products?: { key: string; categoryId: number }[];
  /** T112: the substitute a refused pass may be sold as. */
  substitutes?: ShelfAdminSubstitute[];
}

/** T76: the rail's fixed pass sub-categories, mirrored from
 *  src/lib/shelfconfig.ts PASS_GROUPS (re-declared for the same reason
 *  as the shapes above). The select offers these first: choosing one
 *  for a pass files it there over the rule, through a group of that
 *  label, created on the spot when none exists yet. */
const FIXED_PASS_GROUPS = [
  "Drop-in & Packs",
  "Specials",
  "Teen/Child",
  "Buddy/Guest",
  "Trainings",
  "Workshops",
  "Fees",
  "Unlimited",
];

/** Mirrors shelfconfig PINNED_PASS_CHILDREN for the same reason. */
const PINNED_PASS_CHILDREN = ["Packages", "Memberships"];

const isFixedLabel = (label: string) =>
  FIXED_PASS_GROUPS.some((g) => g.toLowerCase() === label.trim().toLowerCase());

/** A label folded onto the fixed one it names, mirroring shelfconfig's
 *  `canonicalGroupLabel` so the block below shows the order the rail
 *  will draw and not a second cell of the same name. */
const canonLabel = (label: string) => {
  const folded = label.trim().toLowerCase();
  /* The label that group shipped with before the T76 rename, folded here
   * too (T86 review) because shelfconfig folds it: without this the block
   * drew a ninth "Buddy / Guest Passes custom" row for a group the rail
   * files under Buddy/Guest, and moving that row did nothing. */
  if (folded === "buddy / guest passes") return "Buddy/Guest";
  return (
    FIXED_PASS_GROUPS.find((g) => g.toLowerCase() === folded) ?? label.trim()
  );
};

/** T86: the counter categories a retail product may be moved to,
 *  mirrored from src/lib/categories.ts `counterCategories` (the Retail
 *  children and Rentals; the Passes entry carries no ids and a product
 *  has no business there). Keyed by Mindbody's category id, which is
 *  what the config stores. */
const PRODUCT_CATEGORIES: { label: string; categoryId: number }[] = [
  { label: "Food/Drink", categoryId: 36 },
  { label: "Clothing", categoryId: 26 },
  { label: "Accessories", categoryId: 32 },
  { label: "Other", categoryId: 49 },
  { label: "Rentals", categoryId: -14 },
];

const SHELF_KINDS: { type: ShelfAdminItem["type"]; heading: string }[] = [
  { type: "Service", heading: "passes" },
  { type: "Product", heading: "products" },
  { type: "Package", heading: "packages" },
  { type: "Contract", heading: "memberships (contracts)" },
  /* T97: the gift cards the site sells, which are the preset amounts on
   * the Buy screen. Pete: "the app should only have these preset options
   * + the custom amount one". */
  { type: "GiftCard", heading: "gift cards" },
];

function ShelfPanel() {
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<ShelfAdminItem[]>([]);
  /* T97: why the gift cards section is empty, when it is. Its read is the
   * route's own try, so a site with gift cards turned off still gets the
   * rest of this tab. */
  const [giftCardError, setGiftCardError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<ShelfAdminGroup[]>([]);
  /* T86: the stored sub-category order, and the product moves by item
   * key. Both are whatever the config holds; the order block below
   * derives the EFFECTIVE order from this plus the labels that exist. */
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [moves, setMoves] = useState<Record<string, number>>({});
  /* T112: the pass substitutions, edited as rows. */
  const [subs, setSubs] = useState<ShelfAdminSubstitute[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<
    { ok: true; text: string } | { ok: false; text: string } | null
  >(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/shelf");
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(String(body?.error ?? `HTTP ${res.status}`));
        setLoaded(true);
        return;
      }
      setAvailable(Boolean(body.available));
      setConfigured(Boolean(body.configured));
      setItems(body.items ?? []);
      setGiftCardError(
        typeof body.giftCardError === "string" ? body.giftCardError : null,
      );
      const config: ShelfAdminConfig = body.config ?? { hidden: [], groups: [] };
      /* T97 review: a stored key naming the custom amount product is
       * dropped HERE, on the way into the tab. The PUT refuses that key,
       * and one can still be stored (a save made while /sale/giftcards was
       * down cannot know which product is editable), so without this the
       * tab would carry the key back on every Save and the Shelf tab could
       * never be saved again, with no toggle to clear it. The key hides
       * nothing either way (`giftCardHidden`), so dropping it loses
       * nothing. A row the read did not return is left alone: unknown is
       * not the same as editable. */
      const editableKeys = new Set(
        ((body.items ?? []) as ShelfAdminItem[])
          .filter((i) => i.type === "GiftCard" && i.editable === true)
          .map((i) => i.key),
      );
      setHidden(
        new Set((config.hidden ?? []).filter((k) => !editableKeys.has(k))),
      );
      setGroups((config.groups ?? []).map((g) => ({ ...g, ids: [...g.ids] })));
      setGroupOrder([...(config.groupOrder ?? [])]);
      setMoves(
        Object.fromEntries(
          (config.products ?? []).map((o) => [o.key, o.categoryId]),
        ),
      );
      setSubs((config.substitutes ?? []).map((x) => ({ ...x })));
      setLoadError(null);
      setLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* The select's value is the group's INDEX, not its label: a label is
   * being typed while the select is live, so it can be empty (the same
   * value as None) or momentarily equal to another group's. */
  const groupOf = (id: string | number): string => {
    const index = groups.findIndex((g) => g.ids.includes(String(id)));
    return index < 0 ? "" : String(index);
  };

  /* T76: a fixed label is offered whether or not a group of that name
   * exists yet; picking one creates the group when it must. The value
   * "fixed:<label>" names it; an existing group of that label (any
   * case) is reused, so the two options never diverge. */
  const setGroupOf = (id: string | number, value: string) => {
    const key = String(id);
    setGroups((prev) => {
      let index = value;
      let next = prev;
      if (value.startsWith("fixed:")) {
        const label = value.slice("fixed:".length);
        const found = prev.findIndex(
          (g) => g.label.trim().toLowerCase() === label.toLowerCase(),
        );
        if (found < 0) {
          next = [...prev, { label, ids: [] }];
          index = String(next.length - 1);
        } else {
          index = String(found);
        }
      }
      return next.map((g, i) => ({
        ...g,
        ids:
          String(i) === index
            ? g.ids.includes(key)
              ? g.ids
              : [...g.ids, key]
            : g.ids.filter((x) => x !== key),
      }));
    });
  };

  /**
   * T86: the sub-category labels in the order the rail will draw them.
   * The candidates are the fixed eight plus every custom group label;
   * the order is what `groupOrder` names first (folded, each once,
   * unknown labels dropped) and then the rest in code order, exactly as
   * applyShelfConfig computes it. One reading for the block below and
   * for what Save sends, so what Pete sees is what gets stored.
   */
  const effectiveOrder = (): string[] => {
    const all = [...FIXED_PASS_GROUPS];
    for (const g of groups) {
      const label = canonLabel(g.label);
      if (label.length > 0 && !all.includes(label)) all.push(label);
    }
    /* Packages and Memberships sit in the same rail and, since Pete
     * asked why they were missing here (2026-09-14), in the same order. */
    for (const label of PINNED_PASS_CHILDREN) if (!all.includes(label)) all.push(label);
    /* Matched case-insensitively, as the server matches it (T86 review):
     * a stored "my label" names the group "My Label", and resolving to
     * the catalog's own spelling is what keeps this block, what Save
     * writes and what the rail draws the same list. */
    const byFold = new Map(all.map((l) => [l.toLowerCase(), l]));
    const named: string[] = [];
    for (const raw of groupOrder) {
      const label = byFold.get(canonLabel(raw).toLowerCase());
      if (label === undefined || named.includes(label)) continue;
      named.push(label);
    }
    return [...named, ...all.filter((l) => !named.includes(l))];
  };

  /* Moving a row stores the WHOLE order, so the list is a permutation
   * from then on and a later render cannot re-sort it. */
  const moveLabel = (index: number, dir: -1 | 1) => {
    const order = effectiveOrder();
    const to = index + dir;
    if (to < 0 || to >= order.length) return;
    const a = order[index];
    const b = order[to];
    if (a === undefined || b === undefined) return;
    order[index] = b;
    order[to] = a;
    setGroupOrder(order);
  };

  /* T86: a product's category override. "" is Mindbody's own category,
   * which drops the entry rather than storing a no-op. */
  const setMove = (key: string, value: string) =>
    setMoves((prev) => {
      const next = { ...prev };
      if (value === "") delete next[key];
      else next[key] = Number(value);
      return next;
    });

  const toggleHidden = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addGroup = () => {
    const label = newLabel.trim();
    if (label.length === 0) return;
    if (groups.some((g) => g.label.toLowerCase() === label.toLowerCase())) {
      setOutcome({ ok: false, text: `"${label}" is already a group` });
      return;
    }
    setGroups((prev) => [...prev, { label, ids: [] }]);
    setNewLabel("");
    setOutcome(null);
  };

  const renameGroup = (index: number, label: string) =>
    setGroups((prev) =>
      prev.map((g, i) => (i === index ? { ...g, label } : g)),
    );

  const moveGroup = (index: number, dir: -1 | 1) =>
    setGroups((prev) => {
      const to = index + dir;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const a = next[index];
      const b = next[to];
      if (!a || !b) return prev;
      next[index] = b;
      next[to] = a;
      return next;
    });

  /* Removing a group ungroups its passes: the ids simply go with it. */
  const removeGroup = (index: number) =>
    setGroups((prev) => prev.filter((_, i) => i !== index));

  const save = async () => {
    setSaving(true);
    setOutcome(null);
    try {
      const config: ShelfAdminConfig = {
        hidden: [...hidden],
        groups: groups.map((g) => ({ label: g.label.trim(), ids: g.ids })),
        /* T86: the order as the block shows it, written out in full, and
         * the product moves. One Save still writes the whole config. */
        groupOrder: effectiveOrder(),
        products: Object.entries(moves).map(([key, categoryId]) => ({
          key,
          categoryId,
        })),
        /* T112: only the complete rows. A half-filled row is a teacher
         * mid-thought, not a mapping, and the route would refuse the
         * whole config over it and take the hide list with it. */
        substitutes: subs.filter(
          (x) => x.refusedId !== "" && x.substituteId !== "" && x.refusedId !== x.substituteId,
        ),
      };
      const res = await fetch("/api/admin/shelf", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setOutcome({
          ok: false,
          text: String(body?.error ?? `save failed (${res.status})`),
        });
        if (body?.available === false) setAvailable(false);
        return;
      }
      /* T86: re-read rather than take the PUT's echo, because the PLACEMENT
       * line is computed server-side over the saved config, and a stale
       * one is worst exactly here: moving a product is a change whose
       * only confirmation IS that line. The GET costs nothing metered
       * (the catalog behind it is the same two-minute cache). */
      await load();
      setOutcome({
        ok: true,
        text: "saved; the shelf shows it on the next catalog load",
      });
    } catch (err) {
      setOutcome({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return <p className="muted">Loading.</p>;

  if (loadError !== null) {
    return (
      <div className="dev-settings">
        <p className="dev-bad">Shelf admin unavailable: {loadError}</p>
      </div>
    );
  }

  const byKind = (type: ShelfAdminItem["type"]) =>
    items.filter((i) => i.type === type);

  return (
    <div className="dev-settings">
      <p className="muted">
        What the Cart screen may sell, and how the Passes shelf is split.
        Hidden items never reach the shelf (a bundle line naming one stops
        rendering, with a console warning). Every pass is filed by rule
        into one of the rail&apos;s fixed sub-categories; a group here
        overrides that for the passes it names, under a fixed label or a
        custom one. The order block below sets the order the rail draws
        those sub-categories in, and a retail product can be moved off
        Mindbody&apos;s own category onto another counter cell. The gift
        cards at the end are the preset amounts the Cart screen offers.
        Ids are per site.
      </p>
      {!available ? (
        <p className="muted">
          {configured
            ? "Database configured but not reachable; the shelf uses the code default (nothing hidden, no groups) until it answers, and this config cannot be saved."
            : "No database configured (DATABASE_URL unset). The shelf uses the code default (nothing hidden, no groups) and this config cannot be saved. See docker-compose.yml to run one locally."}
        </p>
      ) : null}

      <div className="dev-label">pass groups</div>
      {groups.length === 0 ? (
        <p className="muted">No groups: every pass is filed by rule.</p>
      ) : (
        groups.map((g, index) => (
          <div key={index} className="dev-setting">
            <input
              type="text"
              className="dev-text"
              aria-label={`Group ${index + 1} label`}
              value={g.label}
              maxLength={40}
              onChange={(e) => renameGroup(index, e.target.value)}
            />
            <span className="muted">{g.ids.length} passes</span>
            <button
              onClick={() => moveGroup(index, -1)}
              disabled={index === 0}
              aria-label={`Move ${g.label} up`}
            >
              up
            </button>
            <button
              onClick={() => moveGroup(index, 1)}
              disabled={index === groups.length - 1}
              aria-label={`Move ${g.label} down`}
            >
              down
            </button>
            <button
              onClick={() => removeGroup(index)}
              aria-label={`Remove group ${g.label}`}
            >
              remove
            </button>
          </div>
        ))
      )}
      <div className="dev-setting">
        <input
          type="text"
          className="dev-text"
          placeholder="new group label"
          aria-label="New group label"
          value={newLabel}
          maxLength={40}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addGroup();
          }}
        />
        <button onClick={addGroup} disabled={newLabel.trim().length === 0}>
          add group
        </button>
      </div>

      <div className="dev-label">sub-category order</div>
      <p className="muted">
        The order the Passes rail draws its sub-categories in, fixed and
        custom together. A sub-category with nothing to sell is still left
        off the screen.
      </p>
      {effectiveOrder().map((label, index, order) => (
        <div key={label} className="dev-setting dev-order-row">
          <span className="dev-setting-label">
            {label}
            {isFixedLabel(label) ? null : PINNED_PASS_CHILDREN.includes(label) ? (
              <span className="muted"> {label === "Packages" ? "packages" : "contracts"}</span>
            ) : (
              <span className="muted"> custom</span>
            )}
          </span>
          <button
            className="dev-order-move"
            onClick={() => moveLabel(index, -1)}
            disabled={index === 0}
            aria-label={`Move ${label} earlier`}
          >
            <span aria-hidden="true">&#8593;</span>
          </button>
          <button
            className="dev-order-move"
            onClick={() => moveLabel(index, 1)}
            disabled={index === order.length - 1}
            aria-label={`Move ${label} later`}
          >
            <span aria-hidden="true">&#8595;</span>
          </button>
        </div>
      ))}

      {/* T112: the pass substitutions. Pete, on a pass Mindbody's own
          rules refuse: "if that doesn't work then we can use the
          'Returning Student 2-week unlimited' item and discount it to be
          at the standard 2-week special price behind the scenes". It is
          configuration rather than a constant in the code for the reason
          everything else on this tab is: the studio changes its passes.
          Ids only; both prices are read from the live catalog at the
          moment the offer is made, so nothing here can go stale into a
          price. */}
      <div className="dev-label">pass substitutions</div>
      <p className="muted">
        When Mindbody refuses a pass for a client, the Override dialog
        offers to sell another pass in its place. &quot;Match the refused
        pass&apos;s price&quot; discounts the substitute down to what the
        refused pass costs today, so the customer pays the same money for
        the same thing; the ticket, the receipt and Mindbody all say the
        substitute&apos;s name, and the teacher is told so before they tap.
        A row naming a pass the site no longer sells is ignored, loudly, in
        the server log.
      </p>
      {subs.map((row, index) => (
        <div key={index} className="dev-setting dev-sub-row">
          <select
            className="dev-text"
            aria-label="The pass Mindbody refuses"
            value={row.refusedId}
            onChange={(e) =>
              setSubs((prev) =>
                prev.map((r, i) =>
                  i === index ? { ...r, refusedId: e.target.value } : r,
                ),
              )
            }
          >
            <option value="">refused pass</option>
            {byKind("Service").map((item) => (
              <option key={item.key} value={String(item.id)}>
                {item.name} ${item.price.toFixed(2)}
              </option>
            ))}
          </select>
          <span className="muted">sells as</span>
          <select
            className="dev-text"
            aria-label="The pass to sell instead"
            value={row.substituteId}
            onChange={(e) =>
              setSubs((prev) =>
                prev.map((r, i) =>
                  i === index ? { ...r, substituteId: e.target.value } : r,
                ),
              )
            }
          >
            <option value="">substitute pass</option>
            {byKind("Service").map((item) => (
              <option key={item.key} value={String(item.id)}>
                {item.name} ${item.price.toFixed(2)}
              </option>
            ))}
          </select>
          <label className="dev-sub-match">
            <input
              type="checkbox"
              checked={row.matchPrice}
              onChange={(e) =>
                setSubs((prev) =>
                  prev.map((r, i) =>
                    i === index ? { ...r, matchPrice: e.target.checked } : r,
                  ),
                )
              }
            />
            match the refused pass&apos;s price
          </label>
          <button
            onClick={() => setSubs((prev) => prev.filter((_, i) => i !== index))}
            aria-label="Remove this substitution"
          >
            remove
          </button>
        </div>
      ))}
      <div className="dev-setting">
        <button
          onClick={() =>
            setSubs((prev) => [
              ...prev,
              { refusedId: "", substituteId: "", matchPrice: true },
            ])
          }
        >
          add substitution
        </button>
      </div>

      {SHELF_KINDS.map(({ type, heading }) => {
        const list = byKind(type);
        /* T97: the gift cards heading shows even with nothing under it,
         * because the reason it is empty is the useful part. */
        if (list.length === 0 && !(type === "GiftCard" && giftCardError)) {
          return null;
        }
        return (
          <div key={type}>
            <div className="dev-label">{heading}</div>
            {type === "GiftCard" ? (
              giftCardError ? (
                <p className="dev-bad">
                  The gift cards did not read: {giftCardError}
                </p>
              ) : (
                <p className="muted">
                  The preset amounts on the Cart screen. Hiding one takes it
                  off the presets and refuses it at checkout. The custom
                  amount product is the number pad&apos;s and cannot be
                  hidden.
                </p>
              )
            ) : null}
            {list.map((item) => (
              <div key={item.key} className="dev-setting">
                <span className="dev-setting-label">
                  {item.name}
                  {/* T97 review: the custom amount product has no figure
                      of its own, and "$0.00" beside it reads as a card
                      worth nothing. */}
                  {item.editable ? null : (
                    <span className="muted"> ${item.price.toFixed(2)}</span>
                  )}
                  {item.placement ? (
                    <span className="muted dev-shelf-where">
                      {" "}
                      {item.placement}
                    </span>
                  ) : null}
                </span>
                {type === "Service" ? (
                  <select
                    className="dev-text dev-shelf-group"
                    aria-label={`Group for ${item.name}`}
                    value={groupOf(item.id)}
                    onChange={(e) => setGroupOf(item.id, e.target.value)}
                  >
                    <option value="">By rule</option>
                    {FIXED_PASS_GROUPS.map((label) => {
                      const i = groups.findIndex(
                        (g) => g.label.trim().toLowerCase() === label.toLowerCase(),
                      );
                      return (
                        <option
                          key={`fixed:${label}`}
                          value={i < 0 ? `fixed:${label}` : String(i)}
                        >
                          {label}
                        </option>
                      );
                    })}
                    {groups.map((g, i) =>
                      isFixedLabel(g.label) ? null : (
                        <option key={i} value={String(i)}>
                          {g.label || `(group ${i + 1})`}
                        </option>
                      ),
                    )}
                  </select>
                ) : null}
                {type === "Product" ? (
                  <select
                    className="dev-text dev-shelf-group"
                    aria-label={`Category for ${item.name}`}
                    value={
                      moves[item.key] === undefined
                        ? ""
                        : String(moves[item.key])
                    }
                    onChange={(e) => setMove(item.key, e.target.value)}
                  >
                    <option value="">Mindbody&apos;s category</option>
                    {PRODUCT_CATEGORIES.map((c) => (
                      <option key={c.categoryId} value={String(c.categoryId)}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                {type === "GiftCard" && item.editable ? (
                  /* T97: no toggle on the custom amount product. Listed
                   * all the same, so a teacher can see it is there and
                   * why it cannot be turned off. */
                  <span className="muted">custom amount, always on</span>
                ) : (
                  <label className="dev-bundle-toggle">
                    <span className="muted">hidden</span>
                    <input
                      type="checkbox"
                      checked={hidden.has(item.key)}
                      onChange={() => toggleHidden(item.key)}
                    />
                  </label>
                )}
              </div>
            ))}
          </div>
        );
      })}

      <div className="dev-setting">
        <button onClick={() => void save()} disabled={saving || !available}>
          {saving ? "saving" : "Save"}
        </button>
        {outcome ? (
          <span className={outcome.ok ? "muted" : "dev-bad"}>{outcome.text}</span>
        ) : (
          <span className="muted">
            One save writes the whole config: hidden items, every group,
            the sub-category order and the product moves.
          </span>
        )}
      </div>
    </div>
  );
}
