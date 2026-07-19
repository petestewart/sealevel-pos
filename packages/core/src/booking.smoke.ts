import assert from "node:assert/strict";

import {
  bookingConfigured,
  bookingLinkGuidance,
  bookingUrl,
} from "./booking.js";

/**
 * Booking link rule smoke test. Pure/offline: it manipulates the
 * SEALEVEL_BOOKING_URL environment variable and asserts the config gate
 * and the interpolated guidance text. No DB, Redis, or API key required.
 *
 * Run: npm run smoke:booking  (from packages/core)
 */

const PROD_URL = "https://sealevel-website.vercel.app/schedule";

function withEnv(value: string | undefined, fn: () => void): void {
  const prior = process.env["SEALEVEL_BOOKING_URL"];
  if (value === undefined) delete process.env["SEALEVEL_BOOKING_URL"];
  else process.env["SEALEVEL_BOOKING_URL"] = value;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env["SEALEVEL_BOOKING_URL"];
    else process.env["SEALEVEL_BOOKING_URL"] = prior;
  }
}

function main(): void {
  // --- Unset: the booking rule is absent, drafting is unchanged --------
  withEnv(undefined, () => {
    assert.equal(bookingConfigured(), false, "unset => not configured");
    assert.equal(bookingUrl(), undefined, "unset => no url");
  });
  // A blank/whitespace value is treated as unset, never a blank link.
  withEnv("   ", () => {
    assert.equal(bookingConfigured(), false, "blank => not configured");
    assert.equal(bookingUrl(), undefined, "blank => no url");
  });
  console.log("ok: booking rule is absent when SEALEVEL_BOOKING_URL is unset");

  // --- Configured: the exact URL is interpolated verbatim --------------
  withEnv(PROD_URL, () => {
    assert.equal(bookingConfigured(), true, "set => configured");
    assert.equal(bookingUrl(), PROD_URL, "set => trimmed url");
    const guidance = bookingLinkGuidance(bookingUrl()!);
    assert.ok(
      guidance.includes(PROD_URL),
      "guidance interpolates the exact URL, not a placeholder",
    );
    assert.ok(
      !guidance.includes("<URL>") && !guidance.includes("${"),
      "guidance has no unresolved placeholder",
    );
    assert.match(
      guidance,
      /invitation for the customer to book their own spot/i,
      "guidance invites the customer to book their OWN spot",
    );
    assert.match(
      guidance,
      /Never invent, shorten, or modify the link/i,
      "guidance forbids altering the link",
    );
    assert.match(
      guidance,
      /not about attending a class/i,
      "guidance scopes the rule to class-attendance replies",
    );
    // Fix B: booking is self-service. The guidance must frame it that way,
    // forbid booking on the customer's behalf, and redirect a "book me"
    // request to the self-serve link.
    assert.match(
      guidance,
      /self-service/i,
      "guidance states booking is self-service",
    );
    assert.match(
      guidance,
      /Never say or imply that the studio will book/i,
      "guidance forbids claiming the studio books for the customer",
    );
    assert.match(
      guidance,
      /never offer to get them booked in/i,
      "guidance forbids offering to get the customer booked in",
    );
    assert.match(
      guidance,
      /asks us to book a class for them/i,
      "guidance redirects a 'book me' request to self-serve",
    );
    // The invitation text becomes outgoing customer copy: no em dashes.
    assert.ok(!guidance.includes("—"), "guidance is em-dash-free");
    // The fallback posture bans follow-up promises everywhere; this
    // guidance must not seed one either.
    assert.ok(
      !/follow up|get back to/i.test(guidance),
      "guidance suggests no follow-up promises",
    );
  });
  console.log(
    "ok: booking guidance interpolates the exact URL and is em-dash-free",
  );

  console.log("booking smoke passed");
}

main();
