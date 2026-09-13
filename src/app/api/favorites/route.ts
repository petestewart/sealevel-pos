import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/db";
import {
  favoritesSettingKey,
  parseFavorites,
  validateFavorites,
} from "@/lib/favorites";
import { target } from "@/lib/mindbody";
import { ensureTarget } from "@/lib/target";

export const dynamic = "force-dynamic";

/** Sixty pairs of a type and a short id is under 4KB; a body past this
 *  is not a favorites list and is refused unread. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * PUT /api/favorites (T76): the whole shared list, replaced.
 *
 * The counter iPad's star tap is the client, so this is gated by the
 * device session alone, like /api/catalog, and NOT by devtools: a
 * teacher starring the mat rental is the point. The body is
 * `{ favorites: [{ type, id }, ...] }`, validated by the same rule the
 * catalog route reads the row with (at most 60 pairs, type Product,
 * Service or Package, ids strings); a bad body is 400 with the reason.
 *
 * With no database (or one that is not answering) nothing is stored and
 * the answer says so, `stored: false`, so the screen keeps the tap in
 * its own localStorage exactly as it did before T76. `migrated` marks
 * the one-time upload of a device's list: the table had no row and the
 * new list is not empty.
 *
 * Reads nothing from Mindbody and does not touch the catalog cache: a
 * star must never cost a metered call, and the pairs need no resolving
 * here (the screen resolves them against the visible catalog).
 */
export async function PUT(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "body too large" }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const list =
    typeof body === "object" && body !== null && "favorites" in body
      ? (body as { favorites: unknown }).favorites
      : body;
  const result = validateFavorites(list);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  /* T89 review: this route talks to no Mindbody endpoint, so nothing
   * else here loads the stored target, and the row key names a studio:
   * without this the list could be written under favorites_prod while
   * the counter is pointed at the sandbox, mixing one studio's pricing
   * option ids into the other's shelf. Bounded and never throws. */
  await ensureTarget();
  const key = favoritesSettingKey(target());
  const before = parseFavorites(await getSetting(key)).favorites;
  const stored = await setSetting(key, JSON.stringify(result));
  return NextResponse.json({
    ok: true,
    favorites: result,
    stored,
    migrated: stored && before === null && result.length > 0,
  });
}
