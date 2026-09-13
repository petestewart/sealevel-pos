"use client";

import { useEffect, useRef, useState } from "react";

import { actorFallbackLine } from "./actornote";
import { Hit } from "./Hit";

/**
 * T59c: a member's guest pass checks a guest in. Opened from the
 * member's roster row (the Guest action beside the pass chevron, or the
 * Guest Pass line in their pass picker), it picks the guest and confirms
 * ONE write sequence on the server (`POST /api/guest`). T63: the way
 * the front desk does it: the guest is sold their own $0 Guest Pass and
 * booked on it, the member's Guest Pass is retired by returning its
 * sale (or, when that is refused, left on their account and said so in
 * amber), the member is signed in, a record goes on both profiles.
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
  /** On a failed guest step: true when the step's first write went
   *  through (the visit is on the pass) and a later one did not. */
  landed?: boolean;
  /** T62: Mindbody took the pass id and used another pass (or none);
   *  the guest has a visit but not on the member's pass, and nothing
   *  else was written. `bookedHere` says this flow made that visit. */
  ignored?: boolean;
  bookedHere?: boolean;
  ownPass?: string | null;
  guestVisitId?: number | null;
  /** T62: false when neither read-back could confirm the pass. */
  verified?: boolean | null;
  verifyDetail?: string | null;
  suppressed?: boolean;
  /** T63: the sale of the guest's $0 pass and the return of the
   *  member's are steps of their own. */
  steps?: {
    sale?: StepOutcome;
    guest: StepOutcome;
    return?: StepOutcome;
    member: StepOutcome;
    notes: StepOutcome;
  };
  /** T63: a refused sale (409) or one that did not answer (502,
   *  `ambiguous`), before anything else was written. */
  ambiguous?: boolean;
  sale?: { cartId: string | null; product: string; guestPassId: number | null };
  memberPass?: {
    reason: string | null;
    returnSaleId: number | null;
    returnedAmount: number | null;
    remaining: number | null;
  };
  /** T62: where each record landed; "notes" is the signed Notes entry a
   *  site without Formula Notes gets. */
  noteVia?: { guest: "formula" | "notes" | null; member: "formula" | "notes" | null };
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
  /** T62: the sheet's "Remove from class" went through (or was
   *  suppressed, `suppressed` says which); the page refreshes the rows
   *  and the guest's own pass cache either way. */
  onRemoved: (pick: GuestPick, suppressed: string | null) => void;
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
  onRemoved,
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
    /** T62: the sheet offers "Remove from class" when Mindbody ignored
     *  the pass id and the guest's visit is one this flow made, or one
     *  now on their own pass. Null otherwise. */
    removable: { pick: GuestPick } | null;
  } | null>(null);
  const [removing, setRemoving] = useState(false);

  /* T62: the one remedy for an ignored pass id, through the existing
   * cancel-visit route (removeclientfromclass). Single flight, the same
   * ref as the confirm; suppression is said in amber and the modal stays
   * open, since a removal that was not written has not given anything
   * back. */
  const removeFromClass = async () => {
    if (inFlight.current || outcome?.removable === null || !outcome) return;
    const pick = outcome.removable.pick;
    inFlight.current = true;
    setRemoving(true);
    try {
      const res = await fetch("/api/cancel-visit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: pick.person.id, classId }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        reason?: string;
        suppressed?: string | null;
      } | null;
      if (!res.ok) {
        if (body?.reason === "staff") {
          onAnswer({ reason: "staff" }, pick, false);
          return;
        }
        setOutcome((o) =>
          o === null
            ? o
            : {
                ...o,
                lines: [
                  ...o.lines,
                  {
                    text: `Not removed: ${body?.error ?? `HTTP ${res.status}`}`,
                    tone: "stop",
                  },
                ],
              },
        );
        return;
      }
      if (body?.suppressed) {
        onRemoved(pick, body.suppressed);
        setOutcome((o) =>
          o === null
            ? o
            : {
                ...o,
                lines: [
                  ...o.lines,
                  {
                    text: `Removal not written. ${suppressionReason ?? "The write was suppressed."}`,
                    tone: "warn",
                  },
                ],
                removable: null,
              },
        );
        return;
      }
      onRemoved(pick, null);
      onClose();
    } catch (e) {
      setOutcome((o) =>
        o === null
          ? o
          : {
              ...o,
              lines: [
                ...o.lines,
                { text: e instanceof Error ? e.message : String(e), tone: "stop" },
              ],
            },
      );
    } finally {
      inFlight.current = false;
      setRemoving(false);
    }
  };

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
      const landed = (res.ok && steps?.guest === "done") || answer.landed === true;
      onAnswer(answer, pick, landed);
      if (!res.ok) {
        /* A refusal (409) or a failed guest step (502): nothing else was
         * written; the words are Mindbody's. A 401 has already sent the
         * page back to the sign-in gate. T59c review: a guest step that
         * failed AFTER its first write (`landed`) is a visit on the pass
         * with no sign-in, and the sheet says exactly that, with the
         * member's own check-in still to do. */
        if (answer.reason === "staff") return;
        const reason = (answer.error ?? "no reason given").replace(/\.$/, "");
        if (answer.ignored) {
          /* T62: Mindbody took the id and used another pass. The words
           * are the server's (they name the pass it used); the remedy
           * is the button, for a visit this flow made or one now on the
           * guest's own pass. A booking that was there before and is
           * unchanged has nothing to give back, so only Close. */
          const removable =
            answer.bookedHere === true || (answer.ownPass ?? null) !== null;
          /* T62 review: a visit this flow did NOT make (the guest was
           * booked before, on their own pass) is still offered removal,
           * since that is how the session comes back, but the sheet
           * says the booking predates the tap: Remove takes it away
           * too, and the teacher decides with that known. */
          const preexisting = removable && answer.bookedHere !== true;
          setOutcome({
            lines: [
              { text: answer.error ?? "Mindbody did not use the guest pass.", tone: "stop" },
              {
                text: `The $0 Guest Pass sold to ${pick.person.name} is still on their account, and ${firstName(member.name)}'s guest pass was not returned.`,
                tone: "warn" as const,
              },
              ...(preexisting
                ? [
                    {
                      text:
                        `${pick.person.name} was booked in this class before this. ` +
                        `Remove takes that booking away too; Close keeps it as it is.`,
                      tone: "warn" as const,
                    },
                  ]
                : []),
              ...(removable
                ? []
                : [
                    {
                      text: `${pick.person.name}'s booking is as it was. Nothing else was written.`,
                      tone: "warn" as const,
                    },
                  ]),
            ],
            removable: removable ? { pick } : null,
          });
          return;
        }
        /* T63: the sale's own refusals and its ambiguity carry the
         * server's full sentence (it names the guest, the amount or the
         * "may have gone through"), and nothing after it was written. */
        const lines: { text: string; tone: "ok" | "warn" | "stop" }[] =
          answer.step === "sale" || answer.step === "catalog" || answer.step === "pass"
            ? [{ text: answer.error ?? `HTTP ${res.status}`, tone: "stop" }]
            : answer.refused
              ? [
                  {
                    text: `Mindbody refused ${pick.person.name}'s new Guest Pass on their visit: ${reason}. The $0 pass is on their account; nothing else was written.`,
                    tone: "stop",
                  },
                  {
                    text: `${firstName(member.name)}'s guest pass was not returned.`,
                    tone: "warn",
                  },
                ]
              : answer.landed
                ? [
                    {
                      text: `${pick.person.name} is booked on their $0 Guest Pass but NOT signed in: ${reason}. Check them in from their row.`,
                      tone: "stop",
                    },
                    {
                      text: `${firstName(member.name)}'s guest pass was not returned. Return it in Mindbody.`,
                      tone: "warn",
                    },
                    ...(member.checkedIn
                      ? []
                      : [{ text: `${member.name}: not checked in.`, tone: "warn" as const }]),
                  ]
                : [{ text: answer.error ?? `HTTP ${res.status}`, tone: "stop" }];
        setOutcome({ lines, removable: null });
        return;
      }
      if (!steps) {
        setOutcome({
          lines: [{ text: "Mindbody answered without saying what happened.", tone: "stop" }],
          removable: null,
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
      /* T63: five steps in the order they ran. The sale first: the
       * guest's own $0 pass is what everything after it rests on. */
      say(
        `${pick.person.name}'s $0 Guest Pass`,
        steps.sale ?? "skipped",
        "sold.",
        "",
      );
      say(
        pick.person.name,
        steps.guest,
        "checked in on their new Guest Pass.",
        "",
      );
      /* The member's pass: returned, or left on their account with the
       * reason in amber (Pete's rule: never a refund, so a sale that
       * fails the check is left alone and named). The count is what
       * Mindbody lists now, never an inference from the return. */
      const remainingText =
        answer.memberPass?.remaining === null || answer.memberPass?.remaining === undefined
          ? ""
          : ` ${answer.memberPass.remaining} left.`;
      const ret = steps.return ?? "skipped";
      const memberFirst = firstName(member.name);
      if (ret === "done") {
        const amount = answer.memberPass?.returnedAmount ?? 0;
        lines.push({
          text: `${memberFirst}'s guest pass returned.${remainingText}`,
          tone: "ok",
        });
        if (amount !== 0) {
          lines.push({
            text: `Mindbody reports a returned amount of $${amount.toFixed(2)} on that sale. Check it in Mindbody.`,
            tone: "stop",
          });
        } else if (answer.memberPass?.remaining !== null && (answer.memberPass?.remaining ?? 0) > 0) {
          lines.push({
            text: `Mindbody still lists ${memberFirst}'s guest pass with ${answer.memberPass?.remaining} left. Check it in Mindbody.`,
            tone: "warn",
          });
        } else if (answer.memberPass?.remaining === null || answer.memberPass?.remaining === undefined) {
          /* T63 review: the count is a fresh read or nothing; a read
           * that failed is said, not shown as 0. */
          lines.push({
            text: `${memberFirst}'s passes could not be re-read after the return. Check the pass in Mindbody.`,
            tone: "warn",
          });
        }
      } else if (ret === "suppressed") {
        lines.push({
          text: `${memberFirst}'s guest pass: return not written. ${suppressionReason ?? "The write was suppressed."}`,
          tone: "warn",
        });
      } else {
        const why =
          typeof ret === "object"
            ? ret.error
            : (answer.memberPass?.reason ?? "the return did not run");
        lines.push({
          text: `${member.name}'s guest pass is still on their account: ${why.replace(/\.$/, "")}. Return it in Mindbody.`,
          tone: "warn",
        });
      }
      say(
        member.name,
        steps.member,
        "checked in.",
        member.checkedIn ? "already checked in." : "not checked in: no visit to sign in.",
      );
      /* T62: site 471 has no Formula Notes, so the record is usually a
       * signed entry in each profile's Notes; the label says which. */
      const viaNotes =
        answer.noteVia?.guest === "notes" || answer.noteVia?.member === "notes";
      say(
        viaNotes ? "Notes" : "Formula Notes",
        steps.notes,
        viaNotes ? "a signed entry added to both profiles." : "filed on both.",
        "",
      );
      if (answer.verified === false) {
        /* T62: the visit is written and signed in, but neither read-back
         * could say whose pass paid; the teacher looks at the row. */
        lines.push({
          text:
            `Could not confirm that ${firstName(member.name)}'s guest pass paid: ` +
            `${answer.verifyDetail ?? "the read-back failed"}. Check ${pick.person.name}'s row.`,
          tone: "warn",
        });
      }
      if (answer.actorFallback) {
        lines.push({ text: actorFallbackLine(answer.actorFallback), tone: "warn" });
      }
      const clean =
        steps.sale === "done" &&
        steps.guest === "done" &&
        steps.return === "done" &&
        (answer.memberPass?.returnedAmount ?? 0) === 0 &&
        answer.memberPass?.remaining === 0 &&
        (steps.member === "done" || steps.member === "skipped") &&
        steps.notes === "done" &&
        answer.verified !== false &&
        !answer.actorFallback;
      if (clean) {
        onClose();
        return;
      }
      setOutcome({ lines, removable: null });
    } catch (e) {
      setOutcome({
        lines: [{ text: e instanceof Error ? e.message : String(e), tone: "stop" }],
        removable: null,
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
            <span className="name-text">
              <Hit text={pick.person.name} q={searched} />
            </span>
            {contact ? (
              <span className="contact-line">
                <Hit text={contact} q={searched} />
              </span>
            ) : null}
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
        {/* T70 (Dialogs.dc.html): the head, then the member and their
            guest pass as the entity card. */}
        <div className="modal-head">
          <p className="modal-kicker">Guest pass</p>
          <p className="modal-title">Guest of {member.name}</p>
        </div>
        <div className="modal-entity">
          <span className="modal-entity-name">{member.name}</span>
          <span className="modal-entity-facts">{passLine}</span>
        </div>

        {selected ? (
          /* The confirm sheet: one sentence, one tap, single flight. */
          <div className="guest-confirm">
            {outcome === null ? (
              <p className="guest-sentence">
                Check in <strong>{selected.person.name}</strong> as{" "}
                {member.name}&apos;s guest. {selected.person.name} gets a $0
                Guest Pass and {firstName(member.name)}&apos;s guest pass is
                returned.
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
              ) : outcome.removable ? (
                <>
                  <button className="modal-cancel" disabled={removing} onClick={onClose}>
                    Close
                  </button>
                  <button
                    className="modal-confirm guest-remove"
                    disabled={removing}
                    onClick={() => void removeFromClass()}
                  >
                    {removing ? (
                      <>
                        <span className="spinner" aria-label="working" /> Removing
                      </>
                    ) : (
                      "Remove from class"
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
