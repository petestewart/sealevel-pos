import { listItems } from "@ai-manager/core";
import type { Widget } from "./types";

/**
 * Items count widget: the first widget on the items backbone. Counts
 * unresolved items by status (open, unassigned, pending approval). Reads
 * Postgres server-side via @ai-manager/core helpers; never imported by
 * client components.
 */
export const itemsCountWidget: Widget = {
  id: "items-count",
  domain: "items",
  icon: "mail",
  requires: "items:view",
  detailRoute: "/approvals",
  summary: async () => {
    const [open, unassigned, pendingApproval] = await Promise.all([
      listItems({ status: "open" }),
      listItems({ status: "unassigned" }),
      listItems({ status: "pending_approval" }),
    ]);
    const count = open.length + unassigned.length + pendingApproval.length;
    return {
      count,
      breakdown: [
        { label: `${pendingApproval.length} pending approval`, tone: "pending" },
        { label: `${unassigned.length} unassigned`, tone: "unassigned" },
        { label: `${open.length} open`, tone: "accent" },
      ],
      status: pendingApproval.length > 0 || unassigned.length > 0 ? "attention" : "ok",
    };
  },
};
