// Process-lifecycle helpers for the claude-agent driver — T1.6.
//
// THE I8 EXEMPT FILE (same posture as the subprocess lane's process.ts):
// the driver-hygiene scan bans driver-owned scheduling primitives and
// cancellation ROOTS under src/driver/**, with the single exemption
// `driver/<name>/process.{ts,js,mjs}` — process-lifecycle helpers may own
// the machinery, because there the decision has ALREADY BEEN MADE. This
// file owns exactly one such machine: the construction of the SDK query's
// cancellation root (`Options.abortController` — "Controller for cancelling
// the query. When aborted, the query will stop and clean up resources",
// claude-agent-sdk@0.3.270). The driver (index.ts) decides NOTHING about
// WHEN to abort: it forwards the governed signal it received via
// `currentJobContext()` and this helper only WIRES that signal into the
// root the SDK watches. No timer, no deadline, no retry lives here — a
// signal that never fires produces a query that never aborts, which is the
// point: outside a governed run there is no cancellation source and the
// run is simply un-abortable by us.
//
// SLICE 3 NOTE (the spike's question, recorded where the mechanism lives):
// whether an aborted query actually STOPS spend at the endpoint (tokens
// already in flight) is unmeasured; the I8 seam guarantees the run settles
// honestly ('aborted'), not that the provider stops billing mid-stream.

/** One wired cancellation root plus the teardown for its signal listener. */
export interface AbortRoot {
  /** The root the SDK query watches (`Options.abortController`). */
  readonly controller: AbortController;
  /** Detach the governed-signal listener (call when the query settles). */
  dispose(): void;
}

/**
 * Wire a governed signal into a fresh SDK cancellation root.
 *
 *   - `signal === undefined` (an un-governed run) → `undefined`: the query
 *     runs with no cancellation source at all.
 *   - an already-fired signal → an already-aborted root (the query's own
 *     abort handling settles it immediately).
 *   - otherwise the root aborts exactly when the governed signal fires
 *     (rung 1, the governor's decision), once, and `dispose()` detaches.
 */
export function abortRootFollowing(signal: AbortSignal | undefined): AbortRoot | undefined {
  if (signal === undefined) {
    return undefined;
  }
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  if (signal.aborted) {
    onAbort();
    return { controller, dispose: (): void => undefined };
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    controller,
    dispose: (): void => {
      signal.removeEventListener('abort', onAbort);
    },
  };
}
