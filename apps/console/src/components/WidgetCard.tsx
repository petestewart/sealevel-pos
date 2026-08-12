import Link from "next/link";
import type { WidgetIcon, WidgetSummary } from "../lib/widgets/types";

/**
 * Dashboard widget card per the Console.dc.html spec: icon tile + mono
 * uppercase domain label + arrow, 40px count, status-dot breakdown row.
 * Hover lifts the card and tints the border accent (CSS).
 */

const ICONS: Record<WidgetIcon, React.ReactNode> = {
  mail: (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  ),
  megaphone: (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  ),
};

export function WidgetCard({
  href,
  domain,
  icon,
  summary,
}: {
  href: string;
  domain: string;
  icon: WidgetIcon;
  summary: WidgetSummary;
}) {
  const attention = summary.status === "attention";
  return (
    <Link
      href={href}
      className={`widget-card${attention ? " widget-card--attention" : ""}`}
    >
      <div className="widget-card-head">
        <div className="widget-card-domain">
          <div className="widget-card-icon">{ICONS[icon]}</div>
          <span className="widget-card-label">{domain}</span>
        </div>
        <span className="widget-card-arrow">{"→"}</span>
      </div>
      <div className="widget-card-count">{summary.count}</div>
      <div className="widget-card-breakdown">
        {summary.breakdown.map((stat) => (
          <span key={stat.label} className="widget-card-stat">
            <span className={`status-dot dot--${stat.tone}`} />
            {stat.label}
          </span>
        ))}
      </div>
    </Link>
  );
}
