"use client";

import { useState } from "react";
import {
  clampLines,
  htmlToText,
  looksLikeHtml,
  splitQuoted,
  type AttachmentInfo,
} from "../lib/emailText";

/**
 * Inbound email body renderer (GH-34): quoted-reply collapse, HTML-to-text
 * guarantee, attachment notice, and long-body clamp. Pure display logic —
 * the stored payload is never mutated, and every string reaches the page
 * only as a React text node (no dangerouslySetInnerHTML), so an HTML or
 * script payload renders as inert text.
 */
export function InboundEmail({
  body,
  attachments,
}: {
  body: string;
  attachments: AttachmentInfo[];
}) {
  const [showQuoted, setShowQuoted] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [showFull, setShowFull] = useState(false);

  const isHtml = looksLikeHtml(body);
  const text = isHtml ? htmlToText(body) : body;
  const { main, quoted } = splitQuoted(text);
  const hasMain = main.trim().length > 0;
  const { clamped, totalLines } = clampLines(main);
  const visibleMain = clamped !== null && !showFull ? clamped : main;

  return (
    <div className="inbound-email">
      <div className="approval-inbound-text">
        {hasMain ? visibleMain : "(no new content, quoted text only)"}
      </div>

      {clamped !== null && !showFull ? (
        <button
          type="button"
          className="inbound-toggle"
          onClick={() => setShowFull(true)}
        >
          Show full message ({totalLines} lines)
        </button>
      ) : null}

      {quoted !== null ? (
        <>
          <button
            type="button"
            className="inbound-toggle"
            aria-expanded={showQuoted}
            onClick={() => setShowQuoted((v) => !v)}
          >
            {showQuoted ? "Hide quoted text" : "Show quoted text"}
          </button>
          {showQuoted ? (
            <div className="approval-inbound-text inbound-quoted">
              {quoted}
            </div>
          ) : null}
        </>
      ) : null}

      {isHtml ? (
        <>
          <button
            type="button"
            className="inbound-toggle"
            aria-expanded={showRaw}
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "Hide raw source" : "Show raw source"}
          </button>
          {showRaw ? <pre className="inbound-raw">{body}</pre> : null}
        </>
      ) : null}

      {attachments.length > 0 ? (
        <div className="inbound-attachments">
          {attachments.length}{" "}
          {attachments.length === 1 ? "attachment" : "attachments"} (not
          shown)
        </div>
      ) : null}
    </div>
  );
}

export type { AttachmentInfo };
