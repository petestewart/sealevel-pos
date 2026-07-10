import { itemStatusCounts } from "../approvals";
import type { Widget } from "./types";

/**
 * Items count widget: the first widget on the items backbone. Counts
 * unresolved items by status (open, unassigned, pending approval) via one
 * GROUP BY query (GH-27) instead of fetching full row sets. Reads
 * Postgres server-side; never imported by client components.
 */
export const itemsCountWidget: Widget = {
  id: "items-count",
  domain: "items",
  icon: "mail",
  requires: "items:view",
  detailRoute: "/items/pending",
  summary: async () => {
    const { open, unassigned, pending_approval: pendingApproval } =
      await itemStatusCounts();
    const count = open + unassigned + pendingApproval;
    return {
      count,
      breakdown: [
        { label: `${pendingApproval} pending approval`, tone: "pending" },
        { label: `${unassigned} unassigned`, tone: "unassigned" },
        { label: `${open} open`, tone: "accent" },
      ],
      status: pendingApproval > 0 || unassigned > 0 ? "attention" : "ok",
    };
  },
};
