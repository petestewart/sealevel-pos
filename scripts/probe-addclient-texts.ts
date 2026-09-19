/**
 * Probe D-B3 (docs/PLAN.md, Phase 2.5): does `POST /client/addclient`
 * HONOUR the three text opt-in flags, which `updateclient` documents as
 * ignored?
 *
 * The question, exactly. `UpdateClientRequest`'s field docs say
 * `SendAccountTexts`, `SendPromotionalTexts` and `SendScheduleTexts`
 * "cannot be updated by developers" and are ignored
 * (docs/mindbody-openapi/client.yml:5290-5309), which is why T53's
 * consent write never sends them. `AddClientRequest` lists the same
 * three (client.yml:4709, flags at 4945-4956) with no such caveat. The
 * self-serve sign-up (T204) asks the student "Text me" with the box
 * ticked by default (D4), so the flags ride the CREATE, which is the one
 * call that may keep them. This probe is how we find out whether it
 * does; until it runs, /api/client-create reads the client back after
 * every sign-up create and files a T62-signed Notes line when the flags
 * did not stick, so the opt-in is never silently dropped.
 *
 * It WRITES: it creates a throwaway client. So it runs against the
 * SANDBOX, and POS_DRY_RUN must be false for it to reach Mindbody at all
 * (a dry run prints the suppression, which is itself a check of the
 * guard). The write guard will suppress a create outright, since a
 * client being created has no id to list; run it with
 * POS_WRITE_CLIENT_IDS empty.
 *
 * Usage, against the sandbox:
 *
 *   MINDBODY_TARGET=sandbox POS_DRY_RUN=false \
 *     npx tsx --env-file=.env scripts/probe-addclient-texts.ts
 *
 * It prints BOTH raw answers: what addclient returned, and what
 * /client/clients says about the same client a moment later. Record the
 * three text flags from each; if they disagree, the create's answer is
 * optimistic and the read-back is the truth, which is itself worth
 * knowing.
 */
import { mindbody } from "../src/lib/mindbody";

const TEXT_FLAGS = [
  "SendAccountTexts",
  "SendPromotionalTexts",
  "SendScheduleTexts",
] as const;
const EMAIL_FLAGS = [
  "SendAccountEmails",
  "SendPromotionalEmails",
  "SendScheduleEmails",
] as const;

function flagsOf(row: Record<string, unknown> | null | undefined): string {
  if (!row) return "(no client in the answer)";
  return [...EMAIL_FLAGS, ...TEXT_FLAGS]
    .map((f) => `${f}=${f in row ? String(row[f]) : "(absent)"}`)
    .join("\n      ");
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const body = {
    FirstName: "Probe",
    LastName: `TextOptIn${stamp}`,
    Email: `probe.textoptin.${stamp}@example.com`,
    MobilePhone: "2065550147",
    SendAccountEmails: true,
    SendPromotionalEmails: true,
    SendScheduleEmails: true,
    SendAccountTexts: true,
    SendPromotionalTexts: true,
    SendScheduleTexts: true,
  };

  console.log("=== POST /client/addclient");
  console.log(`    ${body.FirstName} ${body.LastName} <${body.Email}>`);
  console.log("    all six Send* flags sent as true\n");

  let created: Record<string, unknown> | null = null;
  try {
    const res = await mindbody("/client/addclient", {
      method: "POST",
      body,
      /* A create has no client id to name, so the write guard suppresses
       * it as "(none named)"; that is the right answer and this prints
       * it rather than pretending. */
      clientId: undefined,
    });
    console.log("    RAW ANSWER:");
    console.log(JSON.stringify(res, null, 2));
    if (res?.DryRun) {
      console.log(
        "\n    Suppressed by dry run. Re-run with POS_DRY_RUN=false to actually ask.",
      );
      return;
    }
    if (res?.WriteSuppressed) {
      console.log(
        "\n    Suppressed by the write guard. Run with POS_WRITE_CLIENT_IDS empty: a client being created has no id to list.",
      );
      return;
    }
    created = (res?.Client ?? null) as Record<string, unknown> | null;
    console.log(`\n    Flags as the CREATE answered:\n      ${flagsOf(created)}`);
  } catch (err) {
    console.log(
      `    FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(
      "    A complaint naming one of the text flags here is the answer the probe is for: record the exact wording.",
    );
    return;
  }

  const id = created?.Id === undefined ? "" : String(created.Id);
  if (id === "") {
    console.log("\n    No client id came back, so there is nothing to read.");
    return;
  }

  console.log(`\n=== GET /client/clients?clientIds=${id}`);
  try {
    const read = await mindbody(
      `/client/clients?clientIds=${encodeURIComponent(id)}&limit=1`,
    );
    console.log("    RAW ANSWER:");
    console.log(JSON.stringify(read, null, 2));
    const row = (read?.Clients ?? []).find(
      (c: { Id?: unknown }) => String(c?.Id ?? "") === id,
    ) as Record<string, unknown> | undefined;
    console.log(`\n    Flags as the READ answered:\n      ${flagsOf(row ?? null)}`);
    const stuck = TEXT_FLAGS.every((f) => row?.[f] === true);
    const absent = TEXT_FLAGS.every((f) => row === undefined || !(f in row));
    console.log(
      `\n    D-B3: ${
        absent
          ? "NO EVIDENCE -- the read carries none of the text flags at all."
          : stuck
            ? "addclient KEPT the text opt-in."
            : "addclient DROPPED the text opt-in; the Notes fallback in /api/client-create is the record."
      }`,
    );
  } catch (err) {
    console.log(
      `    FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(
    `\n    Delete the probe client (${id}) in Mindbody when you are done with it.`,
  );
}

void main();
