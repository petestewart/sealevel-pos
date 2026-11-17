"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { presenterId } from "./presenter";
import { readPassPick, type PassPick } from "@/lib/displaypasses";
import {
  choiceTeacherWord,
  isTenderChoice,
  type TenderChoice,
} from "@/lib/displayticket";

/**
 * T241: the student chose how to pay on the customer iPad, and the
 * teacher's iPad hears it. ONE piece for both charge screens (T209's
 * rule), the way `useSaleApproval` is one piece for the approval.
 *
 * What it owns:
 *
 * - reading a pick, from whichever door it came in by: the teacher's
 *   events stream (`tender-pick`, which the Cart screen's live mirror
 *   already holds open) or the approval poll's answer (`pick`, both
 *   screens, which keeps a pick through a dropped stream). The same pick
 *   arriving by both doors is acted on ONCE, by its id;
 * - refusing a pick for a ticket this screen is not showing;
 * - the one sentence the teacher reads ("Taylor chose Cash"), or the
 *   sentence that says it was refused and nothing changed.
 *
 * What it deliberately does NOT own: the tender. Each screen passes its
 * own `apply`, which moves its own tender (or refuses, with the reason)
 * and decides nothing about money: a pick NEVER charges. The charge is
 * still the teacher's Finalize and, with the approval setting on, the
 * student's Approve on the ticket presented after the pick.
 */

export interface TenderPick {
  pickId: string;
  requestId: string;
  choice: TenderChoice;
  /** A card the student typed on the display: its last four, for the
   *  TEACHER's screen only. */
  lastFour?: string;
  /** And whether they ticked "Save this card for next time". */
  keep?: boolean;
  /** The tab whose ticket it was made on (T241 review). */
  presenter?: string;
}

/** A pick off the wire, or null. Only the fixed keys are read. */
export function readTenderPick(value: unknown): TenderPick | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.pickId !== "string" ||
    typeof v.requestId !== "string" ||
    !isTenderChoice(v.choice)
  ) {
    return null;
  }
  return {
    pickId: v.pickId,
    requestId: v.requestId,
    choice: v.choice,
    ...(typeof v.lastFour === "string" && /^\d{4}$/.test(v.lastFour)
      ? { lastFour: v.lastFour }
      : {}),
    ...(v.keep === true ? { keep: true } : {}),
    ...(typeof v.presenter === "string" ? { presenter: v.presenter } : {}),
  };
}

/** How long the teacher's sentence stands. Long enough to read across a
 *  queue; a new pick or a new ticket replaces it sooner. */
const NOTE_MS = 15_000;
/** T241 review: how long after a pick MOVED the tender the screen's
 *  charge control ignores taps, with the sentence highlighted, so a
 *  teacher reaching for Finalize as the student taps sees the new method
 *  before charging it. Light on purpose: no extra confirm tap. */
export const PICK_SETTLE_MS = 1_500;

export interface TenderPickApi {
  /** The teacher's sentence, or null. */
  note: string | null;
  /** Hand a pick in, from either door. */
  receive: (value: unknown) => void;
  /** Take the sentence down (a new ticket, a finished sale). */
  clear: () => void;
  /** T241 review: a pick moved the tender in the last PICK_SETTLE_MS.
   *  The screen's charge control is disabled and the sentence drawn
   *  highlighted while this holds. */
  settling: boolean;
  /** The same, read synchronously by a tap handler, so a tap in the same
   *  instant as the pick (before the next render) is ignored too. */
  settlingNow: () => boolean;
  /** Put a sentence of the screen's own in the same place (a student's
   *  card let go with the approval it was typed on). */
  say: (line: string) => void;
}

export function useTenderPick(input: {
  /** Whether `requestId` is a ticket this screen put on the display and
   *  is still showing (the live mirror's, or the approval's). */
  owns: (requestId: string) => boolean;
  /** The student's first name, for the sentence; null reads "The
   *  customer". */
  firstName: string | null;
  /**
   * Move this screen's tender for the pick, or refuse it. Null means it
   * was applied; a string is the reason it was not, as one sentence
   * ("The sale is already being charged."). It must never charge.
   */
  apply: (pick: TenderPick) => string | null;
  /**
   * T242: a student's pick of one of their OWN passes on "Your passes"
   * (the roster dialog's passes view), heard through this same piece.
   * The screen acts on it (assigns the pass and checks in, the same two
   * writes as the teacher's own tap) and answers with the pass's name
   * for the sentence, a string reason it was refused, or null to drop it
   * without a word (the teacher's own tap is already running: first tap
   * wins). Absent on a screen with no passes view: a pass pick is then
   * ignored. A pass pick never charges and never moves a tender.
   */
  applyPass?: (pick: PassPick) => { name: string } | string | null;
}): TenderPickApi {
  const [note, setNote] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const appliedAt = useRef(0);
  /* Read through refs: the screen's closures are rebuilt every render,
   * and the stream listener and the poll must see THIS render's tender
   * without being re-subscribed per keystroke. */
  const ownsRef = useRef(input.owns);
  ownsRef.current = input.owns;
  const applyRef = useRef(input.apply);
  applyRef.current = input.apply;
  const nameRef = useRef(input.firstName);
  nameRef.current = input.firstName;
  const applyPassRef = useRef(input.applyPass);
  applyPassRef.current = input.applyPass;
  /** Picks already handled, so the stream and the poll cannot act twice. */
  const seen = useRef<Set<string>>(new Set());

  const receive = useCallback((value: unknown) => {
    const remember = (pickId: string) => {
      seen.current.add(pickId);
      if (seen.current.size > 100) {
        const first = seen.current.values().next();
        if (!first.done) seen.current.delete(first.value);
      }
    };
    /* T242: a pass pick carries a ClientService id and no tender key. */
    const passPick = readTenderPick(value) === null ? readPassPick(value) : null;
    if (passPick !== null) {
      const applyPass = applyPassRef.current;
      if (applyPass === undefined) return;
      if (seen.current.has(passPick.pickId)) return;
      if (!ownsRef.current(passPick.requestId)) return;
      if (passPick.presenter !== undefined && passPick.presenter !== presenterId()) {
        return;
      }
      remember(passPick.pickId);
      const done = applyPass(passPick);
      if (done === null) return;
      const who = nameRef.current ?? "The customer";
      setNote(
        typeof done === "string"
          ? `${who} chose a pass on the customer screen. ${done}`
          : `${who} chose ${done.name} on the customer screen. Checking them in.`,
      );
      return;
    }
    const pick = readTenderPick(value);
    if (pick === null) return;
    if (seen.current.has(pick.pickId)) return;
    if (!ownsRef.current(pick.requestId)) return;
    /* A pick on another tab's ticket is that tab's (T241 review). */
    if (pick.presenter !== undefined && pick.presenter !== presenterId()) return;
    remember(pick.pickId);
    const who = nameRef.current ?? "The customer";
    const word = choiceTeacherWord(pick.choice);
    const refused = applyRef.current(pick);
    if (refused !== null) {
      setNote(`${who} asked to pay by ${word}. ${refused} Nothing changed.`);
      return;
    }
    appliedAt.current = Date.now();
    setSettling(true);
    switch (pick.choice) {
      case "typedcard":
        setNote(
          `${who} entered a card${
            pick.lastFour !== undefined ? ` ending ${pick.lastFour}` : ""
          }${pick.keep === true ? ", to keep on file" : ""}.`,
        );
        return;
      case "cash":
        setNote(`${who} chose Cash. Enter what they hand you.`);
        return;
      case "giftcard":
        setNote(`${who} chose Gift card. Scan or type the card.`);
        return;
      default:
        setNote(`${who} chose ${word}.`);
    }
  }, []);

  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), PICK_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settling, note]);

  const clear = useCallback(() => setNote(null), []);
  const say = useCallback((line: string) => setNote(line), []);

  const settlingNow = useCallback(
    () => Date.now() - appliedAt.current < PICK_SETTLE_MS,
    [],
  );

  return { note, receive, clear, say, settling, settlingNow };
}
