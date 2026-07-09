import { auth } from "@clerk/nextjs/server";
import { WidgetCard } from "../components/WidgetCard";
import { currentRole } from "../lib/rbac";
import { permittedWidgets } from "../lib/widgets/registry";

/**
 * Overview: one summary card per widget the signed-in user's role permits
 * (ARCHITECTURE.md "Operator console"). Widgets read Postgres server-side;
 * each card links to the widget's detail route. Only real registry widgets
 * render here: no mock cards (DESIGN-NOTES.md, manager decision 2).
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

  const today = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "America/Los_Angeles",
  }).format(new Date());

  return (
    <div className="page page--dash">
      <header className="page-head">
        <h1>Overview</h1>
        <p>What needs your attention · {today}</p>
      </header>
      {summaries.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            {"◎"}
          </div>
          <div className="empty-state-title">No widgets available</div>
          <div className="empty-state-sub">
            No widgets are available for your role.
          </div>
        </div>
      ) : (
        <div className="card-grid">
          {summaries.map(({ widget, summary }) => (
            <WidgetCard
              key={widget.id}
              href={widget.detailRoute}
              domain={widget.domain}
              icon={widget.icon}
              summary={summary}
            />
          ))}
        </div>
      )}
    </div>
  );
}
