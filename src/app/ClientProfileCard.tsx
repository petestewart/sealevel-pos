"use client";

import type { ClientProfile } from "@/lib/clientprofile";
import NoteText from "./NoteText";

/**
 * T41: the client profile as a card (Pete: "a modal with the same basic
 * info as the mindbody client-info page"). Presentational only: the
 * modal that opens it, the fetch of /api/client-profile and the profile
 * icon in the Buy header belong to page.tsx. Props are the profile, the
 * in-flight flag and a whole-read failure; a section whose own sub-read
 * failed says so in place, so a slow visits call never hides the phone.
 *
 * Styled like the Buy header's client card (.sale-for): a bordered
 * surface, muted uppercase labels over 17px values, every colour a
 * token, nothing under 16px. Dates are Mindbody's site-local strings
 * rendered digit for digit (no Date parsing: the offset would shift the
 * wall clock, T40), so "2026-09-02T09:00:00" reads as Sep 2, 2026 at
 * 9:00am regardless of the iPad's zone.
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-09-02T09:00:00" (or a bare date) as "Sep 2, 2026". */
export function wallDate(s: string | null): string | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return s;
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** "2026-09-02T18:30:00" as "Sep 2, 2026 at 6:30pm". */
export function wallDateTime(s: string | null): string | null {
  const date = wallDate(s);
  if (!s || !date) return null;
  const m = /T(\d{2}):(\d{2})/.exec(s);
  if (!m) return date;
  const h = Number(m[1]);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${date} at ${hour12}:${m[2]}${h < 12 ? "am" : "pm"}`;
}

/** T71: the three opt-in kinds, one line each in the Opt-ins table, in
 *  the gate's wording (T53) so what the gate asked for is what this
 *  table shows. */
const OPT_IN_KINDS = [
  { key: "account", label: "Receipts and account" },
  { key: "schedule", label: "Schedule" },
  { key: "promotional", label: "News and offers" },
] as const;

export type OptInKind = (typeof OPT_IN_KINDS)[number]["key"];

/** The email flag the card writes for one kind, in the shape
 *  /api/client-consent takes. Texts have no entry on purpose: the API
 *  ignores the text flags in a request (client.yml, "cannot be updated
 *  by developers"), so the card never offers to set one. */
export const OPT_IN_EMAIL_FLAG: Record<
  OptInKind,
  "sendAccountEmails" | "sendScheduleEmails" | "sendPromotionalEmails"
> = {
  account: "sendAccountEmails",
  schedule: "sendScheduleEmails",
  promotional: "sendPromotionalEmails",
};

function consentOf(
  c: NonNullable<ClientProfile["consent"]>,
  kind: OptInKind,
  channel: "email" | "text",
): boolean {
  if (channel === "email") {
    return kind === "account"
      ? c.accountEmails
      : kind === "schedule"
        ? c.scheduleEmails
        : c.promotionalEmails;
  }
  return kind === "account"
    ? c.accountTexts
    : kind === "schedule"
      ? c.scheduleTexts
      : c.promotionalTexts;
}

/**
 * T71 (Pete: "the Emails/Text field should be checkboxes that i can
 * change right there ... one main field called Opt-ins. Then check
 * marks for the phone and email options"): one table, a line per kind,
 * an Email box and a Text box on each. The email boxes flip on tap and
 * the taps are written in the background (T72: one /api/client-consent
 * call after a short idle or on close, page.tsx flushOptIn; a write
 * that did not land puts the box back and says why); the text boxes
 * only show what Mindbody holds, since the API refuses those flags,
 * and say so under the table. Each box is
 * a 44px label cell (the icon-square idiom) so a hot-room thumb has
 * something to hit; the box itself is the gate's 26px.
 */
function OptIns({
  consent,
  onChange,
}: {
  consent: NonNullable<ClientProfile["consent"]>;
  onChange?: (kind: OptInKind, value: boolean) => void;
}) {
  return (
    <div className="optins">
      <div className="optins-head" aria-hidden="true">
        <span />
        <span>Email</span>
        <span>Text</span>
      </div>
      {OPT_IN_KINDS.map((k) => {
        const email = consentOf(consent, k.key, "email");
        const text = consentOf(consent, k.key, "text");
        return (
          <div className="optins-row" key={k.key}>
            <span className="optins-kind">{k.label}</span>
            <label className="optins-box" aria-label={`${k.label} by email`}>
              <input
                type="checkbox"
                checked={email}
                disabled={!onChange}
                onChange={(e) => onChange?.(k.key, e.target.checked)}
              />
            </label>
            <label
              className="optins-box off"
              aria-label={`${k.label} by text (set in Mindbody)`}
              title="Text opt-ins can only be changed in Mindbody"
            >
              <input type="checkbox" checked={text} disabled readOnly />
            </label>
          </div>
        );
      })}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="profile-row">
      <span className="profile-k">{label}</span>
      <span className="profile-v">{children}</span>
    </div>
  );
}

function Missing({ why }: { why: string | undefined }) {
  return (
    <span className="profile-missing">
      {why ? `Could not read: ${why}` : "Not on file"}
    </span>
  );
}

export function ClientProfileCard({
  profile,
  loading,
  error,
  onOptIn,
  optInMsg = null,
}: {
  profile: ClientProfile | null;
  loading: boolean;
  error: string | null;
  /** T71: an email opt-in tapped; absent, the boxes are read-only. */
  onOptIn?: (kind: OptInKind, value: boolean) => void;
  /** The last write's outcome when it was not a plain success: a
   *  suppression, a fallback to the studio account, or a refusal. */
  optInMsg?: { text: string; tone: "warn" | "stop" } | null;
}) {
  if (loading && !profile) {
    return (
      <div className="profile-card" aria-busy="true">
        <p className="muted">
          <span className="spinner" aria-label="working" /> Reading the
          profile from Mindbody...
        </p>
      </div>
    );
  }
  if (error && !profile) {
    return (
      <div className="profile-card">
        <div className="sale-stop">Profile unavailable: {error}</div>
      </div>
    );
  }
  if (!profile) return null;

  const { visits, passes, errors } = profile;
  const statusLine = [
    profile.status,
    profile.member ? "member" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="profile-card">
      {/* T70 review: the modal's head (kicker "Client" + the name) sits
          right above this card, so the card no longer restates them; the
          Mindbody id, which the head does not carry, stays as the first
          line. */}
      {profile.mindbodyId !== null ? (
        <div className="profile-head">
          <span className="profile-id">id {profile.mindbodyId}</span>
        </div>
      ) : null}

      {/* T52 (Pete: "the profile view should also have any notes/alerts
          in its display if there are any"): one block under the name,
          the red alert in the stop pair, the yellow in the warn pair,
          the notes plain, each only when Mindbody has text for it and
          the block itself only when any does. The fields ride the same
          /client/clients read the roster uses (RedAlert, YellowAlert,
          Notes); nothing extra is fetched. */}
      {profile.redAlert || profile.yellowAlert || profile.notes ? (
        <div className="profile-notes">
          <p className="profile-label">Alerts and notes</p>
          {/* T58: entry by entry, the signature under each signed one,
              the same idiom as the info view. */}
          <NoteText text={profile.redAlert} className="ctx-alert profile-alert" />
          <NoteText text={profile.yellowAlert} className="modal-warn" />
          <NoteText text={profile.notes} className="modal-note" />
        </div>
      ) : null}

      <div className="profile-grid">
        <Row label="Phone">
          {profile.phone ?? <Missing why={errors.client} />}
        </Row>
        <Row label="Email">
          {profile.email ?? <Missing why={errors.client} />}
        </Row>
        {/* T71: the opt-ins as one row of live checkboxes (see OptIns);
            T53 had them as two read-only lines. The line under the
            table names a write that did not plainly land. */}
        <Row label="Opt-ins">
          {profile.consent ? (
            <>
              <OptIns consent={profile.consent} onChange={onOptIn} />
              {optInMsg ? (
                <p
                  className={
                    optInMsg.tone === "stop"
                      ? "optins-msg stop-text"
                      : "optins-msg warn-text"
                  }
                  role="status"
                >
                  {optInMsg.text}
                </p>
              ) : (
                <p className="optins-msg">
                  Email opt-ins save by themselves. Texts are set in Mindbody.
                </p>
              )}
            </>
          ) : (
            <Missing why={errors.client} />
          )}
        </Row>
        <Row label="Visits">
          {visits ? (
            <>
              {visits.count}
              {profile.joined ? (
                <span className="profile-sub">
                  {" "}
                  since {wallDate(profile.joined)}
                </span>
              ) : null}
            </>
          ) : (
            <Missing why={errors.visits} />
          )}
        </Row>
        <Row label="Last visit">
          {visits ? (
            visits.last ? (
              <>
                {visits.last.name ?? "Class"}
                <span className="profile-sub">
                  {" "}
                  {wallDateTime(visits.last.at)}
                </span>
              </>
            ) : (
              <span className="profile-missing">None on record</span>
            )
          ) : (
            <Missing why={errors.visits} />
          )}
        </Row>
        <Row label="Waiver">
          {profile.waiver ? (
            profile.waiver.released ? (
              <>
                Signed
                {profile.waiver.agreedAt ? (
                  <span className="profile-sub">
                    {" "}
                    {wallDate(profile.waiver.agreedAt)}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="profile-unsigned">Not signed</span>
            )
          ) : (
            <Missing why={errors.client} />
          )}
        </Row>
        <Row label="Status">
          {statusLine || <Missing why={errors.client} />}
        </Row>
      </div>

      <p className="profile-label profile-section">Passes</p>
      {passes === null ? (
        <p className="profile-missing">
          <Missing why={errors.passes} />
        </p>
      ) : passes.length === 0 ? (
        <p className="profile-missing">No current passes</p>
      ) : (
        <ul className="profile-passes">
          {passes.map((p, i) => (
            <li key={p.id ?? `${p.name}-${i}`} className="profile-pass">
              <span className="profile-pass-name">{p.name}</span>
              <span className="profile-pass-meta">
                {/* The fake-unlimited rule, as page.tsx applies it
                    everywhere else a pass renders: Mindbody hands a
                    membership over as 99999 sessions, and this card
                    printed "99993 of 99999 left" (T52 review). Repeated
                    rather than imported, since a page file exports only
                    its page. */}
                {p.remaining === null ||
                (p.count !== null && p.count >= 100) ||
                p.remaining >= 100
                  ? "Unlimited"
                  : p.count !== null
                    ? `${p.remaining} of ${p.count} left`
                    : `${p.remaining} left`}
                {p.expires ? ` · expires ${wallDate(p.expires)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
