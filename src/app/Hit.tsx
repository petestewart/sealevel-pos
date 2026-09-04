"use client";

/**
 * T71 (Pete: "if I type part of their email address in, the match
 * should be shown like it is in mindbody"): the searched text in bold
 * wherever it occurs in a result's name or contact line, the way
 * Mindbody's own search bolds "held8" inside stephanie.held8@gmail.com.
 * Mindbody's `searchText` already matches on email (client.yml:1403,
 * "Can include FirstName, LastName, and Email"); what was missing was
 * the row saying WHY it matched, since a hit on the email alone leaves
 * the name looking like a stranger. Case-insensitive, every occurrence,
 * the query's words matched separately so "steph held" bolds both; the
 * text is split on the plain string, never a regex built from input.
 */
export function Hit({ text, q }: { text: string; q: string }) {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (words.length === 0 || !text) return <>{text}</>;
  const lower = text.toLowerCase();
  /* Every match span, then merged so overlapping words bold once. */
  const spans: [number, number][] = [];
  for (const w of words) {
    let at = lower.indexOf(w);
    while (at >= 0) {
      spans.push([at, at + w.length]);
      at = lower.indexOf(w, at + 1);
    }
  }
  if (spans.length === 0) return <>{text}</>;
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  const out: React.ReactNode[] = [];
  let pos = 0;
  merged.forEach(([a, b], i) => {
    if (a > pos) out.push(text.slice(pos, a));
    out.push(
      <mark className="hit" key={i}>
        {text.slice(a, b)}
      </mark>,
    );
    pos = b;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}
