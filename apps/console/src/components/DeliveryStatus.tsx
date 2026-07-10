/**
 * Delivery status line for a decided reply (GH-56, QA roadmap C1).
 *
 * Nothing auto-sends in v1: approving records the decision, it does not
 * deliver the email. This line states that plainly so an operator never
 * assumes an approved reply went out. It is a dedicated status component
 * (not prose inside the audit line) so a future sending phase can swap in
 * a real sent status and timestamp without restructuring the view.
 */
export function DeliveryStatus({
  approved,
  hasReply,
}: {
  approved: boolean;
  hasReply: boolean;
}) {
  const copy = approved
    ? hasReply
      ? "Approved, not sent. Sending is not wired up yet, so this reply has not gone to the customer."
      : "Approved, not sent. No draft was generated and nothing has gone to the customer."
    : "Not sent. Rejected drafts are never delivered.";
  return (
    <div
      className={`delivery-status${approved ? " delivery-status--pending" : ""}`}
      role="note"
    >
      <span className="delivery-status-dot" aria-hidden="true" />
      <span>{copy}</span>
    </div>
  );
}
