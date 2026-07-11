-- 0006_studio_info: owner-configurable studio facts (GH-71).
--
-- A small key-value table of stable, customer-safe facts (booking URL,
-- address, policies, ...) edited on the console settings page and
-- injected into the email.draft and item.revise prompts as a
-- "Studio info" block, alongside the GH-66 studio rules. The valid
-- field keys are defined in code (STUDIO_INFO_FIELDS); unknown keys are
-- never written. Values are bounded so a field cannot bloat the prompt.
-- Clearing a field deletes its row: empty values are never stored, so
-- nothing placeholder-ish can ever reach a draft.

CREATE TABLE studio_info (
  field       text PRIMARY KEY,
  value       text NOT NULL CHECK (length(value) BETWEEN 1 AND 500),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
