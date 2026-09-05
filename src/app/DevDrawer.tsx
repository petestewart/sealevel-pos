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
  requestBody: string | null;
  responseBody: string | null;
}

function statusClass(call: CallRecord): string {
  if (call.outcome !== "sent") return "dev-suppressed";
  if (call.status === null) return "";
  return call.status >= 400 ? "dev-bad" : "dev-good";
}

export default function DevDrawer() {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  /** Which call id was just copied, for the momentary "copied" label. */
  const [copied, setCopied] = useState<number | "all" | null>(null);
  const [tab, setTab] = useState<"calls" | "settings" | "bundles" | "shelf">(
    "calls",
  );
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
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [available]);

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
        (call.actor !== null ? `  actor=${call.actor}` : ""),
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
      <button
        className="dev-handle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? "close" : "API"} {calls.length}
        {failures > 0 ? <span className="dev-badge">{failures}</span> : null}
      </button>

      <section className={open ? "dev-drawer open" : "dev-drawer"}>
        <header className="dev-head">
          <button
            className={tab === "calls" ? "dev-tab on" : "dev-tab"}
            onClick={() => setTab("calls")}
          >
            calls
          </button>
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
        </header>

        <div className="dev-body">
          {tab === "settings" ? (
            <SettingsPanel settings={settings} set={set} />
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
  { key: "minQueryLength", label: "Minimum query", hint: "letters", min: 1, max: 6, step: 1 },
  { key: "searchLimit", label: "Search results", hint: "max", min: 3, max: 50, step: 1 },
  { key: "hoursBack", label: "Schedule back", hint: "hours", min: 0, max: 12, step: 1 },
  { key: "hoursForward", label: "Schedule forward", hint: "hours", min: 1, max: 24, step: 1 },
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
    hint: "in the attach modal, a query matching nobody in the class turns In class off and searches everyone (T52)",
  },
];

function SettingsPanel({
  settings,
  set,
}: {
  settings: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  /* T29: the one quiet line saying which store is behind the DB features.
   * "none" is full fallback mode and is normal for local work. */
  const [storage, setStorage] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live && body && typeof body.storage === "string") {
          setStorage(body.storage);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="dev-settings">
      <p className="muted">
        Stored in this browser. Applies immediately, no restart. Dry run,
        target and the write guard are server settings and deliberately not
        here.
      </p>
      {storage !== null ? (
        <p className="muted">
          storage: {storage}
          {storage === "none"
            ? " (no DATABASE_URL; bundles, waiver receipts and banner use their fallbacks)"
            : ""}
        </p>
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
  type: "Product" | "Service" | "Package" | "Contract";
  id: string | number;
  key: string;
  name: string;
  price: number;
}

interface ShelfAdminGroup {
  label: string;
  ids: string[];
}

interface ShelfAdminConfig {
  hidden: string[];
  groups: ShelfAdminGroup[];
}

const SHELF_KINDS: { type: ShelfAdminItem["type"]; heading: string }[] = [
  { type: "Service", heading: "passes" },
  { type: "Product", heading: "products" },
  { type: "Package", heading: "packages" },
  { type: "Contract", heading: "memberships (contracts)" },
];

function ShelfPanel() {
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<ShelfAdminItem[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<ShelfAdminGroup[]>([]);
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
      const config: ShelfAdminConfig = body.config ?? { hidden: [], groups: [] };
      setHidden(new Set(config.hidden ?? []));
      setGroups((config.groups ?? []).map((g) => ({ ...g, ids: [...g.ids] })));
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

  const groupOf = (id: string | number): string =>
    groups.find((g) => g.ids.includes(String(id)))?.label ?? "";

  const setGroupOf = (id: string | number, label: string) => {
    const key = String(id);
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        ids:
          g.label === label
            ? g.ids.includes(key)
              ? g.ids
              : [...g.ids, key]
            : g.ids.filter((x) => x !== key),
      })),
    );
  };

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
      const stored: ShelfAdminConfig = body.config ?? config;
      setHidden(new Set(stored.hidden ?? []));
      setGroups((stored.groups ?? []).map((g) => ({ ...g, ids: [...g.ids] })));
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
        What the Buy screen may sell, and how the Passes shelf is split.
        Hidden items never reach the shelf (a bundle line naming one stops
        rendering, with a console warning); pass groups become sub-chips
        over the Passes shelf, in this order. Ids are per site.
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
        <p className="muted">No groups: the Passes shelf is one grid.</p>
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

      {SHELF_KINDS.map(({ type, heading }) => {
        const list = byKind(type);
        if (list.length === 0) return null;
        return (
          <div key={type}>
            <div className="dev-label">{heading}</div>
            {list.map((item) => (
              <div key={item.key} className="dev-setting">
                <span className="dev-setting-label">
                  {item.name}
                  <span className="muted"> ${item.price.toFixed(2)}</span>
                </span>
                {type === "Service" ? (
                  <select
                    className="dev-text dev-shelf-group"
                    aria-label={`Group for ${item.name}`}
                    value={groupOf(item.id)}
                    onChange={(e) => setGroupOf(item.id, e.target.value)}
                  >
                    <option value="">None</option>
                    {groups.map((g, i) => (
                      <option key={i} value={g.label}>
                        {g.label || `(group ${i + 1})`}
                      </option>
                    ))}
                  </select>
                ) : null}
                <label className="dev-bundle-toggle">
                  <span className="muted">hidden</span>
                  <input
                    type="checkbox"
                    checked={hidden.has(item.key)}
                    onChange={() => toggleHidden(item.key)}
                  />
                </label>
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
            One save writes the whole config: hidden items and every group.
          </span>
        )}
      </div>
    </div>
  );
}
