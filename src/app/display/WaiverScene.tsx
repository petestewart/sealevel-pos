"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { plainText } from "@/lib/richtext";

import type { WaiverPayload } from "@/lib/displaywaiver";

/**
 * The waiver, as the student signs it (T202, Phase 2.5 item 3; design
 * "Scene 1").
 *
 * The same discipline T18 put on the counter dialog, on a screen a
 * student is holding: the REAL text, scrolled to the end before the
 * agree button is live, and no path that records an agreement without
 * the full text having been shown. A waiver short enough to need no
 * scrolling counts as read the moment it renders, which is the same
 * carve-out the counter dialog makes.
 *
 * The signature is a `<canvas>` driven by POINTER events, so a finger
 * and an Apple Pencil are the same code, exported as a PNG with a
 * transparent background and a typed name line drawn into the same
 * image: the artifact has to say who signed and when without our
 * database beside it.
 *
 * THIS COMPONENT WRITES NOTHING. It POSTs /api/display/complete with the
 * request id and the signature, or /api/display/refuse with "Not now".
 * The release, the receipt and the document copy are the teacher's
 * iPad's, under the teacher's own token, through the write route that
 * already exists.
 */

/** The pad's logical size. The canvas is scaled by devicePixelRatio, so
 *  the exported PNG is crisp on an iPad's screen. */
const PAD_W = 800;
const PAD_H = 300;
/** Room under the signature for the typed name line. */
const CAPTION_H = 56;

export default function WaiverScene(props: {
  requestId: string;
  payload: WaiverPayload;
  /** Told when this scene has finished with the screen, so the display
   *  can show its thank you while the server catches up. */
  onDone: (name: string | null) => void;
}) {
  const { requestId, payload, onDone } = props;
  const name = plainText(payload.clientFirstName ?? "");
  const text = plainText(payload.text);

  const [scrolled, setScrolled] = useState(false);
  const [inked, setInked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  /* A waiver that fits without scrolling has been fully shown the moment
   * it renders (the counter dialog's own carve-out). */
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 8) setScrolled(true);
  }, [text]);

  /** The pad, sized for this device's pixels and cleared. */
  const prepare = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const wanted = Math.round(PAD_W * ratio);
    if (canvas.width !== wanted) {
      canvas.width = wanted;
      canvas.height = Math.round(PAD_H * ratio);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    /* The ink is the theme's own text colour, read off the element, so
     * the pad has no hex of its own in either palette. */
    ctx.strokeStyle =
      getComputedStyle(canvas).getPropertyValue("color").trim() || "#000";
    return ctx;
  }, []);

  useEffect(() => {
    const ctx = prepare();
    if (ctx) ctx.clearRect(0, 0, PAD_W, PAD_H);
  }, [prepare]);

  const at = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * PAD_W,
      y: ((e.clientY - box.top) / box.height) * PAD_H,
    };
  }, []);

  const start = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const ctx = prepare();
      if (!ctx) return;
      drawing.current = true;
      last.current = at(e);
      /* A tap with no drag is still ink: a dot. */
      ctx.beginPath();
      ctx.arc(last.current.x, last.current.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      setInked(true);
      canvasRef.current?.setPointerCapture(e.pointerId);
    },
    [at, prepare],
  );

  const move = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawing.current) return;
      e.preventDefault();
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !last.current) return;
      const point = at(e);
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      last.current = point;
    },
    [at],
  );

  const end = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = false;
    last.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* Already released; nothing to undo. */
    }
  }, []);

  const clear = useCallback(() => {
    const ctx = prepare();
    if (ctx) ctx.clearRect(0, 0, PAD_W, PAD_H);
    setInked(false);
  }, [prepare]);

  /**
   * The artifact: the signature on a transparent background with a typed
   * line beneath it naming who signed and the date, drawn into the SAME
   * image so the file is self-describing wherever it ends up.
   */
  const exportPng = useCallback((): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const out = document.createElement("canvas");
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    out.width = Math.round(PAD_W * ratio);
    out.height = Math.round((PAD_H + CAPTION_H) * ratio);
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.drawImage(canvas, 0, 0, PAD_W, PAD_H);
    const ink =
      getComputedStyle(canvas).getPropertyValue("color").trim() || "#000";
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(24, PAD_H + 6);
    ctx.lineTo(PAD_W - 24, PAD_H + 6);
    ctx.stroke();
    ctx.font = "20px sans-serif";
    const when = new Date().toLocaleString();
    ctx.fillText(`${name || "Signed"}  ${when}`, 24, PAD_H + 34);
    return out.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  }, [name]);

  const agree = useCallback(async () => {
    if (saving || !scrolled || !inked) return;
    const png = exportPng();
    if (png === null) {
      setError("The signature could not be saved. Please try again.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/display/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          result: { signaturePng: png, agreedAt: new Date().toISOString() },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      onDone(name || null);
    } catch (err) {
      setError(
        `That did not save (${err instanceof Error ? err.message : String(err)}). Please try again, or ask the front desk.`,
      );
      setSaving(false);
    }
  }, [saving, scrolled, inked, exportPng, requestId, onDone, name]);

  const notNow = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await fetch("/api/display/refuse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          reason: "Customer tapped Not now",
        }),
      });
    } catch {
      /* The teacher's screen has the dialog either way. */
    }
    setSaving(false);
  }, [saving, requestId]);

  return (
    <section className="dwaiver" aria-label="Liability waiver">
      <h1 className="dwaiver-heading">
        {name ? `Hello, ${name}` : "Welcome"}
      </h1>
      <p className="dwaiver-lead">
        Please read the studio&apos;s liability waiver, then sign below.
      </p>
      <div
        className="dwaiver-text"
        ref={scrollRef}
        tabIndex={0}
        aria-label="The liability waiver"
        onScroll={(e) => {
          const el = e.currentTarget;
          /* Once read, always read: scrolling back up does not un-read
           * the text. Same tolerance as the counter dialog. */
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
            setScrolled(true);
          }
        }}
      >
        {text}
      </div>
      {!scrolled ? (
        <p className="dwaiver-note">Scroll to the end of the waiver to sign.</p>
      ) : null}

      <div className="dwaiver-pad-wrap">
        <canvas
          className="dwaiver-pad"
          ref={canvasRef}
          aria-label="Sign here"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={end}
        />
        <p className="dwaiver-pad-label">
          {inked ? "Thank you" : "Sign here with your finger"}
        </p>
      </div>

      {error ? <p className="dwaiver-error">{error}</p> : null}

      <div className="dwaiver-actions">
        <button className="dwaiver-button" onClick={notNow} disabled={saving}>
          Not now
        </button>
        <button className="dwaiver-button" onClick={clear} disabled={saving}>
          Clear
        </button>
        <button
          className="dwaiver-button dwaiver-agree"
          onClick={() => void agree()}
          disabled={!scrolled || !inked || saving}
        >
          I have read it and agree
        </button>
      </div>
    </section>
  );
}
