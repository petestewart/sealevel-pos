import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { currentRole } from "../lib/rbac";
import { permittedWidgets } from "../lib/widgets/registry";

/**
 * Main view: one summary card per widget the signed-in user's role permits
 * (ARCHITECTURE.md "Operator console"). Widgets read Postgres server-side;
 * each card links to the widget's detail route.
 */
export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) return null; // middleware redirects; this is a type guard

  const role = await currentRole();
  const widgets = permittedWidgets(role);
  const summaries = await Promise.all(
    widgets.map(async (widget) => ({
      widget,
      summary: await widget.summary(userId),
    })),
  );

  return (
    <>
      <h1>Dashboard</h1>
      {summaries.length === 0 ? (
        <p className="empty-state">No widgets are available for your role.</p>
      ) : (
        <div className="card-grid">
          {summaries.map(({ widget, summary }) => (
            <Link
              key={widget.id}
              href={widget.detailRoute}
              className={`summary-card status-${summary.status}`}
            >
              <div className="domain">{widget.domain}</div>
              <div className="count">{summary.count}</div>
              <div className="label">{summary.label}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
