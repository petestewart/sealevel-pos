import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { currentSiteId, isActorTokenDead, mindbody } from "@/lib/mindbody";
import { houseClientId, pricingOptions, priceCart } from "@/lib/sale";
import {
  actorOf,
  endStaffSession,
  staffClearCookie,
  staffSessionFrom,
} from "@/lib/staffsession";

export const dynamic = "force-dynamic";

/**
 * GET /api/teacher/probe -- what the signed-in teacher's Mindbody login
 * can actually do (T49), so Pete can verify live before trusting the
 * attribution. Two reads, both UNDER THE TEACHER'S TOKEN:
 *
 * 1. `GET /staff/staffpermissions?StaffId=<id>` (staff.yml:402). The
 *    live answer carries `PermissionGroupName`, `AllowedPermissions`,
 *    `DeniedPermissions` and `IpRestricted` at the TOP LEVEL, not under
 *    the `UserGroup` wrapper the schema documents (CLAUDE.md; the
 *    ai-manager probe read the group as empty for exactly this reason),
 *    so both shapes are read. The six permissions this app needs are
 *    answered true/false each, and the whole denied list rides along
 *    because an explicit deny overrides everything.
 * 2. A `Test: true` price of a one-line cart holding the cheapest
 *    pricing option (a service: sellable at every location, so the
 *    sound test, where a product refused at a location short-circuits
 *    before the permission check). Test mode moves no money; this
 *    proves MakeSales and the cart permission end to end rather than
 *    by reading a list. Skipped, and said so, with no house client to
 *    attach (pricing needs a client) or an empty catalog; reported as
 *    suppressed under dry run.
 *
 * A 401 on either read is the token itself being dead: the session
 * ends, the cookie clears, and the answer is 401 `reason: "teacher"` so
 * the page's fetch wrapper leaves it to the header control rather than
 * the device lock. No session at all is the same 401, and since T77 it
 * carries `staffSessionEnded` too, so the account modal drops a teacher
 * the server no longer knows.
 */

/** The six permissions this app needs, CLAUDE.md's list. */
const NEEDED = [
  "LaunchSignInScreen",
  "BookClassesAndEventsWithoutPayment",
  "MakeSales",
  "CreateRetailTickets",
  "UseStoredCreditCards",
  "AddProductsOnRetailScreen",
] as const;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const session = await staffSessionFrom(request);
  if (!session) {
    /* T77: marked as an ended session, not just a miss. The page can
     * hold a teacher the server has forgotten (a deploy restarts the
     * server and its in-memory sessions; the two hours can run out
     * while the page sits open), and the account modal then named the
     * teacher over "Nobody is signed in." With the flag the modal drops
     * the teacher and the sign-in gate returns, the same path a refused
     * write takes. */
    return NextResponse.json(
      {
        error: "Nobody is signed in. Sign in again.",
        reason: "teacher",
        staffSessionEnded: true,
      },
      { status: 401 },
    );
  }
  const actor = actorOf(session);
  /* T210: which site issued this teacher's token, and which site the
   * counter is on. A probe that comes back refused is almost always one
   * of two things, a permission group or these two disagreeing, and the
   * second is invisible without saying so. */
  const siteId = session.siteId;
  const targetSiteId = currentSiteId();
  const gone = async () => {
    await endStaffSession(session.id);
    return NextResponse.json(
      {
        error:
          siteId !== null && targetSiteId !== null && siteId !== targetSiteId
            ? `That sign-in belongs to Mindbody site ${siteId} and this ` +
              `counter is on site ${targetSiteId}. Sign in again.`
            : "Mindbody no longer accepts that sign-in. Sign in again.",
        reason: "teacher",
        staffSessionEnded: true,
      },
      { status: 401, headers: { "set-cookie": staffClearCookie() } },
    );
  };

  let perms: any;
  try {
    perms = await mindbody(`/staff/staffpermissions?StaffId=${session.staffId}`, {
      actor,
    });
  } catch (err) {
    if (isActorTokenDead(err)) return gone();
    return NextResponse.json(
      {
        error: `Could not read the permission group: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
  const group = perms?.PermissionGroupName !== undefined ? perms : perms?.UserGroup ?? {};
  const allowedList = strings(group?.AllowedPermissions);
  const deniedList = strings(group?.DeniedPermissions);
  const allowed = NEEDED.map((name) => ({
    name,
    allowed: allowedList.includes(name) && !deniedList.includes(name),
  }));

  let sale:
    | { ok: true; total: number | null; item: string }
    | { ok: false; error: string; item: string | null }
    | { skipped: string }
    | { suppressed: true; item: string };
  const house = houseClientId();
  if (house === null) {
    sale = { skipped: "no POS_HOUSE_CLIENT_ID to attach the test cart to" };
  } else {
    try {
      const options = (await pricingOptions()).filter((o) => o.price > 0);
      options.sort((a, b) => a.price - b.price);
      const cheapest = options[0];
      if (!cheapest) {
        sale = { skipped: "no priced pricing option in the catalog" };
      } else {
        try {
          const priced = await priceCart(
            [
              {
                type: cheapest.type,
                metadataId: cheapest.id,
                quantity: 1,
                price: cheapest.price,
                taxExempt: cheapest.taxExempt,
                taxRate: cheapest.taxRate,
              },
            ],
            house,
            actor,
          );
          sale = priced.suppressed
            ? { suppressed: true, item: cheapest.name }
            : { ok: true, total: priced.grandTotal, item: cheapest.name };
        } catch (err) {
          if (isActorTokenDead(err)) return gone();
          sale = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            item: cheapest.name,
          };
        }
      }
    } catch (err) {
      sale = {
        ok: false,
        error: `Could not read the catalog: ${err instanceof Error ? err.message : String(err)}`,
        item: null,
      };
    }
  }

  return NextResponse.json({
    teacher: { id: session.staffId, name: session.name },
    tokenOk: true,
    /* T210: the site that issued the token these two reads ran under,
     * and the site they were sent to. Equal in every ordinary state. */
    siteId,
    targetSiteId,
    group: typeof group?.PermissionGroupName === "string" ? group.PermissionGroupName : null,
    ipRestricted: group?.IpRestricted === true,
    allowed,
    denied: deniedList,
    sale,
  });
}
