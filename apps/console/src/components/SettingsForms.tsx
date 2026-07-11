"use client";

import { useActionState } from "react";
import type { Rule, StudioInfoField, UserSettings } from "@ai-manager/core";
import {
  addRule,
  saveRule,
  saveSignature,
  saveStudioInfo,
  setRuleActive,
  type SettingsActionState,
} from "../app/settings/actions";

/**
 * Client forms for the settings page (GH-66). Each form posts to a
 * server action and renders inline errors via useActionState; the
 * server actions re-check settings:manage on every call, so these
 * forms are presentation only.
 */

const IDLE: SettingsActionState = { error: null };

function InlineError({ state }: { state: SettingsActionState }) {
  if (!state.error) return null;
  return (
    <p className="settings-error" role="alert">
      {state.error}
    </p>
  );
}

export function AddRuleForm() {
  const [state, formAction, pending] = useActionState(addRule, IDLE);
  return (
    <form action={formAction} className="settings-add-rule">
      <label className="field-label" htmlFor="new-rule-text">
        New rule
      </label>
      <textarea
        id="new-rule-text"
        name="rule_text"
        className="draft-body-input settings-rule-input"
        placeholder="Write the rule in plain English, e.g. Always mention free mat rental for first visits."
        maxLength={500}
        required
      />
      <div className="settings-form-row">
        <input
          type="text"
          name="category"
          className="draft-subject-input settings-category-input"
          placeholder="Category (optional)"
          maxLength={40}
        />
        <button type="submit" className="btn btn--primary" disabled={pending}>
          {pending ? "Adding..." : "Add rule"}
        </button>
      </div>
      <InlineError state={state} />
    </form>
  );
}

export function RuleRow({ rule }: { rule: Rule }) {
  const [editState, editAction, editPending] = useActionState(saveRule, IDLE);
  const [toggleState, toggleAction, togglePending] = useActionState(
    setRuleActive,
    IDLE,
  );
  return (
    <div className={`settings-rule${rule.active ? "" : " is-inactive"}`}>
      <form action={editAction} className="settings-rule-edit">
        <input type="hidden" name="id" value={rule.id} />
        <textarea
          name="rule_text"
          className="draft-body-input settings-rule-input"
          defaultValue={rule.rule_text}
          maxLength={500}
          required
          aria-label="Rule text"
        />
        <div className="settings-form-row">
          {rule.category ? (
            <span className="settings-rule-category">{rule.category}</span>
          ) : null}
          <span className="settings-rule-status">
            {rule.active ? "Active" : "Disabled"}
          </span>
          <button
            type="submit"
            className="btn btn--outlined"
            disabled={editPending}
          >
            {editPending ? "Saving..." : "Save"}
          </button>
        </div>
        <InlineError state={editState} />
      </form>
      <form action={toggleAction} className="settings-rule-toggle">
        <input type="hidden" name="id" value={rule.id} />
        <input
          type="hidden"
          name="active"
          value={rule.active ? "false" : "true"}
        />
        <button
          type="submit"
          className={`btn ${rule.active ? "btn--destructive-text" : "btn--outlined"}`}
          disabled={togglePending}
        >
          {togglePending
            ? "Working..."
            : rule.active
              ? "Disable"
              : "Enable"}
        </button>
        <InlineError state={toggleState} />
      </form>
    </div>
  );
}

export function SignatureForm({
  settings,
  defaultName,
}: {
  settings: UserSettings;
  defaultName: string;
}) {
  const [state, formAction, pending] = useActionState(saveSignature, IDLE);
  return (
    <form action={formAction} className="settings-signature">
      <p className="settings-help">
        Approved replies always end with the studio signoff, "Sealevel Hot
        Yoga". Turn this on to add your name above it when you approve a
        reply.
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          name="sign_with_name"
          defaultChecked={settings.sign_with_name}
        />
        <span>Sign approved replies with my name</span>
      </label>
      <label className="field-label" htmlFor="signature-name">
        Name to sign with
      </label>
      <input
        id="signature-name"
        type="text"
        name="signature_name"
        className="draft-subject-input settings-category-input"
        defaultValue={settings.signature_name ?? ""}
        placeholder={defaultName}
        maxLength={80}
      />
      <div className="settings-form-row">
        <button type="submit" className="btn btn--primary" disabled={pending}>
          {pending ? "Saving..." : "Save signature"}
        </button>
        {state.saved && !state.error ? (
          <span className="settings-saved">Saved.</span>
        ) : null}
      </div>
      <InlineError state={state} />
    </form>
  );
}

export function StudioInfoForm({
  fields,
  values,
}: {
  fields: readonly StudioInfoField[];
  values: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(saveStudioInfo, IDLE);
  return (
    <form action={formAction} className="settings-studio-info">
      {fields.map((field) => (
        <div key={field.key} className="settings-info-field">
          <label className="field-label" htmlFor={`info-${field.key}`}>
            {field.label}
          </label>
          {field.multiline ? (
            <textarea
              id={`info-${field.key}`}
              name={field.key}
              className="draft-body-input settings-info-input"
              defaultValue={values[field.key] ?? ""}
              placeholder={field.hint}
              maxLength={500}
              rows={2}
            />
          ) : (
            <input
              type="text"
              id={`info-${field.key}`}
              name={field.key}
              className="draft-subject-input settings-info-input"
              defaultValue={values[field.key] ?? ""}
              placeholder={field.hint}
              maxLength={500}
            />
          )}
        </div>
      ))}
      <div className="settings-form-row">
        <button type="submit" className="btn btn--primary" disabled={pending}>
          {pending ? "Saving..." : "Save studio info"}
        </button>
        {state.saved && !state.error ? (
          <span className="settings-saved-note">Saved.</span>
        ) : null}
      </div>
      <InlineError state={state} />
    </form>
  );
}
