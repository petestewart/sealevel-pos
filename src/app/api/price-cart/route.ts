import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession, verifyCompToken } from "@/lib/auth";
import { mindbodyHttpStatus, type Actor } from "@/lib/mindbody";
import {
  OVERRIDE_PURPOSE,
  parseOverride,
  type OverrideAsk,
} from "@/lib/override";
import { resolveSubstitute } from "@/lib/substitute";
import {
  discountCents,
  discountRefusal,
  parseDiscount,
  spreadDiscount,
  subtotalCents,
  type Discount,
} from "@/lib/comp";

import {
  expectedSubtotal,
  expectedTotal,
  groupByRecipient,
  houseClientId,
  parseCartLines,
  passWithoutOwner,
  plainRefusal,
  priceCart,
  roundToCents,
  splitDiscount,
  type CartLine,
  type PricedCart,
} from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * POST /api/price-cart  { items: CartLine[], clientId?: string,
 *                         discount?: { mode: "amount"|"percent", value } }
 *
 * T79: an optional whole-cart `discount`, validated here against the
 * lines' pre-tax subtotal (parseDiscount) and refused for a cart with a
 * package line (discountRefusal); the per-line amounts are recomputed
 * server-side by priceCart from the validated lines and never read
 * from the browser. The answer adds `expectedDiscount` and
 * `discountDisagrees`, and `disagrees` covers both checks.
 *
 * Prices a cart on Mindbody's side (Test: true, LocationId 1, InStore).
 * Moves no money by construction; see priceCart. The response carries the
 * server's totals, our local expectation, and `disagrees` -- when that is
 * true the UI must render an error, because a mismatched total means the
 * cart was priced somewhere other than the studio. `suppressed: true`
 * (prod dry run, or the write guard on an anonymous cart) means no total
 * exists and the UI must say so rather than show a number.
 *
 * Mindbody refuses to price a cart with no client at all, Test: true
 * included (confirmed live 2026-08-30: "At least one of the following
 * parameters must be passed: ClientId, UniqueClientId"). So when no
 * client is attached this route substitutes POS_HOUSE_CLIENT_ID
 * server-side (the UI still shows "nobody"), and when that is not
 * configured either it answers `needsClient: true` immediately -- no
 * Mindbody call, no metered request -- carrying only the local
 * expectedTotal for the UI to label as an estimate, never a chargeable
 * total.
 *
 * Validation lives in parseCartLines (src/lib/sale.ts), shared with
 * /api/checkout: the cart that gets charged obeys the same bounds as the
 * cart that got priced.
 *
 * T112: an optional `override`, the same envelope /api/checkout takes and
 * verified the same way (purpose "override", this teacher's own id, never
 * spent here). It does exactly two things and may never do more:
 *
 *  - "attempt": the Test call runs under the TEACHER'S token instead of
 *    the service account, so a pass the studio account refuses but the
 *    teacher's login sells prices on the ticket instead of dropping off
 *    it again on the next keystroke. The ticket's total is still
 *    Mindbody's own and still asserted.
 *  - "substitute": the discount that brings the substitute pass down to
 *    the refused pass's price is computed HERE, from the stored mapping
 *    and the live catalog, so the number under the ticket is the number
 *    the charge will use. The browser cannot send it and is refused if it
 *    sends a discount of its own beside it.
 *
 * With no override the route is byte-for-byte what it was: reads stay on
 * the service account, and no sign-in is required to price a cart.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = parseCartLines(payload?.items);
  if (parsed.error !== null) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const clientId =
    typeof payload?.clientId === "string" && payload.clientId.trim()
      ? payload.clientId.trim()
      : undefined;
  /* T112: the override, before anything that could reach Mindbody. */
  let override: OverrideAsk | null = null;
  let overrideActor: Actor | null = null;
  if (payload?.override !== undefined && payload?.override !== null) {
    const asked = parseOverride(payload.override);
    if (typeof asked === "string") {
      return NextResponse.json({ error: asked }, { status: 400 });
    }
    /* An override names a teacher, so pricing one needs the sign-in that
     * every write needs (T50): the token below can only have been minted
     * for the teacher this session names. */
    const staff = await requireActor(request);
    if (staff.denied) return staff.denied;
    const teacher = verifyCompToken(asked.token, OVERRIDE_PURPOSE);
    if (teacher === null || teacher.id !== staff.session.staffId) {
      return NextResponse.json(
        { error: "Enter your PIN to override this pass.", reason: "teacher" },
        { status: 401 },
      );
    }
    override = asked;
    /* Only the attempt changes who asks. A substitution prices normally:
     * it is a different pass with a discount on it. */
    if (override.mode === "attempt") overrideActor = staff.actor;
  }
  /* T92: a pass with no home never reaches Mindbody. On a cart with
   * nobody attached, a Service or Package line must carry a T90
   * recipient; the house client is for retail and is deliberately not a
   * fallback for a pass. Checked before the discount, because a ticket
   * that cannot be sold should not be priced at all. */
  const orphanPass = passWithoutOwner(parsed.items, clientId);
  if (orphanPass !== null) {
    return NextResponse.json({ error: orphanPass }, { status: 400 });
  }
  /* T79: the discount, checked before any Mindbody call. */
  let discount: Discount | null = null;
  /* T112: the substitution's own discount, computed from the live
   * catalog, never taken from the browser. Refused beside a discount of
   * the browser's own, exactly as /api/checkout refuses it, so the
   * ticket and the charge cannot disagree about which one applies. */
  if (override?.mode === "substitute") {
    if (payload?.discount !== undefined && payload?.discount !== null) {
      return NextResponse.json(
        {
          error:
            "A substituted pass is already discounted to the refused " +
            "pass's price, so this ticket cannot take another discount.",
        },
        { status: 409 },
      );
    }
    const substitution = await resolveSubstitute(override.metadataId);
    const subLine =
      substitution === null
        ? undefined
        : parsed.items.find(
            (line) =>
              line.type === "Service" &&
              String(line.metadataId) === substitution.metadataId,
          );
    if (substitution === null || subLine === undefined) {
      return NextResponse.json(
        {
          error:
            "There is no substitute pass configured for that one, or this " +
            "ticket does not hold it.",
        },
        { status: 409 },
      );
    }
    if (substitution.discount > 0) {
      const d = parseDiscount(
        {
          mode: "amount",
          value: roundToCents(substitution.discount * subLine.quantity),
        },
        subtotalCents(parsed.items),
      );
      if (typeof d === "string") {
        return NextResponse.json({ error: d }, { status: 409 });
      }
      discount = d;
    }
  } else if (payload?.discount !== undefined && payload?.discount !== null) {
    const refusal = discountRefusal(parsed.items);
    if (refusal !== null) {
      return NextResponse.json({ error: refusal }, { status: 400 });
    }
    const d = parseDiscount(payload.discount, subtotalCents(parsed.items));
    if (typeof d === "string") {
      return NextResponse.json({ error: d }, { status: 400 });
    }
    discount = d;
  }
  /* T112: a refusal check the browser's discount got at the top of its
   * own branch, applied to the substitution's too: Mindbody ignores a
   * discount on a package line, so a ticket holding one cannot carry
   * either kind. */
  if (discount !== null) {
    const refusal = discountRefusal(parsed.items);
    if (refusal !== null) {
      return NextResponse.json({ error: refusal }, { status: 400 });
    }
  }
  /* No client attached: price as the house client when one is configured;
   * otherwise answer needsClient without touching Mindbody (the call is
   * known to fail, so firing it would cost a metered request to learn
   * nothing). */
  const effectiveClientId = clientId ?? houseClientId() ?? undefined;
  if (!effectiveClientId) {
    return NextResponse.json({
      needsClient: true,
      suppressed: false,
      subTotal: null,
      discountTotal: null,
      taxTotal: null,
      grandTotal: null,
      expectedTotal: expectedTotal(
        parsed.items,
        discount ? spreadDiscount(parsed.items, discount) : undefined,
      ),
      expectedSubtotal: expectedSubtotal(parsed.items),
      expectedDiscount: discount ? discountCents(parsed.items, discount) / 100 : 0,
      discountDisagrees: false,
      disagrees: false,
      /* Honest even here: a package's estimate is a component-sum guess
       * (see sale.ts sellablePackages), so the UI can label it. */
      packagePricing: parsed.items.some((l) => l.type === "Package"),
      usedPaymentStub: false,
    });
  }
  /* T90: a line bought for another client is its own cart under THAT
   * client's id (see groupByRecipient), so a ticket holding one is
   * priced once per recipient and the answer carries the sum plus each
   * cart's own figures. The paying client's cart is first. A ticket with
   * no other-client line takes exactly the single call it always did. */
  const groups = groupByRecipient(parsed.items, effectiveClientId);
  const perGroupDiscount =
    discount === null
      ? groups.map(() => null)
      : splitDiscount(parsed.items, discount, groups);
  try {
    if (groups.length === 1 && groups[0]?.forClientId == null) {
      const priced = await priceCart(
        parsed.items,
        effectiveClientId,
        overrideActor,
        discount,
      );
      return NextResponse.json(priced);
    }
    const carts: {
      forClientId: string | null;
      clientId: string;
      priced: PricedCart;
    }[] = [];
    for (const [i, group] of groups.entries()) {
      const cartClientId = group.forClientId ?? effectiveClientId;
      carts.push({
        forClientId: group.forClientId,
        clientId: cartClientId,
        priced: await priceCart(
          group.items,
          cartClientId,
          overrideActor,
          perGroupDiscount[i] ?? null,
        ),
      });
    }
    /* The screen's total is the sum of MINDBODY's grand totals, never a
     * browser number and never a local estimate standing in for one: one
     * cart Mindbody could not price (or a suppressed write) makes the
     * whole ticket's total absent, exactly as a single cart's does. */
    const sum = (pick: (c: PricedCart) => number | null): number | null => {
      let total = 0;
      for (const c of carts) {
        const v = pick(c.priced);
        if (v === null) return null;
        total += v;
      }
      return roundToCents(total);
    };
    const audits = carts.flatMap((c) => c.priced.lineAudit ?? []);
    return NextResponse.json({
      suppressed: carts.some((c) => c.priced.suppressed),
      subTotal: sum((c) => c.subTotal),
      discountTotal: sum((c) => c.discountTotal),
      taxTotal: sum((c) => c.taxTotal),
      grandTotal: sum((c) => c.grandTotal),
      expectedTotal: roundToCents(
        carts.reduce((n, c) => n + c.priced.expectedTotal, 0),
      ),
      expectedSubtotal: roundToCents(
        carts.reduce((n, c) => n + c.priced.expectedSubtotal, 0),
      ),
      expectedDiscount: roundToCents(
        carts.reduce((n, c) => n + c.priced.expectedDiscount, 0),
      ),
      /* Any cart disagreeing stops the whole ticket: the carts are one
       * sale to the teacher, and a stop on part of it is a stop. */
      discountDisagrees: carts.some((c) => c.priced.discountDisagrees),
      disagrees: carts.some((c) => c.priced.disagrees),
      packagePricing: carts.some((c) => c.priced.packagePricing),
      usedPaymentStub: carts.every((c) => c.priced.usedPaymentStub),
      ...(audits.length > 0 ? { lineAudit: audits } : {}),
      /* What the screen needs to name each cart: whose it is and what
       * Mindbody priced it at. */
      carts: carts.map((c) => ({
        forClientId: c.forClientId,
        clientId: c.clientId,
        grandTotal: c.priced.grandTotal,
        subTotal: c.priced.subTotal,
        expectedSubtotal: c.priced.expectedSubtotal,
        expectedDiscount: c.priced.expectedDiscount,
        suppressed: c.priced.suppressed,
        disagrees: c.priced.disagrees,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    /* A 4xx is Mindbody refusing the CART, not failing (Pete, 2026-09-14,
     * "Only new clients qualify for this intro series." sat in red under
     * the ticket with the line still in it: "this failure needs to be
     * graceful. the item should be removed from the cart and a clean
     * message should explain why"). Mindbody's message names no line, so
     * with more than one the lines are Test-priced one at a time, same
     * client, no discount, and the ones refused alone are named; the
     * screen removes those and says why in Mindbody's words minus the
     * "mb.Core.BLL.ShoppingCart failed validation" noise. Bounded by the
     * cart's length in metered calls, and only after a refusal. A 5xx or
     * a dead transport stays a plain error: nothing is removed on a
     * failure that said nothing about the lines. */
    const status = mindbodyHttpStatus(err);
    if (status !== null && status < 500) {
      const refused = await refusedLines(parsed.items, effectiveClientId, message);
      return NextResponse.json(
        { error: plainRefusal(message), refused },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/** Which lines Mindbody refuses on their own. One line: that one, with
 *  the cart's reason. Several: each priced alone; a line whose lone
 *  pricing throws a 4xx is refused with that answer's reason. A line
 *  whose lone pricing fails some other way (5xx, transport) is left
 *  alone: not proven refused. When none is refused alone (the refusal
 *  was about the combination, or about the client), the list is empty
 *  and the screen shows the reason without removing anything. */
async function refusedLines(
  items: CartLine[],
  clientId: string,
  cartReason: string,
): Promise<{ type: CartLine["type"]; metadataId: string; reason: string }[]> {
  const first = items[0];
  if (items.length === 1 && first) {
    return [
      { type: first.type, metadataId: String(first.metadataId), reason: plainRefusal(cartReason) },
    ];
  }
  const out: { type: CartLine["type"]; metadataId: string; reason: string }[] = [];
  for (const line of items) {
    try {
      await priceCart([line], clientId, null, null);
    } catch (err) {
      const status = mindbodyHttpStatus(err);
      if (status !== null && status < 500) {
        out.push({
          type: line.type,
          metadataId: String(line.metadataId),
          reason: plainRefusal(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }
  return out;
}
