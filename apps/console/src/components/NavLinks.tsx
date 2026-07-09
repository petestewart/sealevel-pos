"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Nav links with the 2px accent underline on the active route and the
 * pending-count pill next to Approvals (hidden at zero), per the
 * Console.dc.html nav spec.
 */
export function NavLinks({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  const dashActive = pathname === "/";
  const approvalsActive = pathname.startsWith("/approvals");

  return (
    <div className="nav-links">
      <Link href="/" className={`nav-link${dashActive ? " is-active" : ""}`}>
        Dashboard
      </Link>
      <div className="nav-link-group">
        <Link
          href="/approvals"
          className={`nav-link${approvalsActive ? " is-active" : ""}`}
        >
          Approvals
        </Link>
        {pendingCount > 0 ? (
          <span className="nav-pill">{pendingCount}</span>
        ) : null}
      </div>
    </div>
  );
}
