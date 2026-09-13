"use client";

import { parseEntries } from "@/lib/notesig";

/**
 * T58: a note, red alert or yellow alert rendered entry by entry, the
 * signature apart from the text. Pete: "put the name in a lighter/
 * different font next to the note". Each entry is its own block in the
 * caller's class (the stop pair for a red alert, the warn pair for a
 * yellow, plain for notes), and a signed one carries "by Name, date"
 * on the line after its text, 14px muted (`.note-sig`). The raw tag
 * never shows: the reading views, the profile card and the info view
 * all come through here, and the one-line summaries elsewhere use
 * stripSignatures.
 *
 * Renders nothing for text with no entries, so callers can keep their
 * own "None." placeholder logic on the raw string.
 */
export default function NoteText({
  text,
  className,
}: {
  text: string | null | undefined;
  /** The per-entry block class, e.g. "ctx-alert modal-alert". */
  className: string;
}) {
  const entries = parseEntries(text);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((e, i) => (
        <p key={i} className={className}>
          {e.text}
          {e.by ? (
            <span className="note-sig">
              by {e.by}, {e.on}
            </span>
          ) : null}
        </p>
      ))}
    </>
  );
}
