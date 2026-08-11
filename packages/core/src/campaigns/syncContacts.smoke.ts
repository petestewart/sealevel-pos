import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  CampaignStore,
  ContactUpsert,
  LiveContact,
} from "../db/campaignContacts.js";
import {
  extractClientRecord,
  fetchAllClients,
  MINDBODY_OPT_IN_FIELD,
} from "./mindbody.js";
import { reconcileIdMapping, SYNC_AMBIGUOUS_PREFIX } from "./reconcile.js";
import {
  DUPLICATE_AMBIGUOUS_PREFIX,
  syncContacts,
  type SyncContactsDeps,
} from "./syncContacts.js";

/**
 * Offline smoke for campaigns.sync_contacts (SEA-81). Everything is
 * served by local mocks: no Mindbody API, Postgres, or MCP server is
 * touched. The DB layer itself (partial-index upsert, append-only
 * trigger) is exercised by the real schema in migrations/0011+0012 and a
 * local `npm run migrate` against docker compose, per repo convention.
 *
 * Run: npm run smoke:synccontacts  (from packages/core)
 */

const ENV_VARS = [
  "MINDBODY_API_KEY",
  "MINDBODY_SITE_ID",
  "MINDBODY_STAFF_USERNAME",
  "MINDBODY_STAFF_PASSWORD",
  "MINDBODY_API_BASE_URL",
  "SEALEVEL_MCP_URL",
  "SEALEVEL_MCP_ANALYTICS_TOKEN",
] as const;

function withEnv<T>(
  values: Partial<Record<(typeof ENV_VARS)[number], string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = ENV_VARS.map((v) => [v, process.env[v]] as const);
  for (const v of ENV_VARS) {
    const value = values[v];
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
  return fn().finally(() => {
    for (const [v, val] of saved) {
      if (val === undefined) delete process.env[v];
      else process.env[v] = val;
    }
  });
}

/** A raw Mindbody v6 Client object as the API returns it. */
function mbClient(
  id: string,
  email: string | null,
  promo: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    Id: id,
    UniqueId: Number(id.replace(/\D/g, "") || "0"),
    FirstName: "Test",
    LastName: `Client${id}`,
    Email: email,
    SendAccountEmails: true,
    SendPromotionalEmails: promo,
    SendScheduleEmails: false,
    SendPromotionalTexts: false,
    ...extra,
  };
}

/** In-memory CampaignStore recording every mutation for assertions. */
class FakeStore implements CampaignStore {
  contacts = new Map<
    string,
    ContactUpsert & { id: string; isAmbiguous: boolean; ambiguousReason: string | null; analyticsClientId: string | null }
  >();
  consent: Array<{
    contactId: string;
    email: string;
    state: "subscribed" | "unsubscribed";
    source: string;
    detail: string;
  }> = [];
  lastSyncedAt = new Date(0);
  advancedTo: Date | null = null;
  private nextId = 1;

  async upsertContact(contact: ContactUpsert) {
    const existing = [...this.contacts.values()].find(
      (c) => c.mbClientId === contact.mbClientId,
    );
    if (existing) {
      Object.assign(existing, contact);
      return { id: existing.id, email: existing.email };
    }
    const id = String(this.nextId++);
    this.contacts.set(id, {
      ...contact,
      id,
      isAmbiguous: false,
      ambiguousReason: null,
      analyticsClientId: null,
    });
    return { id, email: contact.email };
  }
  async latestConsent(contactId: string) {
    const events = this.consent.filter((e) => e.contactId === contactId);
    const last = events[events.length - 1];
    return last
      ? { state: last.state, source: last.source as never }
      : null;
  }
  async appendConsentEvent(event: {
    contactId: string;
    email: string;
    state: "subscribed" | "unsubscribed";
    source: string;
    detail: string;
  }) {
    this.consent.push(event);
  }
  async markContactAmbiguous(contactId: string, reason: string) {
    const c = this.contacts.get(contactId)!;
    c.isAmbiguous = true;
    c.ambiguousReason = reason;
  }
  async clearSyncAmbiguity(contactId: string, prefix: string) {
    const c = this.contacts.get(contactId)!;
    if (c.isAmbiguous && (c.ambiguousReason ?? "").startsWith(prefix)) {
      c.isAmbiguous = false;
      c.ambiguousReason = null;
    }
  }
  async setAnalyticsClientId(contactId: string, analyticsClientId: string | null) {
    this.contacts.get(contactId)!.analyticsClientId = analyticsClientId;
  }
  async listLiveContacts(): Promise<LiveContact[]> {
    return [...this.contacts.values()].map((c) => ({
      id: c.id,
      mbClientId: c.mbClientId,
      email: c.email,
      isAmbiguous: c.isAmbiguous,
      ambiguousReason: c.ambiguousReason,
      analyticsClientId: c.analyticsClientId,
    }));
  }
  async countConsented() {
    let n = 0;
    for (const c of this.contacts.values()) {
      const last = await this.latestConsent(c.id);
      if (last?.state === "subscribed") n += 1;
    }
    return n;
  }
  async countAmbiguous() {
    return [...this.contacts.values()].filter((c) => c.isAmbiguous).length;
  }
  async readSyncState() {
    return { lastSyncedAt: this.lastSyncedAt };
  }
  async advanceSyncState(runStartedAt: Date) {
    this.advancedTo = runStartedAt;
  }
}

function depsWith(
  store: FakeStore,
  pages: Array<Array<Record<string, unknown>>>,
  captured?: { modifiedSince?: string },
): SyncContactsDeps {
  return {
    fetchAllClients: async function* (options = {}) {
      if (captured) captured.modifiedSince = options.modifiedSince;
      for (const page of pages) yield page.map(extractClientRecord);
    },
    store,
    reconcile: () => {
      throw new Error("reconcile should not be called in this test");
    },
    log: () => {},
  };
}

const MB_ENV = { MINDBODY_API_KEY: "key", MINDBODY_SITE_ID: "12345" };

async function testConfigGate(): Promise<void> {
  await withEnv({}, async () => {
    const store = new FakeStore();
    const result = await syncContacts(depsWith(store, []));
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "mindbody_unconfigured");
    assert.equal(store.advancedTo, null); // watermark untouched on skip
  });
  console.log("[smoke] sync_contacts: config gate (unset Mindbody env = logged skip)");
}

function testExtractClientRecord(): void {
  const record = extractClientRecord(mbClient("100000171", "a@b.com", true));
  assert.equal(record.mbClientId, "100000171");
  assert.equal(record.subscribed, true);
  assert.equal(record.optInFieldName, MINDBODY_OPT_IN_FIELD);
  // The evidence blob keeps all consent fields + ids, verbatim.
  assert.equal(record.optInRaw["SendPromotionalEmails"], true);
  assert.equal(record.optInRaw["UniqueId"], 100000171);
  // Missing consent field: consent is never guessed.
  const broken = mbClient("7", "a@b.com", true);
  delete broken["SendPromotionalEmails"];
  assert.throws(
    () => extractClientRecord(broken),
    /SendPromotionalEmails.*Send\* fields present/s,
  );
  // Non-boolean consent field: same failure, loudly.
  assert.throws(
    () => extractClientRecord(mbClient("8", "a@b.com", "yes" as never)),
    /no boolean SendPromotionalEmails/,
  );
  assert.throws(() => extractClientRecord({ Email: "x@y.z" }), /no usable Id/);
  console.log("[smoke] sync_contacts: extractClientRecord (consent fails loudly)");
}

async function testSyncFlow(): Promise<void> {
  await withEnv(MB_ENV, async () => {
    const store = new FakeStore();
    // Seed a pre-existing contact who locally unsubscribed via link.
    await store.upsertContact({
      mbClientId: "42",
      email: "held@example.com",
      firstName: null,
      lastName: null,
      optInRaw: {},
    });
    await store.appendConsentEvent({
      contactId: "1",
      email: "held@example.com",
      state: "unsubscribed",
      source: "unsubscribe_link",
      detail: "clicked",
    });
    // And one whose ledger says subscribed via a previous sync.
    await store.upsertContact({
      mbClientId: "43",
      email: "flip@example.com",
      firstName: null,
      lastName: null,
      optInRaw: {},
    });
    await store.appendConsentEvent({
      contactId: "2",
      email: "flip@example.com",
      state: "subscribed",
      source: "mindbody_sync",
      detail: "seeded",
    });

    const result = await syncContacts(
      depsWith(store, [
        [
          mbClient("41", "new@example.com", true), // fresh: seeds subscribed
          mbClient("42", "held@example.com", true), // MB opt-in vs local unsub: HELD
          mbClient("43", "flip@example.com", false), // MB opt-out: appended
          mbClient("44", null, true), // no email: skipped
        ],
        [
          // Duplicate id carrying an OPT-OUT: flagged, row NOT overwritten,
          // and the opt-out must still land in the ledger.
          mbClient("41", "dupe@example.com", false),
        ],
      ]),
    );

    assert.equal(result.status, "synced");
    assert.equal(result.mode, "full"); // epoch watermark = full pull
    assert.equal(result.synced, 3);
    assert.equal(result.noEmail, 1);
    assert.equal(result.duplicateMbIds, 1);
    assert.equal(result.consentSeeded, 1);
    // Two changes: flip's opt-out, plus the duplicate record's opt-out.
    assert.equal(result.consentChanged, 2);
    assert.equal(result.heldResubscribes, 1);
    // held@example.com's ledger still ends unsubscribed, by link.
    const held = await store.latestConsent("1");
    assert.deepEqual(held, { state: "unsubscribed", source: "unsubscribe_link" });
    // flip@example.com got the opt-out appended (two events total, and
    // the ledger now ends unsubscribed).
    const flipEvents = store.consent.filter((e) => e.contactId === "2");
    assert.equal(flipEvents.length, 2);
    assert.equal(flipEvents[1]!.state, "unsubscribed");
    assert.deepEqual(await store.latestConsent("2"), {
      state: "unsubscribed",
      source: "mindbody_sync",
    });
    // Duplicate flagged with the DUPE prefix (never cleared by
    // reconciliation), and the first record's row data was NOT overwritten.
    const contact41 = [...store.contacts.values()].find(
      (c) => c.mbClientId === "41",
    )!;
    assert.equal(contact41.isAmbiguous, true);
    assert.match(
      contact41.ambiguousReason!,
      /^sync-dupe: duplicate mb_client_id 41/,
    );
    assert.equal(contact41.email, "new@example.com");
    // The duplicate's opt-out landed on the ledger, at the ROW's address.
    const dupeConsent = await store.latestConsent(contact41.id);
    assert.deepEqual(dupeConsent, {
      state: "unsubscribed",
      source: "mindbody_sync",
    });
    const dupeEvent = store.consent.find((e) =>
      e.detail.includes("duplicate Mindbody record"),
    )!;
    assert.equal(dupeEvent.email, "new@example.com");
    // Watermark advanced; nobody left consented (41 was seeded subscribed,
    // then the duplicate's opt-out superseded it), and the summary must
    // show the exclusion even though reconciliation never ran.
    assert.ok(store.advancedTo instanceof Date);
    assert.equal(result.consented, 0);
    assert.equal(result.ambiguousExcluded, 1);
    assert.match(
      result.summary,
      /^3 contacts synced, 0 consented, 1 ambiguous excluded, 0 unmappable$/,
    );
    // The dupe flag survives a reconciliation that resolves the id
    // cleanly: clearSyncAmbiguity only touches the "sync:" prefix.
    await store.clearSyncAmbiguity(contact41.id, SYNC_AMBIGUOUS_PREFIX);
    assert.equal(contact41.isAmbiguous, true);
    assert.ok(!DUPLICATE_AMBIGUOUS_PREFIX.startsWith(SYNC_AMBIGUOUS_PREFIX));
  });
  console.log("[smoke] sync_contacts: full flow (seed/hold/flip/dupe/no-email)");
}

async function testIncrementalWatermark(): Promise<void> {
  await withEnv(MB_ENV, async () => {
    const store = new FakeStore();
    store.lastSyncedAt = new Date("2026-08-10T12:00:00Z");
    const captured: { modifiedSince?: string } = {};
    const result = await syncContacts(depsWith(store, [], captured));
    assert.equal(result.mode, "incremental");
    // 25 hours of overlap: covers clock skew AND a site-local reading of
    // request.lastModifiedDate by Mindbody (see WATERMARK_OVERLAP_MS).
    assert.equal(captured.modifiedSince, "2026-08-09T11:00:00.000Z");
    // --full ignores the watermark.
    const capturedFull: { modifiedSince?: string } = {};
    await syncContacts(depsWith(store, [], capturedFull), { full: true });
    assert.equal(capturedFull.modifiedSince, undefined);
  });
  console.log("[smoke] sync_contacts: incremental watermark (25h overlap, --full override)");
}

async function testReconcile(): Promise<void> {
  const store = new FakeStore();
  // Contacts: 10 clean, 20+21 both claimed by analytics client B (multi),
  // 30 matches a name-ambiguous mirror client, 40 stale-flagged from an
  // earlier run but now clean, no contact matches analytics client Z.
  for (const [mbId, email] of [
    ["10", "ten@example.com"],
    ["20", "twenty@example.com"],
    ["N21", "twentyone@example.com"],
    ["30", "thirty@example.com"],
    ["40", "forty@example.com"],
    ["50", "fifty@example.com"], // matches nothing; carries a stale stamp
  ] as const) {
    await store.upsertContact({
      mbClientId: mbId,
      email,
      firstName: null,
      lastName: null,
      optInRaw: {},
    });
  }
  const contact40 = [...store.contacts.values()].find((c) => c.mbClientId === "40")!;
  contact40.isAmbiguous = true;
  contact40.ambiguousReason = `${SYNC_AMBIGUOUS_PREFIX} stale from last run`;
  // Stale stamps from a previous run, before the mirror re-merged: 50 no
  // longer matches anything, 30's client is now mirror-ambiguous.
  const contact50 = [...store.contacts.values()].find((c) => c.mbClientId === "50")!;
  contact50.analyticsClientId = "9";
  const contact30pre = [...store.contacts.values()].find((c) => c.mbClientId === "30")!;
  contact30pre.analyticsClientId = "3";

  const clientsRows = [
    { client_id: 1, is_ambiguous: 0 }, // A -> contact 10 (clean)
    { client_id: 2, is_ambiguous: 0 }, // B -> contacts 20 + N21 (multi)
    { client_id: 3, is_ambiguous: 1 }, // C -> contact 30 (mirror-ambiguous)
    { client_id: 4, is_ambiguous: 0 }, // D -> contact 40 (clean again)
    { client_id: 5, is_ambiguous: 0 }, // Z -> nobody (unmappable)
  ];
  const sourceRows = [
    { source_id: "10", client_id: 1 },
    { source_id: "20", client_id: 2 },
    { source_id: "n21", client_id: 2 }, // case-insensitive match to "N21"
    { source_id: "30", client_id: 3 },
    { source_id: "40", client_id: 4 },
    { source_id: "999", client_id: 5 },
  ];
  const fakePageSelect = async function* (select: string) {
    if (/FROM clients/.test(select)) yield clientsRows;
    else if (/FROM client_source_ids/.test(select)) yield sourceRows;
    else throw new Error(`unexpected query: ${select}`);
  };

  const report = await reconcileIdMapping({
    pageSelect: fakePageSelect as never,
    store,
  });
  assert.equal(report.analyticsClients, 5);
  assert.equal(report.analyticsAmbiguous, 1);
  assert.equal(report.exactlyOne, 3); // A, C, D
  assert.equal(report.multiple, 1); // B
  assert.equal(report.zero, 1); // Z
  const byMbId = (id: string) =>
    [...store.contacts.values()].find((c) => c.mbClientId === id)!;
  // Clean 1:1 stamped with the analytics id.
  assert.equal(byMbId("10").analyticsClientId, "1");
  assert.equal(byMbId("10").isAmbiguous, false);
  // Multi-match: both contacts flagged, neither stamped.
  assert.equal(byMbId("20").isAmbiguous, true);
  assert.match(byMbId("20").ambiguousReason!, /maps to 2 contacts/);
  assert.equal(byMbId("N21").isAmbiguous, true);
  assert.equal(byMbId("20").analyticsClientId, null);
  // Mirror-ambiguous client: contact flagged, and its stale stamp nulled.
  assert.equal(byMbId("30").isAmbiguous, true);
  assert.match(byMbId("30").ambiguousReason!, /name-match ambiguous/);
  assert.equal(byMbId("30").analyticsClientId, null);
  // Stale sync flag cleared on a now-clean match.
  assert.equal(byMbId("40").isAmbiguous, false);
  assert.equal(byMbId("40").analyticsClientId, "4");
  // Matched by nothing this run: the stale stamp is cleared, unflagged.
  assert.equal(byMbId("50").analyticsClientId, null);
  assert.equal(byMbId("50").isAmbiguous, false);
  // 20, N21, 30 end ambiguous.
  assert.equal(report.ambiguousContacts, 3);
  console.log("[smoke] sync_contacts: reconciliation (1:1/multi/zero/clear, case-insensitive)");
}

/** Mock Mindbody HTTP server: /usertoken/issue + paged /client/clients. */
function mockMindbody(clients: Array<Record<string, unknown>>): Promise<{
  server: Server;
  url: string;
  requests: Array<{ path: string; apiKey?: string; siteId?: string; auth?: string }>;
}> {
  const requests: Array<{
    path: string;
    apiKey?: string;
    siteId?: string;
    auth?: string;
  }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push({
      path: url.pathname + url.search,
      apiKey: req.headers["api-key"] as string | undefined,
      siteId: req.headers["siteid"] as string | undefined,
      auth: req.headers["authorization"] as string | undefined,
    });
    if (url.pathname.endsWith("/usertoken/issue")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ AccessToken: "staff-token-abc" }));
      return;
    }
    const limit = Number(url.searchParams.get("request.limit") ?? "200");
    const offset = Number(url.searchParams.get("request.offset") ?? "0");
    const page = clients.slice(offset, offset + limit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        Clients: page,
        PaginationResponse: {
          RequestedLimit: limit,
          RequestedOffset: offset,
          PageSize: page.length,
          TotalResults: clients.length,
        },
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

async function testFetchAllClients(): Promise<void> {
  const all = Array.from({ length: 5 }, (_, i) =>
    mbClient(String(100 + i), `c${i}@example.com`, i % 2 === 0),
  );
  const { server, url, requests } = await mockMindbody(all);
  try {
    await withEnv(
      {
        ...MB_ENV,
        MINDBODY_STAFF_USERNAME: "Siteowner",
        MINDBODY_STAFF_PASSWORD: "pw",
        MINDBODY_API_BASE_URL: url,
      },
      async () => {
        const collected = [];
        for await (const page of fetchAllClients({
          pageSize: 2,
          modifiedSince: "2026-08-01T00:00:00.000Z",
        })) {
          collected.push(...page);
        }
        assert.equal(collected.length, 5);
        // First request is the staff token, then 3 pages of 2/2/1.
        assert.match(requests[0]!.path, /usertoken\/issue/);
        const pageReqs = requests.slice(1);
        assert.equal(pageReqs.length, 3);
        for (const r of requests) {
          assert.equal(r.apiKey, "key");
          assert.equal(r.siteId, "12345");
        }
        for (const r of pageReqs) {
          assert.equal(r.auth, "staff-token-abc");
          assert.match(r.path, /request\.lastModifiedDate=2026-08-01/);
        }
        assert.match(pageReqs[0]!.path, /request\.offset=0/);
        assert.match(pageReqs[1]!.path, /request\.offset=2/);
        assert.match(pageReqs[2]!.path, /request\.offset=4/);
      },
    );
  } finally {
    server.close();
  }
  console.log("[smoke] sync_contacts: Mindbody paging (token, headers, lastModifiedDate)");
}

async function main(): Promise<void> {
  await testConfigGate();
  testExtractClientRecord();
  await testSyncFlow();
  await testIncrementalWatermark();
  await testReconcile();
  await testFetchAllClients();
  console.log("[smoke] sync_contacts: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
