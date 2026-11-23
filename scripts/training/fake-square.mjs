#!/usr/bin/env node
/**
 * A fake Square, for driving the card reader (Phase 4, T224/T225) with no
 * network and no hardware. NOT Square: just the few endpoints this app
 * calls, in the shapes Square's docs give (checked 2026-11-22):
 *
 *   POST /v2/devices/codes                 device code, UNPAIRED
 *   GET  /v2/devices/codes/:id             PAIRED with device_id once paired
 *   POST /v2/terminals/checkouts           PENDING; idempotent by key
 *   GET  /v2/terminals/checkouts/:id
 *   POST /v2/terminals/checkouts/:id/cancel
 *   POST /v2/terminals/checkouts/search
 *   GET  /v2/payments/:id
 *   POST /v2/payments/:id/complete         APPROVED only
 *   POST /v2/payments/:id/cancel           APPROVED only
 *   PUT  /v2/payments/:id                  lower amount_money, APPROVED only
 *   GET  /v2/locations/:id
 *
 * The test's hands, not part of any Square API:
 *   POST /__fake/pair?code=ABCDEF          the code typed on the Terminal
 *   POST /__fake/tap?checkout=<id>&outcome=approve|decline|buyer-cancel|complete[&card=debit]
 *        approve leaves an APPROVED payment when autocomplete is false
 *        (the checkout reads COMPLETED, as Square's does); complete takes
 *        the money at the tap, which this app must treat as a problem
 *   POST /__fake/outside?amount=100        a payment taken in Square's Dashboard
 *   POST /__fake/race?n=1                  the next N cancels LOSE to a tap:
 *        the checkout ends COMPLETED with an APPROVED payment
 *   POST /__fake/fail?path=/v2/terminals/checkouts&n=1&status=500
 *   GET  /__fake/state                     everything, for a driver
 *
 *   node scripts/training/fake-square.mjs        # listens on :4020
 *   SQUARE_API_BASE_URL=http://127.0.0.1:4020 ...
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.FAKE_SQ_PORT ?? 4020);
const LOCATION = process.env.FAKE_SQ_LOCATION ?? "LFAKE1";

const codes = new Map();
const checkouts = new Map();
const payments = new Map();
const byKey = new Map();
let races = 0;
const fails = [];

const now = () => new Date().toISOString();
const err = (res, status, code, detail) =>
  send(res, status, { errors: [{ category: "INVALID_REQUEST_ERROR", code, detail }] });

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function failFor(path) {
  const i = fails.findIndex((f) => path.startsWith(f.path) && f.n > 0);
  if (i < 0) return null;
  fails[i].n -= 1;
  return fails[i].status;
}

function approve(c, completeAtTap = false, cardType = "CREDIT") {
  const pid = `pay_${randomUUID().slice(0, 12)}`;
  const auto = c.payment_options?.autocomplete !== false;
  payments.set(pid, {
    id: pid,
    status: auto || completeAtTap ? "COMPLETED" : "APPROVED",
    amount_money: { ...c.amount_money },
    location_id: LOCATION,
    reference_id: c.reference_id,
    terminal_checkout_id: c.id,
    note: c.note,
    card_details: { status: "AUTHORIZED", card: { card_brand: "VISA", last_4: "4242", card_type: cardType } },
    created_at: now(),
  });
  c.status = "COMPLETED";
  c.payment_ids = [pid];
  c.updated_at = now();
  return pid;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const q = url.searchParams;
  let body = {};
  if (req.method === "POST" || req.method === "PUT") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      return err(res, 400, "BAD_REQUEST", "invalid JSON");
    }
  }

  if (path.startsWith("/__fake/")) {
    if (path === "/__fake/pair") {
      const c = [...codes.values()].find((x) => x.code === q.get("code"));
      if (!c) return send(res, 404, { error: "no such code" });
      c.status = "PAIRED";
      c.device_id = q.get("device") ?? "SQFAKE0000004321";
      c.paired_at = now();
      return send(res, 200, c);
    }
    if (path === "/__fake/tap") {
      const c = checkouts.get(q.get("checkout") ?? "");
      if (!c) return send(res, 404, { error: "no such checkout" });
      const outcome = q.get("outcome") ?? "approve";
      const cardType = q.get("card") === "debit" ? "DEBIT" : "CREDIT";
      if (outcome === "approve") return send(res, 200, { payment_id: approve(c, false, cardType) });
      if (outcome === "complete") return send(res, 200, { payment_id: approve(c, true) });
      if (outcome === "buyer-cancel") {
        c.status = "CANCELED";
        c.cancel_reason = "BUYER_CANCELED";
        return send(res, 200, c);
      }
      if (outcome === "decline") {
        const pid = `pay_${randomUUID().slice(0, 12)}`;
        payments.set(pid, { id: pid, status: "FAILED", amount_money: { ...c.amount_money }, card_details: { status: "FAILED", card: { card_brand: "VISA", last_4: "0002" } } });
        c.status = "COMPLETED";
        c.payment_ids = [pid];
        return send(res, 200, c);
      }
      return send(res, 400, { error: "outcome?" });
    }
    if (path === "/__fake/outside") {
      /* T288: a payment taken in Square's Dashboard, not by this app. */
      const pid = `pay_${randomUUID().slice(0, 12)}`;
      payments.set(pid, { id: pid, status: "COMPLETED", amount_money: { amount: Number(q.get("amount") ?? 100), currency: "USD" }, location_id: LOCATION, card_details: { status: "CAPTURED", entry_method: "KEYED", card: { card_brand: "VISA", last_4: "1111" } }, created_at: now() });
      return send(res, 200, { payment_id: pid });
    }
    if (path === "/__fake/race") {
      races = Number(q.get("n") ?? 1) || 0;
      return send(res, 200, { races });
    }
    if (path === "/__fake/fail") {
      fails.push({ path: q.get("path") ?? "/", n: Number(q.get("n") ?? 1), status: Number(q.get("status") ?? 500) });
      return send(res, 200, { fails });
    }
    if (path === "/__fake/state") {
      return send(res, 200, { codes: [...codes.values()], checkouts: [...checkouts.values()], payments: [...payments.values()] });
    }
    return send(res, 404, { error: "unknown fake hand" });
  }

  if (!String(req.headers.authorization ?? "").startsWith("Bearer ")) {
    return err(res, 401, "UNAUTHORIZED", "missing token");
  }
  const forced = failFor(path);
  if (forced !== null) return err(res, forced, "INTERNAL_SERVER_ERROR", "fake failure");

  let m;
  if (req.method === "POST" && path === "/v2/devices/codes") {
    const id = `dc_${randomUUID().slice(0, 10)}`;
    const code = Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join("");
    const dc = { id, code, name: body.device_code?.name, product_type: "TERMINAL_API", location_id: body.device_code?.location_id ?? LOCATION, status: "UNPAIRED", pair_by: new Date(Date.now() + 5 * 60_000).toISOString(), created_at: now() };
    codes.set(id, dc);
    return send(res, 200, { device_code: dc });
  }
  if (req.method === "GET" && (m = path.match(/^\/v2\/devices\/codes\/([^/]+)$/))) {
    const dc = codes.get(m[1]);
    if (!dc) return err(res, 404, "NOT_FOUND", "Device code not found");
    if (dc.status === "UNPAIRED" && Date.parse(dc.pair_by) < Date.now()) return err(res, 404, "NOT_FOUND", "Device code not found");
    return send(res, 200, { device_code: dc });
  }
  if (req.method === "POST" && path === "/v2/terminals/checkouts") {
    const key = body.idempotency_key;
    if (!key) return err(res, 400, "MISSING_REQUIRED_PARAMETER", "idempotency_key is required");
    if (byKey.has(key)) return send(res, 200, { checkout: checkouts.get(byKey.get(key)) });
    const c = body.checkout ?? {};
    if (!c.device_options?.device_id) return err(res, 400, "MISSING_REQUIRED_PARAMETER", "device_id is required");
    if (!(c.amount_money?.amount > 0)) return err(res, 400, "INVALID_VALUE", "amount must be positive");
    const id = `chk_${randomUUID().slice(0, 12)}`;
    const co = { id, ...c, status: "PENDING", location_id: LOCATION, created_at: now(), updated_at: now(), deadline_duration: "PT5M" };
    checkouts.set(id, co);
    byKey.set(key, id);
    return send(res, 200, { checkout: co });
  }
  if (req.method === "POST" && path === "/v2/terminals/checkouts/search") {
    const dev = body.query?.filter?.device_id;
    const list = [...checkouts.values()].filter((c) => !dev || c.device_options?.device_id === dev).reverse();
    return send(res, 200, { checkouts: list });
  }
  if (req.method === "GET" && (m = path.match(/^\/v2\/terminals\/checkouts\/([^/]+)$/))) {
    const c = checkouts.get(m[1]);
    if (!c) return err(res, 404, "NOT_FOUND", "Checkout not found");
    return send(res, 200, { checkout: c });
  }
  if (req.method === "POST" && (m = path.match(/^\/v2\/terminals\/checkouts\/([^/]+)\/cancel$/))) {
    const c = checkouts.get(m[1]);
    if (!c) return err(res, 404, "NOT_FOUND", "Checkout not found");
    if (races > 0 && (c.status === "PENDING" || c.status === "IN_PROGRESS")) {
      races -= 1;
      approve(c);
      return send(res, 200, { checkout: c });
    }
    if (c.status === "COMPLETED" || c.status === "CANCELED") {
      return err(res, 400, "BAD_REQUEST", `Checkout is ${c.status}`);
    }
    c.status = "CANCELED";
    c.cancel_reason = "SELLER_CANCELED";
    c.updated_at = now();
    return send(res, 200, { checkout: c });
  }
  if (req.method === "GET" && path === "/v2/payments") {
    /* T231: the list the daily match reads, by location and time. */
    const begin = Date.parse(q.get("begin_time") ?? "") || 0;
    const end = Date.parse(q.get("end_time") ?? "") || Date.now() + 1;
    const list = [...payments.values()].filter((p) => {
      const t = Date.parse(p.created_at ?? "") || 0;
      return t >= begin && t < end;
    });
    return send(res, 200, { payments: list });
  }
  if (req.method === "GET" && (m = path.match(/^\/v2\/payments\/([^/]+)$/))) {
    const p = payments.get(m[1]);
    if (!p) return err(res, 404, "NOT_FOUND", "Payment not found");
    return send(res, 200, { payment: p });
  }
  if (req.method === "PUT" && (m = path.match(/^\/v2\/payments\/([^/]+)$/))) {
    /* T297: UpdatePayment, the amount LOWERED before completion. */
    const p = payments.get(m[1]);
    if (!p) return err(res, 404, "NOT_FOUND", "Payment not found");
    if (p.status !== "APPROVED") return err(res, 400, "BAD_REQUEST", `Payment is ${p.status}`);
    const amt = body?.payment?.amount_money?.amount;
    if (typeof amt !== "number" || amt <= 0 || amt > p.amount_money.amount) {
      return err(res, 400, "BAD_REQUEST", "amount_money may only be lowered");
    }
    p.amount_money = { ...p.amount_money, amount: amt };
    return send(res, 200, { payment: p });
  }
  if (req.method === "POST" && (m = path.match(/^\/v2\/payments\/([^/]+)\/(complete|cancel)$/))) {
    const p = payments.get(m[1]);
    if (!p) return err(res, 404, "NOT_FOUND", "Payment not found");
    if (p.status !== "APPROVED") return err(res, 400, "BAD_REQUEST", `Payment is ${p.status}`);
    p.status = m[2] === "complete" ? "COMPLETED" : "CANCELED";
    p.card_details.status = m[2] === "complete" ? "CAPTURED" : "VOIDED";
    return send(res, 200, { payment: p });
  }
  if (req.method === "GET" && (m = path.match(/^\/v2\/locations\/([^/]+)$/))) {
    if (m[1] !== LOCATION) return err(res, 404, "NOT_FOUND", "Location not found");
    return send(res, 200, { location: { id: LOCATION, name: "Sealevel (fake)" } });
  }
  return err(res, 404, "NOT_FOUND", `no fake for ${req.method} ${path}`);
});

server.listen(PORT, () => console.log(`[fake-square] listening on :${PORT}, location ${LOCATION}`));
