/**
 * T241 review: which TAB put a ticket on the customer display.
 *
 * A counter can have two teacher iPads with the Cart screen open, and
 * each mirrors its ticket to the one display. The server binds a live
 * ticket, a student's pick on it and a card the student types on it to
 * the presenter that put it up (this id, beside the signed-in teacher's
 * staff id), so a pick never moves the other iPad's tender and a card
 * typed for one iPad's ticket can never be charged by the other's
 * Finalize.
 *
 * Random per page load, from `crypto.getRandomValues`, which (unlike
 * `crypto.randomUUID`) works on `http://<lan-ip>:3000`, not a secure
 * context. It identifies a tab and nothing else: it is not a secret and
 * authorizes nothing on its own; the staff session does that.
 */
let id: string | null = null;

export function presenterId(): string {
  if (id !== null) return id;
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return id;
}
