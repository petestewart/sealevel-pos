/**
 * T2's owed rehearsal: fire the app's booking write with Test: true, so
 * Mindbody validates the whole payload -- credentials, permissions,
 * client, class, business rules -- and commits NOTHING. Per the vendored
 * spec (docs/mindbody-openapi/class.yml, AddClientToClassRequest.Test):
 * "input information is validated, but not committed."
 *
 * Usage, against prod (the sandbox works too when its issuer is up):
 *
 *   MINDBODY_TARGET=prod POS_DRY_RUN=false POS_WRITE_CLIENT_IDS=<clientId> \
 *     npx tsx --env-file=.env scripts/rehearse-booking.ts <clientId> <classId>
 *
 * The safety rails stay armed on purpose: POS_DRY_RUN must be false or
 * dry run suppresses the call before Mindbody sees it, and the client id
 * goes in POS_WRITE_CLIENT_IDS so the write guard lets exactly this one
 * through. Test mode is the third rail on top, not a replacement.
 *
 * A 200 with a Visit back means the whole write path works; an error is
 * Mindbody's real refusal reason, which is exactly what a rehearsal is
 * for. Either way, nothing changed on anyone's account.
 */
import { mindbody } from "../src/lib/mindbody";

async function main(): Promise<void> {
  const [clientId, classIdRaw] = process.argv.slice(2);
  const classId = Number(classIdRaw);
  if (!clientId || !Number.isInteger(classId)) {
    console.error(
      "Usage: npx tsx --env-file=.env scripts/rehearse-booking.ts <clientId> <classId>",
    );
    process.exit(1);
  }
  const res = await mindbody("/class/addclienttoclass", {
    method: "POST",
    body: {
      ClientId: clientId,
      ClassId: classId,
      SendEmail: false,
      Test: true,
    },
    clientId,
  });
  if (res?.DryRun) {
    console.log(
      "Suppressed by dry run before reaching Mindbody. Run with POS_DRY_RUN=false; Test: true is what keeps this safe.",
    );
    return;
  }
  if (res?.WriteSuppressed) {
    console.log(
      "Suppressed by the write guard: add this client id to POS_WRITE_CLIENT_IDS.",
    );
    return;
  }
  console.log("Mindbody accepted the test booking. Nothing was committed.");
  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error(
    "Mindbody refused the test booking:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
