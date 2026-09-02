/**
 * The shape of a comp's reason (T45). Shared by the sale screen's dialog
 * and /api/checkout so what the dialog builds is what the route accepts,
 * and rendered the same way everywhere it is shown: the quiet line, the
 * done screen, the `reason` column and the Formula Note.
 *
 * T43's reason was a free string the preset chips pasted in, so a "Teacher"
 * comp and a "teacher" comp were two different rows and nothing could be
 * counted. Pete: "we aren't saving an enum with the row is that right? we
 * should." So the reason is a KIND from a closed list, an optional free
 * `detail`, and for a teacher comp the staff member it was for, chosen
 * from Mindbody's staff list rather than typed. No hex, no React, no
 * server imports: this module runs in both places.
 */

export const COMP_KINDS = [
  "teacher",
  "trade",
  "goodwill",
  "damaged",
  "other",
] as const;

export type CompKind = (typeof COMP_KINDS)[number];

export const COMP_KIND_LABELS: Record<CompKind, string> = {
  teacher: "Teacher",
  trade: "Trade",
  goodwill: "Goodwill",
  damaged: "Damaged item",
  other: "Other",
};

/** The free text's bounds. Required only for `other`, where the kind
 *  says nothing by itself; optional for the rest. The maximum is the
 *  T43 bound, mirrored in the dialog's maxLength. */
export const COMP_DETAIL_MIN = 3;
export const COMP_DETAIL_MAX = 200;

export interface CompReason {
  kind: CompKind;
  /** Trimmed free text; empty when nothing was written. */
  detail: string;
  /** The staff member a teacher comp was for. Present exactly when
   *  `kind` is "teacher". The name is resolved server-side from the
   *  staff list by id; the browser's copy is display only. */
  forStaffId?: number;
  forStaffName?: string;
}

/** T48: a teacher's comp PIN is 4 to 6 digits. Here rather than in
 *  teacherpins.ts because the dialog's keypad and the routes' checks
 *  must agree, and this module is the one both can import. */
export const PIN_MIN = 4;
export const PIN_MAX = 6;
const PIN_SHAPE = /^\d{4,6}$/;

export function isPinShape(value: unknown): value is string {
  return typeof value === "string" && PIN_SHAPE.test(value);
}

export function isCompKind(value: unknown): value is CompKind {
  return (
    typeof value === "string" && (COMP_KINDS as readonly string[]).includes(value)
  );
}

/** Whether a draft reason is complete: a kind, the detail when the kind
 *  needs it, and for a teacher comp the teacher. The route applies the
 *  same rule to what arrives. */
export function compValid(reason: {
  kind: CompKind | null;
  detail: string;
  forStaffId: number | null;
}): boolean {
  if (reason.kind === null) return false;
  const detail = reason.detail.trim();
  if (detail.length > COMP_DETAIL_MAX) return false;
  if (reason.kind === "other" && detail.length < COMP_DETAIL_MIN) return false;
  if (reason.kind === "teacher") {
    return (
      typeof reason.forStaffId === "number" &&
      Number.isInteger(reason.forStaffId) &&
      reason.forStaffId > 0
    );
  }
  return true;
}

/** The short form: `Teacher (Kim Farrell)`, `Goodwill`, `Other`. The
 *  detail is not in it; the done screen shows that on its own line. */
export function compHeadline(reason: CompReason): string {
  const label = COMP_KIND_LABELS[reason.kind];
  return reason.kind === "teacher" && reason.forStaffName
    ? `${label} (${reason.forStaffName})`
    : label;
}

/** The one-line form kept in comp_receipts.reason, so a T43 row ("Teacher,
 *  covering for Pete") and a T45 row read alike: `Teacher: Kim Farrell`,
 *  `Teacher: Kim Farrell, covering for Pete`, `Goodwill: spilled tea`,
 *  `Goodwill`. */
export function compReasonLine(reason: CompReason): string {
  const parts: string[] = [];
  if (reason.kind === "teacher" && reason.forStaffName) {
    parts.push(reason.forStaffName);
  }
  if (reason.detail) parts.push(reason.detail);
  const label = COMP_KIND_LABELS[reason.kind];
  return parts.length ? `${label}: ${parts.join(", ")}` : label;
}
