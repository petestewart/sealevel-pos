"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type {
  Rule,
  StudioInfoEntry,
  UserSettings,
} from "@ai-manager/core";
import {
  addRule,
  addStudioInfo,
  removeRule,
  removeStudioInfo,
  saveRule,
  saveSignature,
  saveStageApprovals,
  saveStudioInfoValue,
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

function SaveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M2.5 8.5 6 12l7.5-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M5.5 3v10M10.5 3v10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M5 3.2v9.6L12.4 8 5 3.2Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.7 9h6.6l.7-9M6.6 7v4M9.4 7v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Compact rule row (GH-75): editable text on the left; category, state,
 * and icon actions (save / disable-enable / delete) right-aligned on one
 * line. Delete is a two-step confirm, and the confirm button mounts
 * disabled with a 400ms re-arm (the GH-22 lesson: DOM reuse can land a
 * double-click's second press on a button that just appeared in the same
 * spot).
 */
export function RuleRow({ rule }: { rule: Rule }) {
  const [editState, editAction, editPending] = useActionState(saveRule, IDLE);
  const [toggleState, toggleAction, togglePending] = useActionState(
    setRuleActive,
    IDLE,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    removeRule,
    IDLE,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [armed, setArmed] = useState(false);
  // Keyboard/AT focus: entering confirm mode unmounts the Delete button,
  // so focus is moved to Cancel (safe, always enabled); canceling moves
  // it back to Delete. Without this, focus drops to <body>.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (!confirmingDelete) {
      setArmed(false);
      // Only pull focus back to Delete when leaving confirm mode, not on
      // the initial mount (the ref is attached by the time this runs,
      // unlike the inline rAF this replaces).
      if (wasConfirming.current) deleteRef.current?.focus();
      wasConfirming.current = false;
      return;
    }
    wasConfirming.current = true;
    cancelRef.current?.focus();
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, [confirmingDelete]);

  const anyError = editState.error ?? toggleState.error ?? deleteState.error;

  return (
    <div className={`settings-rule${rule.active ? "" : " is-inactive"}`}>
      <div className="settings-rule-line">
        <form
          action={editAction}
          id={`rule-edit-${rule.id}`}
          className="settings-rule-edit"
        >
          <input type="hidden" name="id" value={rule.id} />
          <textarea
            name="rule_text"
            className="draft-body-input settings-rule-input"
            defaultValue={rule.rule_text}
            maxLength={500}
            required
            rows={1}
            aria-label="Rule text"
          />
        </form>
        <div className="settings-rule-meta">
          {rule.category ? (
            <span className="settings-rule-category">{rule.category}</span>
          ) : null}
          <span className="settings-rule-status">
            {rule.active ? "Active" : "Disabled"}
          </span>
          {confirmingDelete ? (
            <>
              <form action={deleteAction} className="settings-rule-iconform">
                <input type="hidden" name="id" value={rule.id} />
                <button
                  type="submit"
                  className="icon-btn icon-btn--danger"
                  disabled={!armed || deletePending}
                  aria-label="Confirm delete rule"
                  title="Confirm delete"
                >
                  <TrashIcon />
                </button>
              </form>
              <button
                type="button"
                ref={cancelRef}
                className="icon-btn"
                disabled={deletePending}
                onClick={() => setConfirmingDelete(false)}
                aria-label="Cancel delete"
                title="Cancel"
              >
                <CancelIcon />
              </button>
            </>
          ) : (
            <>
              <button
                type="submit"
                form={`rule-edit-${rule.id}`}
                className="icon-btn"
                disabled={editPending}
                aria-label="Save rule"
                title="Save"
              >
                <SaveIcon />
              </button>
              <form action={toggleAction} className="settings-rule-iconform">
                <input type="hidden" name="id" value={rule.id} />
                <input
                  type="hidden"
                  name="active"
                  value={rule.active ? "false" : "true"}
                />
                <button
                  type="submit"
                  className="icon-btn"
                  disabled={togglePending}
                  aria-label={rule.active ? "Disable rule" : "Enable rule"}
                  title={rule.active ? "Disable" : "Enable"}
                >
                  {rule.active ? <PauseIcon /> : <PlayIcon />}
                </button>
              </form>
              <button
                type="button"
                ref={deleteRef}
                className="icon-btn icon-btn--danger"
                onClick={() => setConfirmingDelete(true)}
                aria-label="Delete rule"
                title="Delete"
              >
                <TrashIcon />
              </button>
            </>
          )}
        </div>
      </div>
      {anyError ? (
        <p className="settings-error" role="alert">
          {anyError}
        </p>
      ) : null}
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

/**
 * Review-queue mode (GH-106): a per-user toggle. When on, YOUR approvals
 * record the decision but hold delivery; the reply waits in the Approved
 * queue until someone clicks Send approved (or releases it per item).
 * Other operators' approvals follow their own setting.
 */
export function StageApprovalsForm({ settings }: { settings: UserSettings }) {
  const [state, formAction, pending] = useActionState(saveStageApprovals, IDLE);
  return (
    <form action={formAction} className="settings-signature">
      <p className="settings-help">
        By default, approving a reply queues its delivery right away. Turn
        this on to hold your approved replies in the Approved queue instead;
        nothing goes out until you click Send approved there. The source
        email is still marked read when you approve.
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          name="stage_approvals"
          defaultChecked={settings.stage_approvals}
        />
        <span>Queue approved replies until I click Send approved</span>
      </label>
      <div className="settings-form-row">
        <button type="submit" className="btn btn--primary" disabled={pending}>
          {pending ? "Saving..." : "Save approvals setting"}
        </button>
        {state.saved && !state.error ? (
          <span className="settings-saved">Saved.</span>
        ) : null}
      </div>
      <InlineError state={state} />
    </form>
  );
}

/**
 * One studio info entry: editable value with Save, and a two-step
 * Remove (arm then confirm) consistent with the app's other
 * irreversible actions. Keyed by entry.key from the parent so state
 * resets if the list changes under it.
 */
export function StudioInfoEntryRow({ entry }: { entry: StudioInfoEntry }) {
  const [saveState, saveAction, savePending] = useActionState(
    saveStudioInfoValue,
    IDLE,
  );
  const [removeState, removeAction, removePending] = useActionState(
    removeStudioInfo,
    IDLE,
  );
  const [armed, setArmed] = useState(false);
  return (
    <div className="settings-info-entry">
      <form action={saveAction} className="settings-info-entry-edit">
        <input type="hidden" name="entry_key" value={entry.key} />
        <span className="settings-info-entry-key" title={entry.key}>
          {entry.key}
        </span>
        <textarea
          // Keyed by the stored value so a successful save (which may
          // trim/normalize) re-seeds the uncontrolled textarea with the
          // canonical persisted text instead of the locally typed text.
          key={entry.value}
          name="entry_value"
          className="draft-body-input settings-info-input"
          defaultValue={entry.value}
          maxLength={500}
          rows={2}
          required
          aria-label={`Value for ${entry.key}`}
        />
        <button
          type="submit"
          className="btn btn--outlined"
          disabled={savePending}
        >
          {savePending ? "Saving..." : "Save"}
        </button>
        <InlineError state={saveState} />
      </form>
      <form action={removeAction} className="settings-info-entry-remove">
        <input type="hidden" name="entry_key" value={entry.key} />
        {armed ? (
          <>
            <button
              type="submit"
              className="btn btn--destructive-text"
              disabled={removePending}
            >
              {removePending ? "Removing..." : "Confirm remove"}
            </button>
            <button
              type="button"
              className="btn btn--outlined"
              onClick={() => setArmed(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn--destructive-text"
            onClick={() => setArmed(true)}
          >
            Remove
          </button>
        )}
        <InlineError state={removeState} />
      </form>
    </div>
  );
}

/** Add-entry form: a label ("Booking link") plus its value. */
export function AddStudioInfoForm() {
  const [state, formAction, pending] = useActionState(addStudioInfo, IDLE);
  return (
    <form action={formAction} className="settings-add-info">
      <div className="settings-form-row">
        <input
          type="text"
          name="entry_key"
          className="draft-subject-input settings-category-input"
          placeholder="Label, e.g. Booking link"
          maxLength={80}
          required
          aria-label="New entry label"
        />
      </div>
      <textarea
        name="entry_value"
        className="draft-body-input settings-info-input"
        placeholder="The fact the model should know, e.g. the exact booking URL."
        maxLength={500}
        rows={2}
        required
        aria-label="New entry value"
      />
      <div className="settings-form-row">
        <button type="submit" className="btn btn--primary" disabled={pending}>
          {pending ? "Adding..." : "Add entry"}
        </button>
        {state.saved && !state.error ? (
          <span className="settings-saved-note">Saved.</span>
        ) : null}
      </div>
      <InlineError state={state} />
    </form>
  );
}
