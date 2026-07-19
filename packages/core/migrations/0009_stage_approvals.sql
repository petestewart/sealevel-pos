-- 0009_stage_approvals: per-user review-queue mode (GH-106).
--
-- stage_approvals: when true, THIS user's approvals record the decision
-- but do not queue delivery; the approved reply waits in the console's
-- Approved queue until an operator releases it (Send approved). Default
-- false keeps today's behavior: approving queues delivery immediately.
-- Staging itself needs no column: a staged item is simply an approved,
-- resolved email reply whose payload carries no delivery record yet.

ALTER TABLE user_settings
  ADD COLUMN stage_approvals boolean NOT NULL DEFAULT false;
