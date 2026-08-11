import { loadEnv } from "../env.js";
import {
  MINDBODY_OPT_IN_FIELD,
  mindbodyConfigured,
  verifyClientFields,
} from "./mindbody.js";

/**
 * The SEA-81 pre-flight: "confirm the exact promotional-email opt-in
 * field name against a live v6 client response". Fetches ONE client and
 * prints every field name plus the consent-related values, so the
 * mapping in campaigns/mindbody.ts can be checked against reality before
 * the first sync run is trusted.
 *
 *   npm run mindbody:verify   (needs MINDBODY_API_KEY / MINDBODY_SITE_ID,
 *                              ideally the staff credentials too)
 *
 * No PII is printed: field NAMES and the six consent booleans only.
 */
loadEnv();

if (!mindbodyConfigured()) {
  console.error(
    "Mindbody API is not configured: set MINDBODY_API_KEY and MINDBODY_SITE_ID (and ideally MINDBODY_STAFF_USERNAME / MINDBODY_STAFF_PASSWORD) in .env",
  );
  process.exit(1);
}

const report = await verifyClientFields();
console.log("Live v6 Client fields:", report.fieldNames.join(", "));
console.log("Consent-related values:", JSON.stringify(report.consentFields, null, 2));
console.log(
  `TotalResults for this site: ${report.totalResults ?? "(not reported)"}`,
);
if (report.optInFieldPresent) {
  console.log(
    `OK: ${MINDBODY_OPT_IN_FIELD} is present and boolean on the live response. The sync's consent mapping is safe to trust.`,
  );
} else {
  console.error(
    `PROBLEM: ${MINDBODY_OPT_IN_FIELD} is missing or non-boolean on the live response. Do NOT run the sync; fix the mapping in packages/core/src/campaigns/mindbody.ts first.`,
  );
  process.exit(1);
}
