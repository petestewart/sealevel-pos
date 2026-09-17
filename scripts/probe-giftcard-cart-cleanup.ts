/**
 * Find today's comped sales for a client, say what they created, and
 * return them.
 *
 * Why this exists: `scripts/probe-giftcard-cart-sale.ts` made two real
 * comped sales on 2026-09-17 and could not return either, because it read
 * the sale id from `ShoppingCart.Id` and the checkout answer does not
 * carry one there. This project already knew that -- `latestSaleId` in
 * src/lib/sale.ts exists precisely because the sale has to be found by
 * re-reading `/sale/sales` afterwards (T63) -- and the probe did not use
 * it. So two comped sales of a gift card product are live and this script
 * is what closes them.
 *
 * It is also the probe's missing half: `/sale/sales` returns each sale's
 * purchased items, so it is the read that says whether a cart line of a
 * gift card product issued a CARD, and with what barcode, which the
 * checkout answer never mentioned.
 *
 * `/sale/sales` filters by date, sale id and payment method, never by
 * client (CLAUDE.md), so the client is matched on `Sale.ClientId` after
 * the read, exactly as `latestSaleId` does.
 *
 * A return goes out ONLY for a sale that is this client's, from today, and
 * paid entirely by Comp -- `returnsale` supports no other payment method
 * anyway (sale.yml:2056), and those three together are what keep this off
 * anybody else's money. It needs the word RETURN; without it the script
 * only looks.
 *
 * Usage, against prod:
 *
 *   # look
 *   MINDBODY_TARGET=prod npx tsx --env-file=.env \
 *     scripts/probe-giftcard-cart-cleanup.ts <clientId>
 *
 *   # look and undo
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/probe-giftcard-cart-cleanup.ts <clientId> RETURN
 *
 * A barcode printed here belongs to a live card until a return says
 * otherwise, and the number is what lets a human go and void it by hand.
 */
import { mindbody } from "../src/lib/mindbody";
import { studioWall } from "../src/lib/roster";

function money(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n)
    ? `$${n.toFixed(2)}`
    : "(none)";
}

function barcodesIn(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) {
    for (const item of v) barcodesIn(item, out);
    return out;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/barcode/i.test(k) && typeof val === "string" && val.trim()) {
        out.add(val.trim());
      }
      barcodesIn(val, out);
    }
  }
  return out;
}

async function balance(barcodeId: string): Promise<string> {
  try {
    const res: any = await mindbody(
      `/sale/giftcardbalance?barcodeId=${encodeURIComponent(barcodeId)}`,
    );
    return money(res?.RemainingBalance);
  } catch (err) {
    return `unreadable (${err instanceof Error ? err.message : String(err)})`;
  }
}

async function main(): Promise<void> {
  const [clientId, mode] = process.argv.slice(2);
  if (!clientId) {
    console.error(
      "Usage: npx tsx --env-file=.env " +
        "scripts/probe-giftcard-cart-cleanup.ts <clientId> [RETURN]",
    );
    process.exit(1);
  }
  const doReturn = mode === "RETURN";

  const now = new Date();
  const dayStart = `${studioWall(now).slice(0, 10)}T00:00:00`;
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dayEnd = `${studioWall(tomorrow).slice(0, 10)}T00:00:00`;
  const query =
    `request.startSaleDateTime=${encodeURIComponent(dayStart)}` +
    `&request.endSaleDateTime=${encodeURIComponent(dayEnd)}` +
    `&request.limit=200`;

  console.log(`\n=== sales from ${dayStart} to ${dayEnd}, client ${clientId}\n`);
  const body: any = await mindbody(`/sale/sales?${query}`);
  const sales: any[] = Array.isArray(body?.Sales) ? body.Sales : [];
  const mine = sales.filter((s) => String(s?.ClientId ?? "") === clientId);
  if (mine.length === 0) {
    console.log("  No sales today for that client.\n");
    return;
  }

  for (const sale of mine) {
    const payments: any[] = Array.isArray(sale?.Payments) ? sale.Payments : [];
    const kinds = payments.map(
      (p) => `${p?.Type ?? p?.Method ?? "?"} ${money(p?.Amount)}`,
    );
    const allComp = payments.length > 0 &&
      payments.every((p) =>
        /comp/i.test(String(p?.Type ?? p?.Method ?? "")),
      );
    console.log(
      `  sale ${sale?.Id ?? "(no id)"}  ${sale?.SaleDateTime ?? "(no time)"}` +
        `  ${kinds.join(", ") || "(no payments listed)"}` +
        `${allComp ? "  [comped]" : ""}`,
    );
    const items: any[] = Array.isArray(sale?.PurchasedItems)
      ? sale.PurchasedItems
      : [];
    for (const it of items) {
      console.log(
        `      item id ${it?.Id ?? "(none)"}  ${it?.Name ?? "(unnamed)"}` +
          `${it?.Type ? ` [${it.Type}]` : ""}  ${money(it?.Price ?? it?.Amount)}` +
          `${it?.Returned === true ? "  RETURNED" : ""}`,
      );
    }
    /* The whole sale, because the question is which field a gift card
     * would even appear in and no guess has found one yet. */
    console.log(`      raw: ${JSON.stringify(sale)}`);

    for (const code of barcodesIn(sale)) {
      console.log(`      CARD ${code}  balance ${await balance(code)}`);
    }

    if (!doReturn) continue;
    if (!allComp) {
      console.log("      not comped, so not returned from here.");
      continue;
    }
    const id = sale?.Id;
    if (typeof id !== "number") {
      console.log("      no numeric sale id, so it cannot be returned.");
      continue;
    }
    try {
      const ret: any = await mindbody("/sale/returnsale", {
        method: "POST",
        body: { SaleId: id, ReturnReason: "API probe, comped, voided" },
        clientId,
      });
      if (ret?.DryRun === true || ret?.WriteSuppressed === true) {
        console.log(
          "      !! THE RETURN WAS SUPPRESSED, so this sale is still live." +
            " Open both rails, or void it by hand.",
        );
        continue;
      }
      console.log(`      RETURNED sale ${id}.`);
      for (const code of barcodesIn(sale)) {
        console.log(`      card ${code} now: ${await balance(code)}`);
      }
    } catch (err) {
      console.log(
        `      !! RETURN FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.log(
        `      !! Sale ${id} is live. Void it by hand in Mindbody.`,
      );
    }
  }

  console.log(
    "\nIf no CARD line appeared for a gift card sale, the cart did not\n" +
      "issue a card that this API will name, which settles it: the cart is\n" +
      "not the route, whatever its totals do. Check the client's gift cards\n" +
      "in Mindbody's own UI to be sure, since a card the API will not name\n" +
      "may still exist.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
