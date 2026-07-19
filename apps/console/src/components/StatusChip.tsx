export type StatusChipVariant =
  | "pending"
  | "approved"
  | "rejected"
  | "noreply"
  | "unassigned";

const LABELS: Record<StatusChipVariant, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  noreply: "No reply needed",
  unassigned: "Unassigned",
};

/**
 * 999px-radius status chip with a 6px dot, per the design system
 * (DESIGN-NOTES.md "Patterns"). Children override the default label.
 */
export function StatusChip({
  variant,
  children,
}: {
  variant: StatusChipVariant;
  children?: React.ReactNode;
}) {
  return (
    <span className={`status-chip status-chip--${variant}`}>
      <span className="status-dot" />
      {children ?? LABELS[variant]}
    </span>
  );
}
