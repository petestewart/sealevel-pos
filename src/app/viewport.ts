/**
 * T98: every modal sits above the iPad's keyboard.
 *
 * Pete, on the counter iPad: "the standard iOS keyboard pops up in front
 * of the custom modals like credit card entry. it goes away after the
 * credit card is entered, but it covers up our modal." Asked which way to
 * fix it: "yes, all modals need to be above the keyboard."
 *
 * The cause is not focus handling and not a keyboard left over from some
 * other field (an earlier diagnosis in this repo said that, and it was
 * wrong). A teacher taps the card number, the keyboard opens because it
 * should, and it covers the box because the box never makes room: iOS
 * shrinks the VISUAL viewport and leaves the LAYOUT viewport alone, and
 * our modals are centred in a `position: fixed` full-height scrim, which
 * is laid out against the layout viewport. The box does not move, so the
 * keyboard slides over its lower half, which is where the later fields and
 * the primary control live.
 *
 * `window.visualViewport` is the API that exposes the visible band, and
 * this is the one place that reads it. It publishes the band to three
 * custom properties on <html>: `--vvh` (its height), `--vv-top` (its
 * offset) and `--vv-bot` (what is covered BELOW it), and the CSS centres
 * and sizes every modal inside those instead of the whole viewport.
 * Mounted ONCE, at the page root; never per modal.
 *
 * T98 review: `--vv-bot` exists because the scrim must keep covering the
 * WHOLE layout viewport while only the box moves into the band. The band
 * is not always the keyboard: an iPad also has a floating keyboard, a
 * split keyboard and a hardware keyboard whose accessory bar is short, so
 * the uncovered area under a band-sized scrim can be live page, tappable
 * behind a dialog that is supposed to be modal. The scrim takes the two
 * offsets as padding instead, which leaves the box centred in exactly the
 * same content box it had before.
 *
 * Two rules the implementation turns on:
 *
 * - The fallback is the CSS's, not a branch here. `globals.css` declares
 *   `--vvh: 100dvh`, `--vv-top: 0px` and `--vv-bot: 0px` on :root, and this
 *   hook only ever NARROWS them, and only while something keyboard-sized is up. No
 *   `visualViewport` (an older WebKit, a headless harness) means the
 *   properties are never touched and the screen renders exactly as it did
 *   before this ticket.
 * - A modal has one size with the keyboard down and one with it up, each
 *   fixed (T68, Pete: "all popups must be statically sized", "fix it so
 *   it's stationary size"). So the band is published when it SETTLES, not
 *   on every frame of the keyboard's animation: one publish per state,
 *   rather than a box resizing continuously under a finger.
 */

import { useEffect } from "react";

const H = "--vvh";
const T = "--vv-top";
const B = "--vv-bot";

/**
 * A band shorter than the layout viewport by less than this is browser
 * chrome (Safari's toolbars, the Add to Home Screen shell), not a
 * keyboard. An iPad's keyboard takes 300px and up.
 */
const KEYBOARD_MIN = 120;

/** Quiet time before a settled band is published. The keyboard's slide is
 *  about 250ms of resize events; this waits for the end of it. */
const SETTLE_MS = 120;

/** Is this element one that can hold a caret, i.e. raise the keyboard? */
function isField(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

/**
 * The nearest scrolling ancestor of `el` inside `boundary`, or null when
 * the modal has none. Bounded deliberately: the page must never scroll
 * for a focused field (the shell is the viewport's height and the roster
 * is its own scroller), only the modal's own region.
 */
function scrollerWithin(el: HTMLElement, boundary: Element): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== boundary) {
    const style = getComputedStyle(node);
    const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
    if (scrolls && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * T98 rule 4: the focused field scrolls into view INSIDE the modal's own
 * scroll region, so tabbing or "next" down the card fields never leaves
 * the field being typed into behind the keyboard's top edge. This is
 * `scrollIntoView({ block: "nearest" })` done by hand, because the real
 * thing walks every scrollable ancestor up to the document and this must
 * move one element and nothing else.
 */
export function scrollFieldIntoView(el: Element | null): void {
  if (!isField(el)) return;
  const scrim = el.closest(".modal-scrim");
  if (!scrim) return;
  const scroller = scrollerWithin(el, scrim);
  if (!scroller) return;
  const box = el.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  let delta = 0;
  if (box.bottom > view.bottom) delta = box.bottom - view.bottom;
  else if (box.top < view.top) delta = box.top - view.top;
  if (delta !== 0) scroller.scrollTop += delta;
}

/**
 * Publishes the visible band to `--vvh` / `--vv-top`, and keeps the
 * focused field inside the modal's scroll region. Mount once, at the root.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    /* No API, no change: the CSS fallback is the behaviour of record. */
    if (!vv) return;

    const root = document.documentElement;
    let raf = 0;
    let timer = 0;

    const publish = () => {
      raf = 0;
      const band = Math.round(vv.height);
      const top = Math.round(vv.offsetTop);
      if (window.innerHeight - band >= KEYBOARD_MIN) {
        root.style.setProperty(H, `${band}px`);
        root.style.setProperty(T, `${top}px`);
        /* What the band leaves covered at the BOTTOM. The scrim pads
         * itself by this rather than ending here, so the covered strip
         * still belongs to the scrim (T98 review). */
        root.style.setProperty(
          B,
          `${Math.max(0, window.innerHeight - top - band)}px`,
        );
      } else {
        /* Back to the CSS's own value rather than a second opinion on
         * what the full height is. */
        root.style.removeProperty(H);
        root.style.removeProperty(T);
        root.style.removeProperty(B);
      }
      /* The band just changed shape, so the field being typed into may
       * now be under the keyboard's edge. */
      scrollFieldIntoView(document.activeElement);
    };

    /* One publish per settled state (see the header): the box has one
     * size with the keyboard down and one with it up, and does not
     * resize through the animation between them. */
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (raf === 0) raf = window.requestAnimationFrame(publish);
      }, SETTLE_MS);
    };

    const onFocus = (e: FocusEvent) => scrollFieldIntoView(e.target as Element);

    publish();
    vv.addEventListener("resize", settle);
    vv.addEventListener("scroll", settle);
    document.addEventListener("focusin", onFocus);
    return () => {
      vv.removeEventListener("resize", settle);
      vv.removeEventListener("scroll", settle);
      document.removeEventListener("focusin", onFocus);
      window.clearTimeout(timer);
      if (raf !== 0) window.cancelAnimationFrame(raf);
      root.style.removeProperty(H);
      root.style.removeProperty(T);
      root.style.removeProperty(B);
    };
  }, []);
}
