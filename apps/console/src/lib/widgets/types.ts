import type { Permission } from "../rbac";

/**
 * Widget contract per ARCHITECTURE.md "Operator console — designed for
 * continuous change". A widget is an isolated module: the main view renders
 * one summary card per widget the user is permitted to see, each linking to
 * its detail route. New domains drop in a new widget without touching others.
 */

export interface WidgetSummary {
  count: number;
  label: string;
  /** Card accent: "ok" (nothing urgent) or "attention" (needs a human). */
  status: "ok" | "attention";
}

export interface Widget {
  id: string;
  domain: string;
  /** RBAC gate: the widget is only rendered for roles holding this permission. */
  requires: Permission;
  summary: (userId: string) => Promise<WidgetSummary>;
  /** Drill-in view the summary card links to. */
  detailRoute: string;
}
