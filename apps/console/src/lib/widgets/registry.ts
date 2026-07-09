import type { Role } from "../rbac";
import { hasPermission } from "../rbac";
import type { Widget } from "./types";
import { itemsCountWidget } from "./items-count";

/**
 * Widget registry (same plug-in philosophy as the jobs registry): adding a
 * widget means adding it to this array. Ordering here is the default order;
 * per-user dashboard_layouts arrive in a later ticket.
 */
export const WIDGETS: readonly Widget[] = [itemsCountWidget];

/** Widgets the given role is permitted to see (RBAC gate). */
export function permittedWidgets(role: Role): Widget[] {
  return WIDGETS.filter((w) => hasPermission(role, w.requires));
}
