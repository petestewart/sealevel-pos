-- 0019_payroll_invoice_pushing: add the in-flight claim state (SEA-104).
--
-- payroll.push's atomic claim (idempotency layer 3, automation plan §2.8,
-- in the style of claimDeliveryForSend) needs a state that marks "one
-- worker is writing this Bill right now": the guarded UPDATE from
-- 'queued' to 'pushing' is what makes a concurrent retry lose cleanly
-- instead of writing a second Bill. 0016 shipped the CHECK without it;
-- widen it. Transitions: prepared -> queued (approve) -> pushing (claim)
-- -> pushed (Bill written, qbo_ref set) or failed (surfaced for reopen +
-- re-approve).

ALTER TABLE payroll_invoices
  DROP CONSTRAINT payroll_invoices_status_check;
ALTER TABLE payroll_invoices
  ADD CONSTRAINT payroll_invoices_status_check
  CHECK (status IN ('prepared', 'queued', 'pushing', 'pushed', 'failed'));
