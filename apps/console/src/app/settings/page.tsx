import { currentUser } from "@clerk/nextjs/server";
import { getUserSettings, listRules } from "@ai-manager/core";
import {
  AddRuleForm,
  RuleRow,
  SignatureForm,
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
  const [rules, settings] = await Promise.all([
    listRules(),
    getUserSettings(userId),
  ]);

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
        <h2 className="section-label">Signature</h2>
        <SignatureForm settings={settings} defaultName={defaultName} />
      </section>
    </div>
  );
}
