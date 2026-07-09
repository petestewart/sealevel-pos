-- 0002_items: the items backbone (ARCHITECTURE.md "Data layer: Postgres").
-- Everything needing human attention is a row here, lifecycle open -> resolved.
-- Deliberately generic: a new domain writes a new type and shows up in
-- dashboard counts, the approval inbox, and notification routing automatically.

CREATE TABLE items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type        text NOT NULL,            -- e.g. email_reply, social_post, anomaly
  domain      text,                     -- owning feature module, e.g. email
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'unassigned', 'pending_approval', 'resolved')),
  audience    text,                     -- who may see it (role/visibility hint)
  assignee    text,                     -- user id/name; NULL = nobody assigned
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX items_status_idx ON items (status) WHERE status <> 'resolved';
CREATE INDEX items_type_idx ON items (type);
CREATE INDEX items_assignee_idx ON items (assignee) WHERE assignee IS NOT NULL;
