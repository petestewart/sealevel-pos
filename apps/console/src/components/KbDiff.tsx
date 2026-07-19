import { diffStats, lineDiff } from "../lib/lineDiff";

/**
 * Rendered before/after line diff for a kb_update proposal (GH-112). Pure
 * presentational component over lib/lineDiff (no dependency, no client
 * hooks), so the pending card (client) and the decided detail (server)
 * share one renderer. Additions green, deletions red, collapsed unchanged
 * runs as an ellipsis divider; a new page renders as all additions.
 */
export function KbDiff({
  before,
  after,
  newPage,
}: {
  before: string;
  after: string;
  /** True for a new_page proposal (labels the header honestly). */
  newPage: boolean;
}) {
  const rows = lineDiff(before, after);
  const { added, removed } = diffStats(rows);
  return (
    <div className="kb-diff">
      <div className="kb-diff-head">
        <span className="micro-label">
          {newPage ? "New page content" : "Proposed change"}
        </span>
        <span className="kb-diff-stats">
          <span className="kb-diff-stat kb-diff-stat--add">+{added}</span>
          <span className="kb-diff-stat kb-diff-stat--del">-{removed}</span>
        </span>
      </div>
      <div className="kb-diff-body">
        {rows.map((row, i) =>
          row.kind === "gap" ? (
            <div key={i} className="kb-diff-row kb-diff-row--gap" aria-hidden="true">
              · · ·
            </div>
          ) : (
            <div key={i} className={`kb-diff-row kb-diff-row--${row.kind}`}>
              <span className="kb-diff-sign" aria-hidden="true">
                {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
              </span>
              <span className="kb-diff-text">
                {row.text.length > 0 ? row.text : " "}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
