import { NextResponse } from "next/server";

import {
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession, verifyCompToken } from "@/lib/auth";
import { isActorRefusal, mindbodyHttpStatus } from "@/lib/mindbody";
import {
  OVERRIDE_PURPOSE,
  OVERRIDE_REFUSED_ADVICE,
  OVERRIDE_REFUSED_WAYS_OUT,
  parseOverride,
} from "@/lib/override";
import { plainRefusal, priceCart, pricingOptions } from "@/lib/sale";
import { resolveSubstitute, substituteSentence } from "@/lib/substitute";

export const dynamic = "force-dynamic";

/**
 * POST /api/override-pass -- T112's ATTEMPT, and nothing else.
 *
 * Pete: "'New Student 2 Week Unlimited was removed from the sale: Only
 * new clients qualify for this intro series.' this needs to have the
 * ability to override, like other things in the app. teacher PIN and
 * reason can be given."
 *
 * Body: { clientId, override: { token, reason, metadataId, pass,
 * refusal } }. It asks Mindbody ONE question: does this pricing option
 * price for this client under THIS TEACHER'S own token, when it did not
 * under the studio's? `Test: true`, one line, no discount, no payment
 * that could move (priceCart's Comp stub), so the answer costs a metered
 * call and nothing else.
 *
 * It moves no money and it sells nothing. A yes puts the line back on
 * the ticket with the override armed, and the ordinary Pay flow sells it
 * with the same rehearsal, the same total assertion (T75) and the same
 * basket assertion (T103) as every other sale. A no is reported in
 * Mindbody's own words, with the fallback offers under it.
 *
 * The PIN token is VERIFIED here and deliberately NOT SPENT: this call
 * reaches no cart that could be charged, so a refusal must not cost the
 * teacher their one-shot authorization. It is spent once, at
 * /api/checkout, by the sale it authorized.
 *
 * The line is built from the LIVE catalog, never from the browser: the
 * request carries the pass's id and nothing about its price. An override
 * may not set a price, and this is the shape that makes that true rather
 * than promised.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: the teacher is the whole point of the question, so no session,
   * no call. Before the body is read. */
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const ask = parseOverride(payload?.override);
  if (typeof ask === "string") {
    return NextResponse.json({ error: ask }, { status: 400 });
  }
  /* This route is the attempt. A substitution needs no attempt at all
   * (the substitute prices normally), so asking for one here would be a
   * caller that does not know what it wants. */
  if (ask.mode !== "attempt") {
    return NextResponse.json(
      { error: "this route attempts the refused pass; a substitution is sold at checkout" },
      { status: 400 },
    );
  }
  /* T48/T94 review: the token's own purpose, and this teacher's. A PIN
   * typed to discount a sale does not authorize this, and a token
   * carried across a sign-out names somebody who is not behind the tap.
   * Checked before any Mindbody call, and NOT spent (see above). */
  const teacher = verifyCompToken(ask.token, OVERRIDE_PURPOSE);
  if (teacher === null || teacher.id !== session.staffId) {
    return NextResponse.json(
      { error: "Enter your PIN to override this pass.", reason: "teacher" },
      { status: 401 },
    );
  }
  const clientId =
    typeof payload?.clientId === "string" && payload.clientId.trim()
      ? payload.clientId.trim()
      : null;
  /* T92's rule, unchanged: a pass goes on a Mindbody account. With
   * nobody attached there is nothing to ask Mindbody ABOUT, since the
   * rule is about who the pass is for. */
  if (clientId === null) {
    return NextResponse.json(
      {
        error:
          "A pass goes on a Mindbody account. Attach the client this pass " +
          "is for, or buy it for another client.",
      },
      { status: 400 },
    );
  }

  /* The pass, priced by Mindbody's own catalog. The browser sent an id. */
  let options;
  try {
    options = await pricingOptions();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
  const pass = options.find((o) => String(o.id) === ask.metadataId);
  if (!pass) {
    return NextResponse.json(
      {
        error:
          "That pass is no longer in the catalog, so it cannot be sold to " +
          "anybody. Refresh the shelf.",
      },
      { status: 409 },
    );
  }

  try {
    /* Under the TEACHER's token, with T49's fallback deliberately OFF:
     * the service account is the one that already refused this pass, so
     * re-asking it would answer a question nobody asked and could report
     * the studio's refusal as the teacher's. A dead token ends the
     * session and is answered as a dead token, not as a refusal of the
     * pass. */
    const run = await runAsActor(
      session,
      "/api/override-pass",
      (a) =>
        priceCart(
          [
            {
              type: "Service",
              metadataId: pass.id,
              quantity: 1,
              price: pass.price,
              taxExempt: pass.taxExempt,
              taxRate: pass.taxRate,
            },
          ],
          clientId,
          a,
          null,
        ),
      { fallback: false },
    );
    const priced = run.result;
    /* Dry run or the write guard: the question was never asked, so the
     * answer must not read as a yes. `Test: true` moves no money, but
     * our wrapper counts every POST as a write (see PricedCart
     * .suppressed), and a suppressed attempt that armed an override
     * would arm it on no evidence at all. */
    if (priced.suppressed) {
      return NextResponse.json({ ok: false, suppressed: true });
    }
    console.log(
      `[override] ${ask.mode} accepted client=${clientId} ` +
        `pass=${ask.metadataId} teacher=${teacher.id}`,
    );
    return NextResponse.json({
      ok: true,
      total: priced.grandTotal,
      teacher: { id: teacher.id, name: teacher.name },
    });
  } catch (err) {
    /* T50 review: the teacher's token died under the attempt. Nothing
     * was written, and the gate comes back saying so. */
    const ended = staffSessionEndedResponse(err);
    if (ended) return ended;
    const status = mindbodyHttpStatus(err);
    const message = err instanceof Error ? err.message : String(err);
    /* Mindbody refused the CALLER, not the pass: a permission gap in the
     * teacher's group (T49). Reported as itself, because telling a
     * teacher "Mindbody will never sell this pass" when what it said was
     * "you may not make sales" would send the studio chasing the wrong
     * thing. */
    if (isActorRefusal(err)) {
      return NextResponse.json(
        {
          error:
            `Mindbody refused your login rather than the pass: ${message} ` +
            "Nothing was charged and your PIN was not used.",
          stage: "permission",
        },
        { status: 403 },
      );
    }
    /* A 5xx or a dead transport says NOTHING about the rule, so it is
     * not reported as a refusal: a teacher told "Mindbody refuses this
     * under every login" by a timeout would stop asking. */
    if (status === null || status >= 500) {
      return NextResponse.json(
        { error: message, stage: "attempt" },
        { status: 502 },
      );
    }
    const refusal = plainRefusal(message);
    /* Pete's fallback, resolved live: the substitute pass and both
     * prices, or null when no mapping is configured or the catalog
     * cannot price one. The teacher's token is not spent, so the same
     * token authorizes the substitution if they take it. */
    let substitute = null;
    try {
      substitute = await resolveSubstitute(ask.metadataId, options);
    } catch (e) {
      console.warn(
        `[substitute] could not resolve a substitute for ${ask.metadataId}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    console.log(
      `[override] attempt refused client=${clientId} pass=${ask.metadataId} ` +
        `teacher=${teacher.id} substitute=${substitute?.metadataId ?? "none"}`,
    );
    return NextResponse.json({
      ok: false,
      refusal,
      advice:
        OVERRIDE_REFUSED_ADVICE +
        (substitute === null ? ` ${OVERRIDE_REFUSED_WAYS_OUT}` : ""),
      substitute:
        substitute === null
          ? null
          : {
              metadataId: substitute.metadataId,
              name: substitute.name,
              price: substitute.price,
              sellAt: substitute.sellAt,
              discount: substitute.discount,
              taxRate: substitute.taxRate,
              taxExempt: substitute.taxExempt,
              sentence: substituteSentence(substitute),
            },
    });
  }
}
