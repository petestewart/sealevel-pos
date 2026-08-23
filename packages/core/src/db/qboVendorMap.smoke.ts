/**
 * Smoke: vendor-link input validation (SEA-119). The SQL paths (upsert,
 * UNIQUE refusal, delete) are exercised against a real database; this
 * suite pins the pure guard that keeps garbage out of the payee column.
 * Run: npm run smoke:qbovendormap (from packages/core)
 */
import assert from "node:assert/strict";

import { parseVendorId, VendorLinkError } from "./qboVendorMap.js";

function testAccepts(): void {
  // QBO vendor ids are opaque digit strings; whitespace from a paste is
  // forgiven, the id itself is stored verbatim.
  assert.equal(parseVendorId("58"), "58");
  assert.equal(parseVendorId("  100000045  "), "100000045");
  console.log("[smoke] qboVendorMap: digit ids accepted, trimmed");
}

function testRejects(): void {
  // The wrong paste entirely — a name, a URL, an empty field — must be
  // refused as a VendorLinkError (the form renders it inline), never
  // stored as a payee.
  for (const bad of [
    "",
    "   ",
    "Sally Zapata",
    "https://app.qbo.intuit.com/app/vendordetail?nameId=58",
    "58a",
    "-58",
    "5 8",
  ]) {
    assert.throws(
      () => parseVendorId(bad),
      VendorLinkError,
      `must reject ${JSON.stringify(bad)}`,
    );
  }
  console.log("[smoke] qboVendorMap: non-id pastes rejected loudly");
}

testAccepts();
testRejects();
console.log("[smoke] qboVendorMap: all passed");
