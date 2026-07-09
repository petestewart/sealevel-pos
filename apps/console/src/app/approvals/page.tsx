import { Button } from "../../components/Button";
import { StatusChip } from "../../components/StatusChip";
import { currentRole, hasPermission } from "../../lib/rbac";
import { pendingApprovals } from "../../lib/approvals";
import { approveItemAction, rejectItemAction } from "./actions";

/**
 * Approval inbox: every item with status pending_approval, newest first.
 * Approve and Reject are server actions that record the decision and
 * resolve the item. Nothing auto-sends in v1; the acting Job B is a later
 * ticket (see lib/approvals.ts).
 *
 * Interim skin only: this view gets the design-system tokens and nav so it
 * matches the shell, but the full two-pane approval card is rebuilt in
 * GH-22.
 */
export default async function ApprovalsPage() {
  const role = await currentRole();
  const canDecide = hasPermission(role, "approvals:decide");
  const items = await pendingApprovals();

  return (
    <div className="page page--approvals">
      <header className="page-head">
        <h1>Approvals</h1>
        <p>
          Items waiting on a human decision. Approving records your decision;
          nothing is sent automatically in v1.
        </p>
      </header>
      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            {"◎"}
          </div>
          <div className="empty-state-title">You&apos;re all caught up</div>
          <div className="empty-state-sub">
            Nothing is waiting for approval. New items will appear here as
            they come in.
          </div>
        </div>
      ) : (
        <ul className="item-list">
          {items.map((item) => (
            <li key={item.id} className="item-card">
              <div className="meta">
                <span className="item-id">#{item.id}</span>
                <span>{item.type}</span>
                {item.domain ? <span>{item.domain}</span> : null}
                {item.assignee ? (
                  <span>assigned to {item.assignee}</span>
                ) : null}
                <span>
                  created{" "}
                  {item.created_at.toISOString().slice(0, 16).replace("T", " ")}
                </span>
                <StatusChip variant="pending" />
              </div>
              <pre>{JSON.stringify(item.payload, null, 2)}</pre>
              {canDecide ? (
                <div className="actions">
                  <form action={approveItemAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <Button type="submit" variant="primary">
                      Approve
                    </Button>
                  </form>
                  <form action={rejectItemAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <Button type="submit" variant="destructive-text">
                      Reject
                    </Button>
                  </form>
                </div>
              ) : (
                <div className="meta">Your role can view but not decide.</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
