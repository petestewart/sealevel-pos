import { runAsActor } from "./actor";
import { mindbody } from "./mindbody";
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

export interface FormulaNoteOutcome {
  /** The note's id when Mindbody answered with one; null otherwise. */
  id: number | null;
  /** Which guard stopped the write, or null when it was sent. */
  suppressed: "dry-run" | "write-guard" | null;
  /** Why there is no id when it was sent and none came back. */
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
  const { clientId, note, logTag } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = (
      await Promise.race([
        runAsActor(opts.session, opts.route, (actor) =>
          mindbody("/client/addclientformulanote", {
            method: "POST",
            body: { ClientId: clientId, Note: note },
            clientId,
            ...(actor ? { actor } : {}),
          }),
        ),
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
      ])
    ).result;
    if (res?.DryRun || res?.WriteSuppressed) {
      const suppressed = res?.DryRun ? "dry-run" : "write-guard";
      console.log(`${logTag} formula-note suppressed: ${suppressed}`);
      return { id: null, suppressed, error: null };
    }
    const id = res?.Id;
    if (typeof id !== "number" || !Number.isInteger(id)) {
      const error = `no note id in the answer ${JSON.stringify(res).slice(0, 200)}`;
      console.log(`${logTag} formula-note failed: ${error}`);
      return { id: null, suppressed: null, error };
    }
    console.log(`${logTag} formula-note filed: id=${id} client=${clientId}`);
    return { id, suppressed: null, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`${logTag} formula-note failed: ${error}`);
    return { id: null, suppressed: null, error };
  } finally {
    clearTimeout(timer);
  }
}
