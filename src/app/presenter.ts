/**
 * T241 review: which TAB put a ticket on the customer display.
 *
 * A counter can have two teacher iPads with the Cart screen open, and
 * each mirrors its ticket to the one display. The server binds a live
 * ticket, a student's pick on it and a card the student types on it to
 * the presenter that put it up (this id, beside the signed-in teacher's
 * staff id), so a pick never moves the other iPad's tender and a card
 * typed for one iPad's ticket can never be charged by the other's
 * Finalize, and one iPad's cancel cannot take the other's ticket down.
 *
 * STABLE PER TAB across a reload or a Safari tab eviction (second
 * review, N2): kept in sessionStorage, which belongs to the tab and
 * survives both, so a reloaded Cart screen is still the owner of the
 * ticket it put up and replaces it in place rather than meeting "busy".
 * Where storage throws (a private window, blocked site data) the id is
 * this page load's own, which is the old behaviour. Random, from
 * `crypto.getRandomValues`, which (unlike `crypto.randomUUID`) works on
 * `http://<lan-ip>:3000`, not a secure context. It identifies a tab and
 * nothing else: it is not a secret and authorizes nothing on its own;
 * the staff session does that.
 */
const KEY = "pos_presenter";
let id: string | null = null;

function fresh(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function presenterId(): string {
  if (id !== null) return id;
  try {
    const stored = window.sessionStorage.getItem(KEY);
    if (stored !== null && /^[0-9a-f]{24}$/.test(stored)) {
      id = stored;
      return id;
    }
    id = fresh();
    window.sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    id ??= fresh();
    return id;
  }
}

/**
 * Take this tab's scene off the customer display (second review, N3).
 * Every teacher-side cancel goes through here, so it always names the
 * tab: the server refuses, as a no-op, a cancel of a TICKET another tab
 * owns. `takenOver` is the design's Take over; `requestId` cancels only
 * that request (the pagehide cancel of this tab's own live ticket);
 * `keepalive` lets that one outlive the page.
 */
export function cancelOnDisplay(
  opts: { takenOver?: boolean; requestId?: string; keepalive?: boolean } = {},
): Promise<Response> {
  return fetch("/api/display/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(opts.keepalive === true ? { keepalive: true } : {}),
    body: JSON.stringify({
      presenter: presenterId(),
      ...(opts.takenOver === true ? { takenOver: true } : {}),
      ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    }),
  });
}
