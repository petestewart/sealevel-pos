/**
 * Smoke: SEA-112 follow-up — the QBO client (SEA-104), offline via the
 * injectable fetchImpl seam (the freshness.smoke fake-seam style). This
 * is the code that writes real Bills, so the contract is asserted
 * literally: the OAuth2 refresh flow and token cache, lookup-only vendor
 * resolution (a miss NEVER creates a vendor), the DocNumber pre-check
 * shape, the createBill body (VendorRef, DocNumber <period>-<mb_staff_id>,
 * and above all cents -> dollars on line amounts, where an error pays
 * 100x off), and the retryable/terminal error split the worker's
 * revert-vs-fail branch keys off.
 * Run: npm run smoke:qbo (from packages/core).
 */
import assert from "node:assert/strict";

import { QboClient, QboError, type QboConfig } from "./qbo.js";

const CONFIG: QboConfig = {
  clientId: "cid",
  clientSecret: "csecret",
  refreshToken: "rtok",
  realmId: "9130001",
  env: "sandbox",
};

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const API_BASE = "https://sandbox-quickbooks.api.intuit.com/v3/company/9130001";

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Fake fetch seam: records every call, answers from the route fn. */
function fakeFetch(route: (call: RecordedCall, n: number) => Response): {
  impl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      ),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return route(call, calls.length);
  };
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function tokenResponse(token: string, expiresIn = 3600): Response {
  return json({ access_token: token, expires_in: expiresIn });
}

async function testTokenRefreshAndCache(): Promise<void> {
  let tokens = 0;
  const seam = fakeFetch((call) => {
    if (call.url === TOKEN_URL) {
      tokens += 1;
      return tokenResponse(`tok${tokens}`);
    }
    return json({ QueryResponse: { Vendor: [{ Id: "V1" }] } });
  });
  const client = new QboClient(CONFIG, seam.impl);

  assert.equal(await client.findVendor("Kate Jarvis"), "V1");
  // Call 1 is the refresh POST, call 2 the original API call with the
  // fresh token.
  assert.equal(seam.calls.length, 2);
  const refresh = seam.calls[0]!;
  assert.equal(refresh.method, "POST");
  assert.equal(refresh.url, TOKEN_URL);
  assert.equal(
    refresh.headers["Authorization"],
    `Basic ${Buffer.from("cid:csecret").toString("base64")}`,
  );
  const form = new URLSearchParams(refresh.body ?? "");
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "rtok");
  const api = seam.calls[1]!;
  assert.equal(api.method, "GET");
  assert.equal(api.headers["Authorization"], "Bearer tok1");
  assert.ok(api.url.startsWith(`${API_BASE}/query?`));

  // Within the token's lifetime the next call reuses it: no second POST.
  assert.equal(await client.findVendor("Kate Jarvis"), "V1");
  assert.equal(tokens, 1);
  assert.equal(seam.calls[2]?.headers["Authorization"], "Bearer tok1");
  console.log("[smoke] qbo: refresh POST then Bearer call; token cached across calls");
}

async function testExpiredTokenReRefreshes(): Promise<void> {
  // expires_in 30s is inside the 60s early-refresh buffer, so EVERY api
  // call re-runs the refresh and carries the newest token.
  let tokens = 0;
  const seam = fakeFetch((call) =>
    call.url === TOKEN_URL
      ? (tokens += 1, tokenResponse(`tok${tokens}`, 30))
      : json({ QueryResponse: {} }),
  );
  const client = new QboClient(CONFIG, seam.impl);
  await client.findVendor("A");
  await client.findVendor("B");
  assert.equal(tokens, 2);
  const secondApi = seam.calls[3]!;
  assert.equal(secondApi.headers["Authorization"], "Bearer tok2");
  console.log("[smoke] qbo: near-expiry token re-refreshes before the retried call");
}

async function testTokenFailureClassification(): Promise<void> {
  const die500 = new QboClient(
    CONFIG,
    fakeFetch(() => json({}, 503)).impl,
  );
  await assert.rejects(die500.findVendor("X"), (err: unknown) => {
    assert.ok(err instanceof QboError);
    assert.equal(err.retryable, true, "5xx token failure is retryable");
    return true;
  });
  const die400 = new QboClient(
    CONFIG,
    fakeFetch(() => json({}, 400)).impl,
  );
  await assert.rejects(die400.findVendor("X"), (err: unknown) => {
    assert.ok(err instanceof QboError);
    assert.equal(err.retryable, false, "4xx token failure needs a human");
    return true;
  });
  console.log("[smoke] qbo: token failures split retryable (5xx) vs terminal (4xx)");
}

async function testVendorMissNeverCreates(): Promise<void> {
  const seam = fakeFetch((call) =>
    call.url === TOKEN_URL ? tokenResponse("tok1") : json({ QueryResponse: {} }),
  );
  const client = new QboClient(CONFIG, seam.impl);
  assert.equal(await client.findVendor("Nobody Here"), null);
  // The ONLY POST in the whole interaction is the token refresh: a
  // vendor miss must never turn into a vendor create (policy 10 -- a
  // payee appearing in QBO is a decision, not a side effect).
  const posts = seam.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.url, TOKEN_URL);
  assert.ok(
    !seam.calls.some((c) => /\/vendor/i.test(new URL(c.url).pathname)),
    "no call may touch a vendor write endpoint",
  );
  // And the lookup itself is the exact-DisplayName query.
  const query = seam.calls.find((c) => c.url.includes("/query?"));
  assert.ok(
    decodeURIComponent(query?.url ?? "").includes(
      "select Id from Vendor where DisplayName = 'Nobody Here'",
    ),
  );
  console.log("[smoke] qbo: vendor miss returns null, NEVER a vendor create");
}

async function testDocNumberPrecheckHit(): Promise<void> {
  // The QBO-side idempotency pre-check: a Bill already carrying the
  // DocNumber is found by query, and nothing POSTs to /bill.
  const DOC = "2026-08-03..2026-08-16-990003"; // <period>-<mb_staff_id>
  const seam = fakeFetch((call) =>
    call.url === TOKEN_URL
      ? tokenResponse("tok1")
      : json({ QueryResponse: { Bill: [{ Id: "B900" }] } }),
  );
  const client = new QboClient(CONFIG, seam.impl);
  assert.equal(await client.findBillByDocNumber(DOC), "B900");
  assert.ok(
    !seam.calls.some((c) => c.method === "POST" && c.url.includes("/bill")),
    "a pre-check hit must not be followed by a Bill write",
  );
  assert.ok(
    decodeURIComponent(seam.calls[1]?.url ?? "").includes(
      `select Id from Bill where DocNumber = '${DOC}'`,
    ),
  );

  // And a miss reads as null (the worker proceeds to createBill).
  const missSeam = fakeFetch((call) =>
    call.url === TOKEN_URL ? tokenResponse("tok1") : json({ QueryResponse: {} }),
  );
  assert.equal(
    await new QboClient(CONFIG, missSeam.impl).findBillByDocNumber(DOC),
    null,
  );
  console.log("[smoke] qbo: DocNumber pre-check hit returns the Bill id, no write");
}

async function testCreateBillBody(): Promise<void> {
  const seam = fakeFetch((call) =>
    call.url === TOKEN_URL
      ? tokenResponse("tok1")
      : json({ Bill: { Id: "B77", DocNumber: "2026-08-03..2026-08-16-990003" } }),
  );
  const client = new QboClient(CONFIG, seam.impl);
  const result = await client.createBill({
    vendorId: "V9",
    docNumber: "2026-08-03..2026-08-16-990003",
    txnDate: "2026-08-16",
    lines: [
      // 12345 CENTS. The Bill line must carry DOLLARS: 123.45, not 12345
      // (12345 would pay 100x) and not 1.2345.
      { description: "6 classes taught (period 2026-08-03..2026-08-16)", amountCents: 12345 },
      { description: "flat $75", amountCents: 7500 },
    ],
    memo: "ai-manager payroll 2026-08-03..2026-08-16, staff 990003",
  });
  assert.equal(result.billId, "B77");
  assert.equal(result.docNumber, "2026-08-03..2026-08-16-990003");

  const post = seam.calls.find((c) => c.method === "POST" && c.url.includes("/bill"));
  assert.ok(post, "createBill must POST to /bill");
  assert.ok(post.url.startsWith(`${API_BASE}/bill?`));
  const body = JSON.parse(post.body ?? "{}") as {
    VendorRef?: { value?: string };
    DocNumber?: string;
    TxnDate?: string;
    PrivateNote?: string;
    Line?: Array<{
      DetailType?: string;
      Amount?: number;
      Description?: string;
      AccountBasedExpenseLineDetail?: Record<string, unknown>;
    }>;
  };
  assert.equal(body.VendorRef?.value, "V9");
  assert.equal(body.DocNumber, "2026-08-03..2026-08-16-990003");
  assert.equal(body.TxnDate, "2026-08-16");
  assert.equal(body.PrivateNote, "ai-manager payroll 2026-08-03..2026-08-16, staff 990003");
  assert.equal(body.Line?.length, 2);
  assert.equal(body.Line?.[0]?.Amount, 123.45); // cents -> dollars, exactly
  assert.equal(body.Line?.[1]?.Amount, 75);
  assert.equal(body.Line?.[0]?.DetailType, "AccountBasedExpenseLineDetail");
  assert.equal(
    body.Line?.[0]?.Description,
    "6 classes taught (period 2026-08-03..2026-08-16)",
  );
  // No expenseAccountId configured: detail stays empty (QBO's default
  // account resolution), no invented AccountRef.
  assert.deepEqual(body.Line?.[0]?.AccountBasedExpenseLineDetail, {});

  // With an expense account configured, every line carries the ref.
  const seam2 = fakeFetch((call) =>
    call.url === TOKEN_URL ? tokenResponse("tok1") : json({ Bill: { Id: "B78" } }),
  );
  await new QboClient({ ...CONFIG, expenseAccountId: "61" }, seam2.impl).createBill({
    vendorId: "V9",
    docNumber: "D-1",
    txnDate: "2026-08-16",
    lines: [{ description: "x", amountCents: 100 }],
  });
  const body2 = JSON.parse(
    seam2.calls.find((c) => c.method === "POST" && c.url.includes("/bill"))?.body ?? "{}",
  ) as { PrivateNote?: string; Line?: Array<{ Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } } }> };
  assert.equal(body2.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.value, "61");
  assert.equal(body2.Line?.[0]?.Amount, 1);
  assert.equal(body2.PrivateNote, undefined, "no memo, no PrivateNote key");

  // A write that comes back without a Bill.Id is a terminal error, never
  // a silent success.
  const noId = new QboClient(
    CONFIG,
    fakeFetch((call) =>
      call.url === TOKEN_URL ? tokenResponse("tok1") : json({ Bill: {} }),
    ).impl,
  );
  await assert.rejects(
    noId.createBill({
      vendorId: "V9",
      docNumber: "D-2",
      txnDate: "2026-08-16",
      lines: [{ description: "x", amountCents: 100 }],
    }),
    (err: unknown) => {
      assert.ok(err instanceof QboError);
      assert.equal(err.retryable, false);
      return true;
    },
  );
  console.log("[smoke] qbo: createBill body shape holds; 12345 cents -> Amount 123.45");
}

async function testApiErrorClassification(): Promise<void> {
  const cases: Array<[number, boolean]> = [
    [500, true],
    [429, true],
    [400, false],
    [403, false],
  ];
  for (const [status, retryable] of cases) {
    const client = new QboClient(
      CONFIG,
      fakeFetch((call) =>
        call.url === TOKEN_URL ? tokenResponse("tok1") : json({ Fault: {} }, status),
      ).impl,
    );
    await assert.rejects(client.findVendor("X"), (err: unknown) => {
      assert.ok(err instanceof QboError);
      assert.equal(err.retryable, retryable, `HTTP ${status} retryable=${retryable}`);
      return true;
    });
  }
  // Non-JSON 200 is terminal too: never parse garbage into a payment.
  const garbage = new QboClient(
    CONFIG,
    fakeFetch((call) =>
      call.url === TOKEN_URL
        ? tokenResponse("tok1")
        : new Response("<html>proxy error</html>", { status: 200 }),
    ).impl,
  );
  await assert.rejects(garbage.findVendor("X"), (err: unknown) => {
    assert.ok(err instanceof QboError);
    assert.equal(err.retryable, false);
    return true;
  });
  console.log("[smoke] qbo: 5xx/429 retryable, 4xx/non-JSON terminal");
}

async function main(): Promise<void> {
  await testTokenRefreshAndCache();
  await testExpiredTokenReRefreshes();
  await testTokenFailureClassification();
  await testVendorMissNeverCreates();
  await testDocNumberPrecheckHit();
  await testCreateBillBody();
  await testApiErrorClassification();
  console.log("[smoke] qbo: all passed");
}

await main();
