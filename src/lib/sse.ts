/**
 * The Server-Sent Events shape both display streams use (T200).
 *
 * Deliberately small and dependency-free: a ReadableStream, an `id:` on
 * every event so a reconnecting EventSource can say `Last-Event-ID`, and
 * a comment heartbeat, which is what keeps Railway's proxy and Safari
 * from closing a stream that is simply quiet. The headers are the ones
 * that matter in front of a proxy: no caching, keep-alive, and
 * `X-Accel-Buffering: no` so nothing sits on a half-full buffer.
 *
 * Every subscriber is cleaned up on `request.signal`'s abort, including
 * the heartbeat timer: a counter iPad that reloads all day must not leave
 * a timer per reload behind it.
 */

export interface SseWriter {
  /** One named event with a monotonic id. */
  send(id: number, event: string, data: unknown): void;
  /** A comment line. Invisible to EventSource, and enough to keep the
   *  connection alive. */
  comment(text: string): void;
}

export function sseResponse(
  request: Request,
  opts: {
    /** Milliseconds between heartbeats. */
    heartbeatMs: number;
    /** Runs once on connect. Returns the teardown. */
    start: (writer: SseWriter) => () => void;
    /** Runs on every heartbeat, before the comment goes out. */
    beat?: () => void;
  },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          /* The client is gone; abort will tidy up. */
          closed = true;
        }
      };
      const writer: SseWriter = {
        send(id, event, data) {
          write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        comment(text) {
          write(`: ${text}\n\n`);
        },
      };
      /* A reconnect waits three seconds rather than EventSource's
       * default, so a server restart mid-shift is not a stampede. */
      write("retry: 3000\n\n");
      const teardown = opts.start(writer);
      const timer = setInterval(() => {
        opts.beat?.();
        writer.comment(`ping ${Date.now()}`);
      }, opts.heartbeatMs);
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          teardown();
        } catch {
          /* Nothing here may throw into the stream. */
        }
        try {
          controller.close();
        } catch {
          /* Already closed. */
        }
      };
      request.signal.addEventListener("abort", stop);
      if (request.signal.aborted) stop();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** The `Last-Event-ID` a reconnecting EventSource sends, as a number.
 *  Zero for absent or malformed, which replays the whole buffer. */
export function lastEventId(request: Request): number {
  const raw =
    request.headers.get("last-event-id") ??
    new URL(request.url).searchParams.get("lastEventId") ??
    "";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
