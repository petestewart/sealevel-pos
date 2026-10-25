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
  /**
   * T204: the sign-up's second step is this same screen, for a client
   * who does not exist yet, and its signature goes back inside a bigger
   * result (the form and the two consent answers beside it). So the
   * SCENE keeps the pad, the scroll rule and the export exactly as they
   * are and the caller says what to do with the PNG. Absent, this
   * completes the request itself, which is T202 unchanged.
   */
  onSubmit?: (signaturePng: string, agreedAt: string) => Promise<void>;
  /** T204: "Not now" on a sign-up goes back to the form rather than
   *  refusing the request outright. */
  onNotNow?: () => void | Promise<void>;
  /** T204: the sign-up greets by the name the student just typed. */
  heading?: string;
  notNowLabel?: string;
  /**
   * T205: the contract scene is this same screen with different words
   * above it. The pad, the scroll rule and the export do not move; only
   * the sentence under the heading, an optional block of server-worded
   * terms summary above the text, the label on the text itself and the
   * label on the agree button do. Anything that decides WHETHER the
   * agree button is live (scrolled, inked) stays here, in one place.
   */
  lead?: string;
  intro?: React.ReactNode;
  textLabel?: string;
  agreeLabel?: string;
  scrollNote?: string;
}) {
  const { requestId, payload, onDone } = props;
  const { onSubmit, onNotNow } = props;
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
      if (onSubmit) {
        /* T204: the caller owns the result. It throws for the same
         * reasons the POST below does, and is reported the same way. */
        await onSubmit(png, new Date().toISOString());
        onDone(name || null);
        return;
      }
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
  }, [saving, scrolled, inked, exportPng, requestId, onDone, name, onSubmit]);

  const notNow = useCallback(async () => {
    if (saving) return;
    if (onNotNow) {
      await onNotNow();
      return;
    }
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
  }, [saving, requestId, onNotNow]);

  return (
    <section className="dwaiver" aria-label="Liability waiver">
      <h1 className="dwaiver-heading">
        {props.heading ?? (name ? `Hello, ${name}` : "Welcome")}
      </h1>
      <p className="dwaiver-lead">
        {props.lead ??
          "Please read the studio's liability waiver, then sign below."}
      </p>
      {props.intro ?? null}
      <div
        className="dwaiver-text"
        ref={scrollRef}
        tabIndex={0}
        aria-label={props.textLabel ?? "The liability waiver"}
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
        <p className="dwaiver-note">
          {props.scrollNote ?? "Scroll to the end of the waiver to sign."}
        </p>
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
          {props.notNowLabel ?? "Not now"}
        </button>
        <button className="dwaiver-button" onClick={clear} disabled={saving}>
          Clear
        </button>
        <button
          className="dwaiver-button dwaiver-agree"
          onClick={() => void agree()}
          disabled={!scrolled || !inked || saving}
        >
          {props.agreeLabel ?? "I have read it and agree"}
        </button>
      </div>
    </section>
  );
}
