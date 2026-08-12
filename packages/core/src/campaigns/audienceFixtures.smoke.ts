import assert from "node:assert/strict";

import { buildAudience } from "./buildAudience.js";
import {
  AUDIENCE_PERSONAS,
  FixtureAudienceStore,
  fixtureDeps,
  type AudiencePersona,
} from "./audienceFixtures.js";

/**
 * Audience fixture suite (SEA-86): runs every persona in
 * audienceFixtures.ts through the REAL buildAudience filter chain and
 * asserts each one's exact fate. Fully offline (mocked analytics client,
 * in-memory store). CI runs this on every PR; a filter-chain change that
 * alters any persona's fate fails here, naming the persona.
 *
 * Adding a persona is ONE edit in audienceFixtures.ts; this runner
 * derives everything else. See that file's header.
 *
 * Run: npm run smoke:audiencefixtures  (from packages/core)
 */

const ANALYTICS_ENV = {
  SEALEVEL_MCP_URL: "http://localhost:0",
  SEALEVEL_MCP_ANALYTICS_TOKEN: "test-token",
} as const;

function assertPersonaIntegrity(personas: readonly AudiencePersona[]): void {
  // Fresh ids per persona so a fate can never be mis-attributed.
  const clientIds = new Set<string>();
  const contactIds = new Set<string>();
  const names = new Set<string>();
  for (const p of personas) {
    assert.ok(!names.has(p.name), `duplicate persona name '${p.name}'`);
    names.add(p.name);
    assert.ok(
      !clientIds.has(p.analyticsClientId),
      `persona '${p.name}' reuses analyticsClientId ${p.analyticsClientId}`,
    );
    clientIds.add(p.analyticsClientId);
    for (const c of p.contacts) {
      assert.ok(
        !contactIds.has(c.contactId),
        `persona '${p.name}' reuses contactId ${c.contactId}`,
      );
      contactIds.add(c.contactId);
      assert.equal(
        c.analyticsClientId,
        p.analyticsClientId,
        `persona '${p.name}': contact ${c.contactId} carries a different analyticsClientId than the persona`,
      );
    }
    // A not_in_view persona must not claim a view-dependent fate, and an
    // excluded/recipient fate needs the view to actually return the row.
    if (p.expected.fate === "not_in_view") {
      assert.equal(
        p.inView,
        false,
        `persona '${p.name}' expects not_in_view but is marked inView`,
      );
    } else {
      assert.equal(
        p.inView,
        true,
        `persona '${p.name}' expects a filter-chain fate but is not in the view`,
      );
    }
  }
}

async function runSuite(): Promise<void> {
  assertPersonaIntegrity(AUDIENCE_PERSONAS);

  const store = new FixtureAudienceStore(AUDIENCE_PERSONAS);
  const result = await buildAudience({}, fixtureDeps(store, AUDIENCE_PERSONAS));
  assert.equal(result.status, "dry_run");

  const recipientsByClientId = new Map(
    result.recipients.map((r) => [r.analyticsClientId, r]),
  );
  const exclusionsByClientId = new Map(
    result.exclusions.map((e) => [e.analyticsClientId, e]),
  );

  for (const persona of AUDIENCE_PERSONAS) {
    const label = `persona '${persona.name}' (${persona.description})`;
    const asRecipient = recipientsByClientId.get(persona.analyticsClientId);
    const asExclusion = exclusionsByClientId.get(persona.analyticsClientId);

    switch (persona.expected.fate) {
      case "recipient": {
        assert.ok(asRecipient, `${label}: expected in the recipient list`);
        assert.equal(
          asRecipient.email,
          persona.expected.email,
          `${label}: wrong recipient email`,
        );
        assert.equal(
          asExclusion,
          undefined,
          `${label}: recipient must not also appear in exclusions`,
        );
        break;
      }
      case "excluded": {
        assert.ok(asExclusion, `${label}: expected in the exclusion report`);
        assert.equal(
          asExclusion.reason,
          persona.expected.reason,
          `${label}: dropped for '${asExclusion.reason}', expected '${persona.expected.reason}' (first-matching-reason-wins)`,
        );
        if (persona.expected.detailPattern) {
          assert.match(
            asExclusion.detail,
            persona.expected.detailPattern,
            `${label}: exclusion detail does not explain itself`,
          );
        }
        assert.equal(
          asRecipient,
          undefined,
          `${label}: excluded persona must not be a recipient`,
        );
        break;
      }
      case "not_in_view": {
        assert.equal(
          asRecipient,
          undefined,
          `${label}: not-in-view persona must not be a recipient`,
        );
        assert.equal(
          asExclusion,
          undefined,
          `${label}: not-in-view persona must not appear in exclusions (the view never returned it)`,
        );
        break;
      }
    }
    console.log(
      `[fixtures]   ${persona.name}: ${
        persona.expected.fate === "excluded"
          ? `excluded (${persona.expected.reason})`
          : persona.expected.fate
      } -- as expected`,
    );
  }

  // No stowaways: every recipient and every exclusion traces back to a
  // declared persona, and the reconciliation identity holds.
  const knownClientIds = new Set(
    AUDIENCE_PERSONAS.map((p) => p.analyticsClientId),
  );
  for (const r of result.recipients) {
    assert.ok(
      knownClientIds.has(r.analyticsClientId),
      `recipient ${r.email} (client ${r.analyticsClientId}) belongs to no persona`,
    );
  }
  for (const e of result.exclusions) {
    assert.ok(
      knownClientIds.has(e.analyticsClientId),
      `exclusion for client ${e.analyticsClientId} belongs to no persona`,
    );
  }
  const inView = AUDIENCE_PERSONAS.filter((p) => p.inView).length;
  const dropped = Object.values(result.exclusionCounts).reduce(
    (a, b) => a + b,
    0,
  );
  assert.equal(result.viewRows, inView);
  assert.equal(result.viewRows, result.recipients.length + dropped);
  // Fixture runs are dry runs: nothing may be written.
  assert.equal(store.snapshots.length, 0);
}

async function main(): Promise<void> {
  const saved = Object.entries(ANALYTICS_ENV).map(
    ([k]) => [k, process.env[k]] as const,
  );
  for (const [k, v] of Object.entries(ANALYTICS_ENV)) process.env[k] = v;
  try {
    await runSuite();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  console.log(
    `[smoke] audience fixtures: all ${AUDIENCE_PERSONAS.length} personas met their expected fate`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
