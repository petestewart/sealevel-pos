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

/** T53: "receipts and account, news and offers" for the ticked flags of
 *  one channel, "none" when nothing is ticked. The wording matches the
 *  opt-in gate's checkboxes, so what the gate asked for is what this
 *  line reports. */
function consentLine(
  c: NonNullable<ClientProfile["consent"]>,
  channel: "email" | "text",
): React.ReactNode {
  const on = [
    (channel === "email" ? c.accountEmails : c.accountTexts)
      ? "receipts and account"
      : null,
    (channel === "email" ? c.scheduleEmails : c.scheduleTexts)
      ? "schedule"
      : null,
    (channel === "email" ? c.promotionalEmails : c.promotionalTexts)
      ? "news and offers"
      : null,
  ].filter(Boolean);
  if (on.length === 0) {
    return <span className="profile-missing">None</span>;
  }
  return on.join(", ");
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
}: {
  profile: ClientProfile | null;
  loading: boolean;
  error: string | null;
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
        {/* T53: the consent flags as read-only text under the contact
            line, one row for email and one for texts, so a teacher can
            see at a glance whether the receipt gate will ask (it asks
            when "receipts and account" is off). The texts row is shown
            for the same reason it cannot be edited: the API refuses
            those flags, so what Mindbody holds is all there is. */}
        <Row label="Emails">
          {profile.consent ? (
            consentLine(profile.consent, "email")
          ) : (
            <Missing why={errors.client} />
          )}
        </Row>
        <Row label="Texts">
          {profile.consent ? (
            consentLine(profile.consent, "text")
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
