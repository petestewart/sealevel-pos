import Link from "next/link";

/**
 * Mobile-only back control for the full-screen detail view (A7, GH-35).
 * On a phone the detail replaces the list, so this bar is the way back:
 * it links to the inbox base URL (no ?item), which shows the list again;
 * ListScrollRestore then puts the list back where the operator left it.
 * Hidden above the mobile breakpoint by globals.css, so desktop markup
 * and behavior are unchanged.
 */
export function MobileBackBar({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link href={href} className="mobile-back-bar">
      <span className="mobile-back-arrow" aria-hidden="true">
        {"←"}
      </span>
      <span>Back to {label}</span>
    </Link>
  );
}
