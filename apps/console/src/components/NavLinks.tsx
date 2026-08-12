"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Nav links with the 2px accent underline on the active route and the
 * pending-count pill next to Approvals (hidden at zero), per the
 * Console.dc.html nav spec.
 */
export function NavLinks({
  pendingCount,
  showCampaigns = false,
  showSettings = false,
}: {
  pendingCount: number;
  /** Roles with campaigns:view get the Campaigns section link (SEA-90);
   * the page re-checks RBAC. */
  showCampaigns?: boolean;
  /** Owners get the Settings link (GH-66); the page re-checks RBAC. */
  showSettings?: boolean;
}) {
  const pathname = usePathname();
  const dashActive = pathname === "/";
  // The approvals inbox lives under /items (A1b); /approvals redirects.
  const approvalsActive =
    pathname.startsWith("/items") || pathname.startsWith("/approvals");
  const campaignsActive = pathname.startsWith("/campaigns");
  const settingsActive = pathname.startsWith("/settings");

  return (
    <div className="nav-links">
      <Link href="/" className={`nav-link${dashActive ? " is-active" : ""}`}>
        Dashboard
      </Link>
      <div className="nav-link-group">
        <Link
          href="/items/pending"
          className={`nav-link${approvalsActive ? " is-active" : ""}`}
        >
          Approvals
        </Link>
        {pendingCount > 0 ? (
          <span className="nav-pill">{pendingCount}</span>
        ) : null}
      </div>
      {showCampaigns ? (
        <Link
          href="/campaigns"
          className={`nav-link${campaignsActive ? " is-active" : ""}`}
        >
          Campaigns
        </Link>
      ) : null}
      {showSettings ? (
        <Link
          href="/settings"
          className={`nav-link${settingsActive ? " is-active" : ""}`}
        >
          Settings
        </Link>
      ) : null}
    </div>
  );
}
