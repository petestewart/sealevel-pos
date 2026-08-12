import {
  campaignList,
  CAMPAIGN_STATUS_CHIP,
  type CampaignSummary,
} from "../../lib/campaigns";
import { currentRole, hasPermission } from "../../lib/rbac";

/**
 * Campaigns detail view (SEA-90): the read-only list behind the campaigns
 * overview card, beginning the Campaigns section alongside the Inbox
 * (automation-suite doc, Option 3). Each campaign shows its status, the
 * frozen audience-snapshot size, and delivery results aggregated from
 * provider events. Deliberately no actions here: approve/reject is
 * SEA-83, and segments are views reviewed in git, not built in a UI.
 */

export const dynamic = "force-dynamic";

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "America/Los_Angeles",
});

const RESULT_CELLS = [
  ["delivered", "Delivered"],
  ["opened", "Opened"],
  ["clicked", "Clicked"],
  ["bounced", "Bounced"],
  ["complained", "Complained"],
] as const;

/** Results only mean something once a send has started; before that the
 * row says so instead of showing a wall of zeros. */
function hasResults(campaign: CampaignSummary): boolean {
  if (campaign.status === "sending" || campaign.status === "sent") return true;
  return RESULT_CELLS.some(([key]) => campaign.events[key] > 0);
}

function CampaignRow({ campaign }: { campaign: CampaignSummary }) {
  const chip = CAMPAIGN_STATUS_CHIP[campaign.status];
  // Multi-run campaigns (run_seq > 1): the audience snapshot and the
  // event counts are scoped to the campaign row, i.e. totals across every
  // run (the schema carries no per-run column on sends or the snapshot),
  // so both are labeled as such instead of passing for one run's numbers.
  const multiRun = campaign.runSeq > 1;
  const recipients =
    (campaign.recipients === 1
      ? "1 recipient"
      : `${campaign.recipients} recipients`) + (multiRun ? " (all runs)" : "");
  return (
    <article className="campaign-row">
      <div className="campaign-row-head">
        <div className="campaign-row-title">
          <span className="campaign-name">{campaign.name}</span>
          <span className="campaign-key">
            {campaign.key}
            {campaign.runSeq > 1 ? ` · run ${campaign.runSeq}` : ""}
          </span>
        </div>
        <span className={`status-chip status-chip--${chip.chip}`}>
          <span className="status-dot" />
          {chip.label}
        </span>
      </div>
      <div className="campaign-row-meta">
        {recipients}
        {" · created "}
        {DATE_FMT.format(campaign.createdAt)}
        {campaign.approvedAt
          ? ` · approved ${DATE_FMT.format(campaign.approvedAt)}`
          : ""}
      </div>
      {hasResults(campaign) ? (
        <>
          {multiRun ? (
            <div className="campaign-results-scope">
              Totals across {campaign.runSeq} runs
            </div>
          ) : null}
          <div
            className={`campaign-results${
              multiRun ? " campaign-results--multirun" : ""
            }`}
          >
            {RESULT_CELLS.map(([key, label]) => (
              <div key={key} className="campaign-result">
                <span className="campaign-result-num">
                  {campaign.events[key]}
                </span>
                <span className="campaign-result-label">{label}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="campaign-results-none">No sends yet.</div>
      )}
    </article>
  );
}

export default async function CampaignsPage() {
  const role = await currentRole();
  if (!hasPermission(role, "campaigns:view")) {
    return (
      <div className="page page--campaigns">
        <header className="page-head">
          <h1>Campaigns</h1>
          <p>Audience, status and delivery results per campaign.</p>
        </header>
        <p className="settings-help">
          Your role cannot view campaigns. Ask an owner for access.
        </p>
      </div>
    );
  }

  const campaigns = await campaignList();

  return (
    <div className="page page--campaigns">
      <header className="page-head">
        <h1>Campaigns</h1>
        <p>Audience, status and delivery results per campaign.</p>
      </header>
      {campaigns.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            {"◎"}
          </div>
          <div className="empty-state-title">No campaigns yet</div>
          <div className="empty-state-sub">
            Campaigns will appear here once the first one is created.
          </div>
        </div>
      ) : (
        <div className="campaign-list">
          {campaigns.map((campaign) => (
            <CampaignRow key={campaign.id} campaign={campaign} />
          ))}
        </div>
      )}
    </div>
  );
}
