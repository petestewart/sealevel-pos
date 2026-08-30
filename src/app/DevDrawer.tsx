"use client";

import { useCallback, useEffect, useState } from "react";

import { DEFAULT_SETTINGS, type Settings, useSettings } from "./settings";

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
  const [tab, setTab] = useState<"calls" | "settings" | "bundles">("calls");
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

  /** Only poll while the drawer is open; a closed drawer should cost
   *  nothing on a machine that is also serving the counter. */
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => void poll(), 1500);
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
      `${call.outcome} ${call.status ?? ""} ${call.ms}ms  ${call.at}`,
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
    </div>
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
