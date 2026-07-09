import { currentRole, hasPermission } from "../../lib/rbac";
import { pendingApprovals } from "../../lib/approvals";
import { approveItemAction, rejectItemAction } from "./actions";

/**
 * Approval inbox: every item with status pending_approval, newest first.
 * Approve and Reject are server actions that
 * record the decision and resolve the item. Nothing auto-sends in v1; the
 * acting Job B is a later ticket (see lib/approvals.ts).
 */
export default async function ApprovalsPage() {
  const role = await currentRole();
  const canDecide = hasPermission(role, "approvals:decide");
  const items = await pendingApprovals();

  return (
    <>
      <h1>Approvals</h1>
      <p>
        Items waiting on a human decision. Approving records your decision on
        the item; the follow-up action ships in a later phase, so nothing is
        sent automatically.
      </p>
      {items.length === 0 ? (
        <p className="empty-state">Nothing is waiting for approval.</p>
      ) : (
        <ul className="item-list">
          {items.map((item) => (
            <li key={item.id} className="item-card">
              <div className="meta">
                #{item.id} · {item.type}
                {item.domain ? ` · ${item.domain}` : ""}
                {item.assignee ? ` · assigned to ${item.assignee}` : ""}
                {" · created "}
                {item.created_at.toISOString().slice(0, 16).replace("T", " ")}
              </div>
              <pre>{JSON.stringify(item.payload, null, 2)}</pre>
              {canDecide ? (
                <div className="actions">
                  <form action={approveItemAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <button type="submit" className="approve">
                      Approve
                    </button>
                  </form>
                  <form action={rejectItemAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <button type="submit" className="reject">
                      Reject
                    </button>
                  </form>
                </div>
              ) : (
                <div className="meta">Your role can view but not decide.</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
