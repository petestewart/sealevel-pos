"use client";

import type { ClientProfile } from "@/lib/clientprofile";

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
      <div className="profile-head">
        <span className="profile-label">Client</span>
        <span className="profile-name">{profile.name ?? "Unnamed client"}</span>
        {profile.mindbodyId !== null ? (
          <span className="profile-id">id {profile.mindbodyId}</span>
        ) : null}
      </div>

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
          {profile.redAlert ? (
            <p className="ctx-alert profile-alert">{profile.redAlert}</p>
          ) : null}
          {profile.yellowAlert ? (
            <p className="modal-warn">{profile.yellowAlert}</p>
          ) : null}
          {profile.notes ? (
            <p className="modal-note">{profile.notes}</p>
          ) : null}
        </div>
      ) : null}

      <div className="profile-grid">
        <Row label="Phone">
          {profile.phone ?? <Missing why={errors.client} />}
        </Row>
        <Row label="Email">
          {profile.email ?? <Missing why={errors.client} />}
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
                {p.remaining === null
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
