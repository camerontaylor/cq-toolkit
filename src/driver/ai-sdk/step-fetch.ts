// The default providers' HTTP transport, bounded by the driver's step bound.
//
// The SDK's `timeout.stepMs` bounds a whole step: the model call including
// its SDK retry and the step's tool runs. Node's bundled fetch also enforces undici's default
// `headersTimeout`/`bodyTimeout` of 300 s. A non-streaming request receives
// no response headers until the model has finished, so a reasoning model
// that legitimately spends > 5 min on one request died at the socket with
// `Headers Timeout Error`, whatever `stepTimeoutMs` said (S7 attempt F).
//
// The socket timeouts are set to the step bound PLUS a margin rather than 0
// (disabled). Each HTTP request's socket timeouts use the step bound plus
// 5 s by default, so they cannot fire before the step bound, even for the
// step's second (retry) request: the SDK's step timer spans the retry.
// The SDK's step abort fires first and stays the one classified
// cause ('transient', TimeoutError), while the socket timeouts remain a
// backstop for a request that somehow escapes the abort signal — but for
// stalls only. `headersTimeout` bounds time-to-headers, and `bodyTimeout` is
// an idle timeout that resets on every received chunk, so neither bounds
// total response time: a body that keeps delivering a chunk at least once
// per stepTimeoutMs + marginMs is never terminated here and can outlive the
// step bound indefinitely. Such escaped-abort, steady-drip responses are NOT
// covered by this backstop; ending them needs a total-body-time deadline.
//
// Use the process global dispatcher unless one is explicitly supplied. Node's
// startup proxy configuration and undici's setGlobalDispatcher both install
// their transport there. Per-request timeouts are applied at dispatch without
// replacing the configured dispatcher.
import { Dispatcher, fetch as undiciFetch, getGlobalDispatcher } from 'undici';

/** Socket-timeout slack over the step bound, so `timeout.stepMs` always fires first. */
export const STEP_FETCH_MARGIN_MS = 5_000;

/** A request-time wrapper that leaves ownership and lifecycle of the underlying transport alone. */
class TimedDispatcher extends Dispatcher {
  constructor(
    private readonly delegate: Dispatcher,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    return this.delegate.dispatch(
      { ...options, headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs },
      handler,
    );
  }
}

/** Apply per-request socket timeouts while preserving the supplied or process-global transport. */
export function createStepFetch(
  stepTimeoutMs: number,
  marginMs: number = STEP_FETCH_MARGIN_MS,
  transport?: Dispatcher,
): typeof globalThis.fetch {
  return async (input, init) => {
    const dispatcher = new TimedDispatcher(
      transport ?? getGlobalDispatcher(),
      stepTimeoutMs + marginMs,
    );
    type UndiciInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
    const base = { ...(init as unknown as UndiciInit), dispatcher };
    // undici's fetch does not recognise a runtime-native Request (a different
    // class) and would stringify it. Unpack it into url + init; explicit init
    // fields still win, as in the fetch contract.
    if (typeof Request !== 'undefined' && input instanceof Request) {
      // An explicitly-undefined init signal means "not supplied" in the fetch
      // contract; a plain spread of `base` would overwrite the unpacked
      // Request's signal with undefined, so it must be handled separately.
      const { signal: initSignal, ...baseRest } = base;
      // A native Request body is a one-shot stream, which undici cannot
      // re-send when following a 307/308 redirect. Recover the payload as a
      // replayable buffer before constructing the request; an explicit init
      // body still wins below, as in the fetch contract.
      const body =
        baseRest.body === undefined && input.body !== null
          ? await input.arrayBuffer()
          : undefined;
      return undiciFetch(input.url, {
        method: input.method,
        headers: input.headers as unknown as UndiciInit['headers'],
        signal: (initSignal ?? input.signal) as UndiciInit['signal'],
        ...(input.body !== null ? { duplex: 'half' as const } : {}),
        ...(body !== undefined ? { body } : {}),
        ...baseRest,
      } as UndiciInit) as unknown as Promise<Response>;
    }
    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      base,
    ) as unknown as Promise<Response>;
  };
}
