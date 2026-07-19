import { currentUser } from "@clerk/nextjs/server";
import {
  getLearningState,
  getStudioInfoEntries,
  getUserSettings,
  listRules,
  type LearningState,
} from "@ai-manager/core";
import {
  AddRuleForm,
  AddStudioInfoForm,
  MineLessonsForm,
  RuleRow,
  SignatureForm,
  StageApprovalsForm,
  StudioInfoEntryRow,
} from "../../components/SettingsForms";
import { currentRole, hasPermission } from "../../lib/rbac";

/**
 * Settings page (GH-66): owner-editable studio drafting rules and the
 * current user's signature preference. The page renders an access note
 * for non-owners; the server actions enforce settings:manage on every
 * mutation regardless.
 */

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const role = await currentRole();
  const canManage = hasPermission(role, "settings:manage");

  if (!canManage) {
    return (
      <div className="page page--settings">
        <header className="page-head">
          <h1>Settings</h1>
          <p>Studio rules and signature preferences.</p>
        </header>
        <p className="settings-help">
          Your role can view the console but not manage settings. Ask an
          owner to make changes here.
        </p>
      </div>
    );
  }

  const user = await currentUser();
  const userId = user?.id ?? "";
  const defaultName = user?.firstName ?? user?.fullName ?? "Your name";
  const [rules, settings, studioInfo] = await Promise.all([
    listRules(),
    getUserSettings(userId),
    getStudioInfoEntries(),
  ]);
  // Learning-loop state (GH-127), best-effort: a missing table (migration
  // not yet applied) degrades to the section rendering without stats.
  let learning: LearningState | null = null;
  try {
    learning = await getLearningState();
  } catch {
    learning = null;
  }
  const lastMined =
    learning !== null && Date.parse(learning.last_mined_at) > 0
      ? new Date(learning.last_mined_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  return (
    <div className="page page--settings">
      <header className="page-head">
        <h1>Settings</h1>
        <p>Studio rules and signature preferences.</p>
      </header>

      <section className="settings-section">
        <h2 className="section-label">Studio rules</h2>
        <p className="settings-help">
          Plain English rules the AI follows in every drafted reply and
          revision. Changes apply to the next draft.
        </p>
        {rules.length === 0 ? (
          <p className="settings-help">No rules yet. Add the first one below.</p>
        ) : (
          rules.map((rule) => <RuleRow key={rule.id} rule={rule} />)
        )}
        <AddRuleForm />
      </section>

      <section className="settings-section">
        <h2 className="section-label">Studio info</h2>
        <p className="settings-help">
          Customer-safe facts the AI can use in replies, as labeled
          entries: the booking link, contact details, policies, or
          anything else it should know. Think of it as an FAQ for the
          model. Removed entries leave drafts immediately.
        </p>
        {studioInfo.length === 0 ? (
          <p className="settings-help">No entries yet. Add the first one below.</p>
        ) : (
          studioInfo.map((entry) => (
            <StudioInfoEntryRow key={entry.key} entry={entry} />
          ))
        )}
        <AddStudioInfoForm />
      </section>

      <section className="settings-section">
        <h2 className="section-label">Learning</h2>
        <p className="settings-help">
          The system watches how you correct its drafts (edits, redos,
          rejections) and periodically proposes new studio rules from
          repeated patterns. Proposals appear in the Pending queue for
          your approval; nothing is learned without it, and approved
          rules show up above as regular rules you can edit or delete.
          Mining runs nightly and after bursts of decisions; use the
          button to mine right away.
        </p>
        {learning !== null ? (
          <p className="settings-help">
            {lastMined
              ? `Last mined ${lastMined}. `
              : "Not mined yet. "}
            {learning.runs} run{learning.runs === 1 ? "" : "s"},{" "}
            {learning.signals_seen} correction
            {learning.signals_seen === 1 ? "" : "s"} examined,{" "}
            {learning.proposals_filed} proposal
            {learning.proposals_filed === 1 ? "" : "s"} filed.
          </p>
        ) : null}
        <MineLessonsForm />
      </section>

      <section className="settings-section">
        <h2 className="section-label">Signature</h2>
        <SignatureForm settings={settings} defaultName={defaultName} />
      </section>

      <section className="settings-section">
        <h2 className="section-label">Approvals</h2>
        <StageApprovalsForm settings={settings} />
      </section>
    </div>
  );
}
