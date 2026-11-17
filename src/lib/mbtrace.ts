import { AsyncLocalStorage } from "node:async_hooks";

/**
 * T241 review: whether a piece of work ASKED Mindbody to write anything.
 *
 * /api/checkout spends a card the student typed on the customer display
 * once the checkout has answered, except for a refusal that provably
 * never reached Mindbody: our own validation turning the request away
 * before a single write was attempted. That is what this counts: every
 * non-GET call that enters mindbody() inside `traceMindbody`, sent,
 * suppressed by dry run or the write guard, or refused, all alike. A
 * read cannot move money, so reads are not counted; a suppressed write
 * IS counted, which errs toward spending the card, the safe direction.
 */
interface Trace {
  writes: number;
}

const store = new AsyncLocalStorage<Trace>();

export async function traceMindbody<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; writes: number }> {
  const trace: Trace = { writes: 0 };
  const value = await store.run(trace, fn);
  return { value, writes: trace.writes };
}

/** Called by mindbody() for every non-GET call. A no-op outside a trace. */
export function noteMindbodyWrite(): void {
  const trace = store.getStore();
  if (trace !== undefined) trace.writes += 1;
}
