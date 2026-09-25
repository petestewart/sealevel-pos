import { NextResponse } from "next/server";

import {
  spendCompToken,
  unspendCompToken,
  verifyCompToken,
  type TeacherIdentity,
} from "./auth";
import { fileFormulaNote } from "./formulanote";
import type { StaffSession } from "./staffsession";
import {
  parseWaiverOverride,
  waiverOverrideLine,
  WAIVER_PURPOSE,
  type WaiverFlow,
} from "./waiveroverride";

/**
 * T211's server half: the one place a `waiverOverride` field is read,
 * so /api/checkin, /api/book and /api/guest cannot check it three
 * slightly different ways.
 *
 * The order is the T48/T94/T205 order, and every step of it runs BEFORE
 * any Mindbody call:
 *
 *   1. the shape (a token and a reason of 3 to 200 characters);
 *   2. the token's own PURPOSE -- `waiver`, and nothing else, so a PIN
 *      typed to discount a sale, to overdraw an account, to override a
 *      pass, to approve a sale or to sell a membership unsigned is
 *      refused here in words with nothing written;
 *   3. T94's rule: the token must name the teacher whose session is
 *      behind the request, so one teacher's PIN cannot authorize
 *      another's tap;
 *   4. the SPEND, atomically, so a token that arrives twice writes once.
 *
 * The spend is up front on purpose. A token released back into the pool
 * afterwards (`releaseWaiverOverride`) is the ONE exception, and only
 * for a write dry run or the write guard suppressed: nothing reached
 * Mindbody, so nothing was authorized, which is the same rule T202 made
 * for a suppressed release and the student's signature. A refusal or an
 * error still costs the PIN, because neither is evidence that nothing
 * was written.
 *
 * Nothing here decides whether the student HAS a waiver. The gate is
 * the browser's (T18/T19) and stays there; this only says that a named
 * teacher took responsibility for one write, and files that fact where
 * staff already look.
 */

export interface ClaimedWaiverOverride {
  token: string;
  reason: string;
  teacher: TeacherIdentity;
  flow: WaiverFlow;
}

export type WaiverOverrideClaim =
  | { ok: true; override: ClaimedWaiverOverride | null }
  | { ok: false; denied: NextResponse };

/**
 * Read, verify and spend the override on a request body. `null` in the
 * ok case means the field was absent, which is every ordinary write.
 */
export function claimWaiverOverride(
  raw: unknown,
  session: StaffSession,
  flow: WaiverFlow,
): WaiverOverrideClaim {
  const parsed = parseWaiverOverride(raw);
  if (parsed === null) return { ok: true, override: null };
  if (typeof parsed === "string") {
    return {
      ok: false,
      denied: NextResponse.json({ error: parsed }, { status: 400 }),
    };
  }
  /* T94 review's rule, both halves: the purpose signed into the token,
   * and this session's own staff id. */
  const teacher = verifyCompToken(parsed.token, WAIVER_PURPOSE);
  /* One sentence for every way the token is no good -- wrong purpose,
   * another teacher's, expired, forged, already spent -- so a caller
   * learns nothing from WHICH it was. */
  const refused = (): WaiverOverrideClaim => ({
    ok: false,
    denied: NextResponse.json(
      {
        error:
          "Enter your PIN to go ahead without a waiver. Nothing was written.",
        reason: "teacher",
      },
      { status: 401 },
    ),
  });
  if (teacher === null || teacher.id !== session.staffId) return refused();
  if (!spendCompToken(parsed.token)) return refused();
  return {
    ok: true,
    override: { token: parsed.token, reason: parsed.reason, teacher, flow },
  };
}

/** A write dry run or the write guard suppressed never happened, so the
 *  PIN it rode on is handed back. See unspendCompToken. */
export function releaseWaiverOverride(
  override: ClaimedWaiverOverride | null,
): void {
  if (override === null) return;
  unspendCompToken(override.token);
  console.log(
    `[waiver-override] suppressed, the PIN was not spent: ` +
      `teacher=${override.teacher.id} flow=${override.flow}`,
  );
}

/**
 * File the override on the client, after the write it authorized has
 * landed. The same path a comp's reason takes (T45, and T62's signed
 * Notes entry on a site without Formula Notes), so it goes through
 * mindbody() with the client id in the options: dry run and the write
 * guard apply to the record as they do to the write, and a suppressed
 * record is reported as such rather than as filed.
 *
 * It can never change the outcome it records: it is called last and it
 * never throws.
 */
export async function fileWaiverOverrideNote(opts: {
  session: StaffSession | null;
  clientId: string;
  override: ClaimedWaiverOverride;
  /** T208's waiting list: the add landed in a queue, not in the class,
   *  and the record says which. */
  queued?: boolean;
  /** How long to wait for Mindbody to file the line before answering
   *  anyway (the note may still land). Check-in passes a short one:
   *  the row spins until the route answers, with a queue at the door. */
  waitMs?: number;
}): Promise<{ via: "formula" | "notes" | null; error: string | null }> {
  const { override } = opts;
  const note = waiverOverrideLine(
    override.flow,
    override.teacher.name,
    override.reason,
    opts.queued === true,
  );
  console.log(
    `[waiver-override] ${override.flow} client=${opts.clientId} ` +
      `teacher=${override.teacher.id} reason=${JSON.stringify(override.reason)}`,
  );
  const filed = await fileFormulaNote({
    session: opts.session,
    clientId: opts.clientId,
    note,
    route: "/api waiver-override note",
    logTag: "[waiver-override]",
    ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
  });
  return { via: filed.via, error: filed.error };
}

/** What a route puts on its answer so the screen can say the record
 *  landed (or did not) without inventing its own wording. */
export function waiverOverrideFields(
  override: ClaimedWaiverOverride | null,
  filed: { via: "formula" | "notes" | null; error: string | null } | null,
): Record<string, unknown> {
  if (override === null) return {};
  return {
    waiverOverride: {
      teacher: override.teacher.name,
      noted: filed !== null && filed.via !== null,
      ...(filed?.error ? { noteError: filed.error } : {}),
    },
  };
}
