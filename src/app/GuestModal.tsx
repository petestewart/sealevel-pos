"use client";

import { useEffect, useRef, useState } from "react";

import { actorFallbackLine } from "./actornote";

/**
 * T59c: a member's guest pass checks a guest in. Opened from the
 * member's roster row (the Guest action beside the pass chevron, or the
 * Guest Pass line in their pass picker), it picks the guest and confirms
 * ONE write sequence on the server (`POST /api/guest`, mechanism A: the
 * guest's visit is booked or paid with the member's Guest Pass id, the
 * member is signed in, a Formula Note goes on both).
 *
 * The T52 modal idiom: the X, the scrim, Escape, one Cancel/Confirm pair
 * at 64px. The search is the attach modal's: a box and a magnifying
 * glass, one metered call per submitted search, results as roster-style
 * rows; people already in THIS class come first, from memory, with no
 * call at all. The waiver gate belongs to the page (the same T18 dialog
 * the walk-in path runs, opened over this modal): a pick of someone
 * with no released waiver goes up to the page and comes back as
 * `selected` only once their agreement is recorded.
 *
 * Nothing here is optimistic and nothing is retried: the confirm is
 * single flight, the answer is shown step by step, and a suppressed
 * write (dry run, the write guard) is amber, never success.
 */

/** page.tsx's SearchResult, as /api/search serves it. */
export interface GuestPerson {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  waiverSigned: boolean;
  redAlert: string | null;
  yellowAlert: string | null;
  balance: number | null;
  member: boolean;
  notes: string | null;
  mindbodyId: number | null;
}

/** Where a person stands in the class the pass is being used for: their
 *  roster row's facts, when they have one. */
export interface ClassStanding {
  visitId: number | null;
  checkedIn: boolean;
  paid: boolean;
  pricingOption: string | null;
}

export interface GuestPick {
  person: GuestPerson;
  standing: ClassStanding | null;
}

type StepOutcome = "done" | "suppressed" | "skipped" | { error: string };

/** What /api/guest answers, the parts the sheet reads. */
interface GuestAnswer {
  ok?: boolean;
  error?: string;
  step?: string;
  refused?: boolean;
  suppressed?: boolean;
  steps?: { guest: StepOutcome; member: StepOutcome; notes: StepOutcome };
  actorFallback?: { name: string; reason: string };
  staffSessionEnded?: boolean;
  reason?: string;
}

interface Props {
  member: {
    clientId: string;
    name: string;
    visitId: number | null;
    checkedIn: boolean;
  };
  pass: { id: number; name: string; remaining: number | null; expires: string | null };
  classId: number;
  className: string;
  classStartsAt: string;
  /** Everyone on this class's roster but the member, with their standing. */
  roster: GuestPick[];
  minQueryLength: number;
  searchLimit: number;
  /** The chosen guest, past the waiver gate. Null while picking. */
  selected: GuestPick | null;
  /** A tap on a row: the page gates the waiver and then sets `selected`. */
  onPick: (pick: GuestPick) => void;
  onUnpick: () => void;
  onNewClient: (first: string, last: string) => void;
  /** True while the waiver dialog or the sign-up form sits on top: this
   *  modal's Escape and scrim stand down so the top layer peels first. */
  layerAbove: boolean;
  /** Which guard is armed, for the amber lines: null when writes are live. */
  suppressionReason: string | null;
  onClose: () => void;
  /** Every answer from /api/guest, so the page can note a fallback or an
   *  ended staff session and refresh the rows that changed. `landed` is
   *  true when the guest's visit REALLY landed on the pass. */
  onAnswer: (answer: GuestAnswer, pick: GuestPick, landed: boolean) => void;
}

function CloseIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
    </svg>
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Numeric date for the pass line, e.g. 10/1/26 (page.tsx slashDate). */
function slashDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

function contactLine(c: { email: string | null; phone: string | null }): string {
  return [c.email, c.phone].filter(Boolean).join(" · ");
}

/** The amber line under a candidate: allowed, said plainly (Pete: no
 *  rules on who may be a guest). */
function caution(pick: GuestPick): string | null {
  const parts: string[] = [];
  if (pick.person.member) parts.push("A member themselves.");
  if (pick.standing?.checkedIn) parts.push("Already checked in.");
  else if (pick.standing?.paid && pick.standing.pricingOption) {
    parts.push(
      `Already in this class on ${pick.standing.pricingOption}; the guest pass will replace it.`,
    );
  }
  return parts.length ? parts.join(" ") : null;
}

export default function GuestModal({
  member,
  pass,
  classId,
  className,
  classStartsAt,
  roster,
  minQueryLength,
  searchLimit,
  selected,
  onPick,
  onUnpick,
  onNewClient,
  layerAbove,
  suppressionReason,
  onClose,
  onAnswer,
}: Props) {
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [results, setResults] = useState<GuestPerson[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  /** The sheet's outcome once /api/guest has answered and the modal is
   *  staying open to say what happened (a refusal, a partial, a
   *  suppression). Null before the confirm and after a clean success,
   *  which closes the modal. */
  const [outcome, setOutcome] = useState<{
    lines: { text: string; tone: "ok" | "warn" | "stop" }[];
  } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy || layerAbove) return;
      e.stopPropagation();
      if (selected && !outcome) onUnpick();
      else onClose();
    };
    /* Capture, so the roster's own Escape handlers (the pass picker, the
     * counter modals) do not also fire under this. */
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, layerAbove, selected, outcome, onUnpick, onClose]);

  useEffect(() => () => searchAbort.current?.abort(), []);

  const submitSearch = () => {
    const q = query.trim();
    if (q.length < minQueryLength) {
      setSearchMsg(`Type at least ${minQueryLength} letters, then press Enter.`);
      return;
    }
    searchAbort.current?.abort();
    const ac = new AbortController();
    searchAbort.current = ac;
    setSearching(true);
    setSearchMsg(null);
    fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${searchLimit}`, {
      signal: ac.signal,
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        if (ac.signal.aborted) return;
        setResults(Array.isArray(body?.results) ? body.results : []);
        setSearched(q);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setSearchMsg(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setSearching(false);
      });
  };

  /* The rows. In class first: unpaid bookings (a guest who signed up
   * ahead and has nothing to pay with is the usual case), cut by the
   * typed text in memory as it is typed, no call. Then the studio
   * search's results as submitted, minus anyone already listed above and
   * the member; a result who is on the roster and paid, or checked in,
   * stays a candidate with the amber line (Pete: no rules). */
  const q = query.trim().toLowerCase();
  const onRoster = new Map(roster.map((r) => [r.person.id, r] as const));
  const inClass = roster
    .filter((r) => !r.standing?.paid)
    .filter((r) => !q || r.person.name.toLowerCase().includes(q));
  const inClassIds = new Set(inClass.map((r) => r.person.id));
  const fromSearch: GuestPick[] = results
    .filter((p) => p.id !== member.clientId && !inClassIds.has(p.id))
    .map((p) => ({ person: p, standing: onRoster.get(p.id)?.standing ?? null }));

  const looksLikeName = (() => {
    const words = query.trim().split(/\s+/);
    return words.length === 2 && words.every((w) => !/[\d@]/.test(w));
  })();

  const confirm = async () => {
    if (inFlight.current || !selected) return;
    inFlight.current = true;
    setBusy(true);
    setOutcome(null);
    const pick = selected;
    try {
      const res = await fetch("/api/guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          memberClientId: member.clientId,
          guestClientId: pick.person.id,
          classId,
          clientServiceId: pass.id,
          guestVisitId: pick.standing?.visitId ?? null,
          /* The member's own sign-in rides along only when their row
           * says they are not in yet; a second SignedIn write on a row
           * already in would be a call for nothing. */
          memberVisitId: member.checkedIn ? null : member.visitId,
          className,
          classStartsAt,
          memberName: member.name,
          guestName: pick.person.name,
        }),
      });
      const body = (await res.json().catch(() => null)) as GuestAnswer | null;
      const answer: GuestAnswer = body ?? {
        error: `Mindbody did not answer (HTTP ${res.status}).`,
      };
      const steps = answer.steps;
      const landed = res.ok && steps?.guest === "done";
      onAnswer(answer, pick, landed);
      if (!res.ok) {
        /* A refusal (409) or a failed guest step (502): nothing else was
         * written; the words are Mindbody's. A 401 has already sent the
         * page back to the sign-in gate. */
        if (answer.reason === "staff") return;
        setOutcome({
          lines: [
            {
              text: answer.refused
                ? `Mindbody refused the guest pass on ${pick.person.name}'s visit: ${(answer.error ?? "no reason given").replace(/\.$/, "")}. Nothing was written.`
                : (answer.error ?? `HTTP ${res.status}`),
              tone: "stop",
            },
          ],
        });
        return;
      }
      if (!steps) {
        setOutcome({
          lines: [{ text: "Mindbody answered without saying what happened.", tone: "stop" }],
        });
        return;
      }
      const lines: { text: string; tone: "ok" | "warn" | "stop" }[] = [];
      const say = (label: string, s: StepOutcome, done: string, skipped: string) => {
        if (s === "done") lines.push({ text: `${label}: ${done}`, tone: "ok" });
        else if (s === "suppressed") {
          lines.push({
            text: `${label}: not written. ${suppressionReason ?? "The write was suppressed."}`,
            tone: "warn",
          });
        } else if (s === "skipped") {
          if (skipped) lines.push({ text: `${label}: ${skipped}`, tone: "ok" });
        } else lines.push({ text: `${label}: failed. ${s.error}`, tone: "stop" });
      };
      say(
        pick.person.name,
        steps.guest,
        `checked in on ${firstName(member.name)}'s guest pass.`,
        "",
      );
      say(
        member.name,
        steps.member,
        "checked in.",
        member.checkedIn ? "already checked in." : "not checked in: no visit to sign in.",
      );
      say("Formula Notes", steps.notes, "filed on both.", "");
      if (answer.actorFallback) {
        lines.push({ text: actorFallbackLine(answer.actorFallback), tone: "warn" });
      }
      const clean =
        steps.guest === "done" &&
        (steps.member === "done" || steps.member === "skipped") &&
        steps.notes === "done" &&
        !answer.actorFallback;
      if (clean) {
        onClose();
        return;
      }
      setOutcome({ lines });
    } catch (e) {
      setOutcome({
        lines: [{ text: e instanceof Error ? e.message : String(e), tone: "stop" }],
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const passLine = [
    "Guest Pass",
    pass.remaining !== null ? `${pass.remaining} left` : null,
    pass.expires ? `exp ${slashDate(pass.expires)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const row = (pick: GuestPick, key: string) => {
    const note = caution(pick);
    const contact = contactLine(pick.person);
    return (
      <li key={key}>
        <div
          className="rrow rrow-tap"
          role="button"
          tabIndex={0}
          aria-label={`Pick ${pick.person.name} as the guest`}
          onClick={() => onPick(pick)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onPick(pick);
            }
          }}
        >
          <div className="cell-name">
            <span className="name-text">{pick.person.name}</span>
            {contact ? <span className="contact-line">{contact}</span> : null}
            {note ? <span className="subline guest-caution">{note}</span> : null}
          </div>
          <span className="cell-chip">
            {pick.standing ? (
              <span className={pick.standing.checkedIn ? "mini-in" : "mini-signed"}>
                {pick.standing.checkedIn ? "checked in" : "in class"}
              </span>
            ) : null}
          </span>
        </div>
      </li>
    );
  };

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onClick={(e) => {
        if (busy || layerAbove || e.target !== e.currentTarget) return;
        onClose();
      }}
    >
      <div
        className="modal modal-list modal-guest"
        role="dialog"
        aria-modal="true"
        aria-label={`Guest of ${member.name}`}
      >
        <button
          className="row-icon modal-x"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        <p className="modal-title">Guest of {member.name}</p>
        <p className="muted modal-who">{passLine}</p>

        {selected ? (
          /* The confirm sheet: one sentence, one tap, single flight. */
          <div className="guest-confirm">
            {outcome === null ? (
              <p className="modal-consequence guest-sentence">
                Check in <strong>{selected.person.name}</strong> as{" "}
                {member.name}&apos;s guest. {firstName(member.name)}&apos;s
                Guest Pass will be used.
              </p>
            ) : (
              <ul className="guest-outcome" aria-live="polite">
                {outcome.lines.map((l, i) => (
                  <li key={i} className={`guest-line ${l.tone}`}>
                    {l.text}
                  </li>
                ))}
              </ul>
            )}
            {outcome === null && caution(selected) ? (
              <p className="modal-warn">{caution(selected)}</p>
            ) : null}
            {outcome === null && suppressionReason ? (
              <p className="modal-warn">{suppressionReason}</p>
            ) : null}
            <div className="modal-actions">
              {outcome === null ? (
                <>
                  <button className="modal-cancel" disabled={busy} onClick={onUnpick}>
                    Cancel
                  </button>
                  <button
                    className="modal-confirm go"
                    disabled={busy}
                    onClick={() => void confirm()}
                  >
                    {busy ? (
                      <>
                        <span className="spinner" aria-label="working" /> Checking in
                      </>
                    ) : (
                      "Confirm"
                    )}
                  </button>
                </>
              ) : (
                <button className="modal-cancel" onClick={onClose}>
                  Close
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="search-bar">
              <div className="search-wrap">
                <input
                  className="search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSearchMsg(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitSearch();
                    }
                  }}
                  enterKeyHint="search"
                  placeholder="Who is the guest? (press Enter)"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                />
                {query ? (
                  <button
                    type="button"
                    className="search-clear"
                    aria-label="Clear search"
                    onClick={() => {
                      searchAbort.current?.abort();
                      setQuery("");
                      setResults([]);
                      setSearched("");
                      setSearchMsg(null);
                      setSearching(false);
                    }}
                  >
                    <CloseIcon />
                  </button>
                ) : null}
              </div>
              <button
                className="search-go"
                onClick={submitSearch}
                aria-label="Search"
                title="Search"
              >
                <SearchIcon />
              </button>
            </div>
            {searchMsg ? <p className="search-quiet">{searchMsg}</p> : null}
            <ul className="roster modal-roster guest-rows">
              {inClass.length > 0 ? (
                <li className="guest-group" aria-hidden="true">
                  In class
                </li>
              ) : null}
              {inClass.map((r) => row(r, `class-${r.person.id}`))}
              {searched ? (
                <li className="guest-group" aria-hidden="true">
                  {searching ? "Searching..." : `Results for "${searched}"`}
                </li>
              ) : searching ? (
                <li className="guest-group" aria-hidden="true">
                  Searching...
                </li>
              ) : null}
              {fromSearch.map((r) => row(r, `search-${r.person.id}`))}
              {searched && !searching && fromSearch.length === 0 ? (
                <li className="guest-empty muted">Nobody else matched.</li>
              ) : null}
            </ul>
            <div className="modal-actions new-client-actions">
              <button
                className="modal-confirm go"
                onClick={() => {
                  const words = query.trim().split(/\s+/);
                  onNewClient(
                    looksLikeName ? (words[0] ?? "") : "",
                    looksLikeName ? (words[1] ?? "") : "",
                  );
                }}
              >
                New client
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
