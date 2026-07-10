-- 0005_rules_settings: owner-configurable drafting rules and per-user
-- signature settings (GH-66).
--
-- rules: plain-English studio rules injected into the email.draft and
-- item.revise system prompts as a "Studio rules" block. Editable in the
-- console settings page (owner-only); soft-disable via active=false so
-- history is kept. Text is bounded so a rule cannot bloat the prompt.
--
-- user_settings: per-user signature preference. Drafts always sign off
-- as "Sealevel Hot Yoga"; a user with sign_with_name=true gets their
-- name added to the signoff when THEY approve a reply.

CREATE TABLE rules (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_text   text NOT NULL CHECK (length(rule_text) BETWEEN 1 AND 500),
  category    text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE INDEX rules_active_idx ON rules (active) WHERE active;

INSERT INTO rules (rule_text, category, updated_by) VALUES
  ('Never mention the website or booking page without including its link.', 'links', 'seed');

CREATE TABLE user_settings (
  user_id        text PRIMARY KEY,
  sign_with_name boolean NOT NULL DEFAULT false,
  signature_name text CHECK (signature_name IS NULL OR length(signature_name) BETWEEN 1 AND 80),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
