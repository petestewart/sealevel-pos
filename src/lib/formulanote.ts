import { runAsActor } from "./actor";
import { readClientNotes, updateClientNotes } from "./clients";
import { mindbody } from "./mindbody";
import { signEntries, studioDate } from "./notesig";
import type { StaffSession } from "./staffsession";

/**
 * A Formula Note on a client: the dated, staff-only entry on the
 * profile's Formula Notes tab (`POST /client/addclientformulanote`,
 * docs/mindbody-openapi/client.yml, AddFormulaNoteRequest: ClientId and
 * Note; Mindbody dates it and names the staff member itself). T45 put
 * the comp's record here because the checkout request carries no notes
 * field; T59c files the guest-pass record on both the guest and the
 * member the same way. One helper, so the two routes cannot drift.
 *
 * T62: site 471 does not have Formula Notes. Pete's live probe
 * (2026-09-04) got "This site does not have formula notes enabled" back,
 * which means every T45 comp note had been failing quietly (one log
 * line, never fatal, by design). The record still has to land somewhere
 * staff look, so the same sentence falls back to the client's `Notes`
 * field: appended as its own entry, signed with the session's name and
 * the studio date in T58's format (`... [by Pete Stewart, 9/4/26]`),
 * through the same surgical `updateclient` write the waiver receipt
 * uses, with the current notes read first because `updateclient` writes
 * the field whole. The Formula Note is still tried first, so a site that
 * turns them on gets them back with no change here; the "not enabled"
 * answer is remembered for the process lifetime (`formulaNotesEnabled`),
 * so a site without them pays one failed call per server start rather
 * than per sale. Any OTHER failure of the Formula Note is not evidence
 * that the site lacks them and does not fall back: a transient error is
 * reported as before.
 *
 * The contract, unchanged from T45: the note is filed AFTER the thing it
 * records has happened and can never change that outcome. It goes
 * through mindbody() with the client id in the options, so dry run and
 * the write guard apply to it as to any write, and a suppressed note is
 * reported as such, never as filed. It runs as the signed-in teacher
 * with the ordinary fallback (the note is a record, not the write it
 * records; a permission gap here is one warn line and the note still
 * lands). It waits `waitMs` and no longer (T45 review: a Mindbody that
 * hangs on it would otherwise hold the done screen for the transport's
 * full 20s after the money moved); the call itself runs on to its own
 * timeout and still lands in the call log, and a note that files late
 * simply has no id in the answer. It never throws.
 */

export const FORMULA_NOTE_WAIT_MS = 8_000;

/** Mindbody's wording for a site without the feature, as Pete's
 *  screenshot showed it, matched loosely enough to survive a rephrase
 *  of the same fact and no looser. */
const NOT_ENABLED_RE = /formula notes? (?:is |are )?not enabled|does not have formula notes/i;

/** null until Mindbody has answered one way or the other this process;
 *  false after a "not enabled" answer; true after a note filed. */
let formulaNotesEnabled: boolean | null = null;

/** What the process currently believes, for the dev drawer and tests. */
export function formulaNotesState(): boolean | null {
  return formulaNotesEnabled;
}

export interface FormulaNoteOutcome {
  /** The note's id when Mindbody answered with one; null otherwise,
   *  including after the Notes fallback (a Notes entry has no id). */
  id: number | null;
  /** Where the record landed: "formula" (a Formula Note), "notes" (the
   *  T62 fallback, a signed entry in the client's Notes), or null when
   *  nothing landed (suppressed, or failed). */
  via: "formula" | "notes" | null;
  /** Which guard stopped the write, or null when it was sent. */
  suppressed: "dry-run" | "write-guard" | null;
  /** Why there is no record when one was attempted and none landed. */
  error: string | null;
}

export async function fileFormulaNote(opts: {
  session: StaffSession | null;
  clientId: string;
  note: string;
  /** The route name runAsActor logs a fallback under. */
  route: string;
  /** The server-log prefix ("[comp]", "[guest]"), so each caller's
   *  lines read as its own. */
  logTag: string;
  waitMs?: number;
}): Promise<FormulaNoteOutcome> {
  const waitMs = opts.waitMs ?? FORMULA_NOTE_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fileNote(opts),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `no answer in ${waitMs / 1000}s; the note may still file`,
              ),
            ),
          waitMs,
        );
      }),
    ]);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`${opts.logTag} formula-note failed: ${error}`);
    return { id: null, via: null, suppressed: null, error };
  } finally {
    clearTimeout(timer);
  }
}

/** The Formula Note, then the Notes fallback when the site lacks them.
 *  Throws only for the race above to report. */
async function fileNote(opts: {
  session: StaffSession | null;
  clientId: string;
  note: string;
  route: string;
  logTag: string;
}): Promise<FormulaNoteOutcome> {
  const { clientId, note, logTag } = opts;
  if (formulaNotesEnabled !== false) {
    try {
      const res = (
        await runAsActor(opts.session, opts.route, (actor) =>
          mindbody("/client/addclientformulanote", {
            method: "POST",
            body: { ClientId: clientId, Note: note },
            clientId,
            ...(actor ? { actor } : {}),
          }),
        )
      ).result;
      if (res?.DryRun || res?.WriteSuppressed) {
        /* The same guard would stop the Notes write too: one amber
         * line, not two suppressed calls. */
        const suppressed = res?.DryRun ? "dry-run" : "write-guard";
        console.log(`${logTag} formula-note suppressed: ${suppressed}`);
        return { id: null, via: null, suppressed, error: null };
      }
      const id = res?.Id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        const error = `no note id in the answer ${JSON.stringify(res).slice(0, 200)}`;
        console.log(`${logTag} formula-note failed: ${error}`);
        return { id: null, via: null, suppressed: null, error };
      }
      formulaNotesEnabled = true;
      console.log(`${logTag} formula-note filed: id=${id} client=${clientId}`);
      return { id, via: "formula", suppressed: null, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!NOT_ENABLED_RE.test(message)) throw err;
      formulaNotesEnabled = false;
      console.log(
        `${logTag} formula-note disabled on this site (${JSON.stringify(message)}); ` +
          `falling back to a signed Notes entry for this process`,
      );
    }
  }
  return appendSignedNote(opts);
}

/**
 * T62's fallback: the sentence as its own entry at the end of the
 * client's Notes, signed `[by <session name>, <studio date>]` (T58's
 * tag, built by signEntries so the name is sanitised the one way the
 * parser can read back). A blank line separates it from what is there,
 * which is how T58's parser separates entries. The read and the write
 * are two calls; a concurrent edit of the same field from another
 * surface in the same moment loses at most that edit, the same trade
 * the waiver receipt makes.
 */
async function appendSignedNote(opts: {
  session: StaffSession | null;
  clientId: string;
  note: string;
  route: string;
  logTag: string;
}): Promise<FormulaNoteOutcome> {
  const { clientId, logTag } = opts;
  const current = await readClientNotes(clientId);
  const entry = signEntries(opts.note, null, opts.session?.name ?? "", studioDate());
  const trimmed = current.replace(/\s+$/, "");
  const next = trimmed ? `${trimmed}\n\n${entry}` : entry;
  const res = (
    await runAsActor(opts.session, opts.route, (actor) =>
      updateClientNotes(clientId, next, actor),
    )
  ).result;
  if (res.suppressed) {
    console.log(`${logTag} notes-entry suppressed: ${res.suppressed}`);
    return { id: null, via: null, suppressed: res.suppressed, error: null };
  }
  console.log(`${logTag} notes-entry appended: client=${clientId}`);
  return { id: null, via: "notes", suppressed: null, error: null };
}
