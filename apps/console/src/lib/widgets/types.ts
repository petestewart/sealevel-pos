import type { Permission } from "../rbac";

/**
 * Widget contract per ARCHITECTURE.md "Operator console — designed for
 * continuous change". A widget is an isolated module: the main view renders
 * one summary card per widget the user is permitted to see, each linking to
 * its detail route. New domains drop in a new widget without touching others.
 */

/** Icon tile shown on the widget card; the SVGs live in WidgetCard. */
export type WidgetIcon = "mail";

/** Dot color for a breakdown stat, from the semantic status palette. */
export type StatusTone =
  | "pending"
  | "approved"
  | "rejected"
  | "unassigned"
  | "accent";

export interface WidgetBreakdownStat {
  /** e.g. "3 pending approval" */
  label: string;
  tone: StatusTone;
}

export interface WidgetSummary {
  count: number;
  /** Status-dot rows under the count, e.g. "2 open" / "1 pending approval". */
  breakdown: readonly WidgetBreakdownStat[];
  /** Card accent: "ok" (nothing urgent) or "attention" (needs a human). */
  status: "ok" | "attention";
}

export interface Widget {
  id: string;
  domain: string;
  icon: WidgetIcon;
  /** RBAC gate: the widget is only rendered for roles holding this permission. */
  requires: Permission;
  summary: (userId: string) => Promise<WidgetSummary>;
  /** Drill-in view the summary card links to. */
  detailRoute: string;
}
