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
      {
        ...options,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      },
      handler,
    );
  }
}

/**
 * Buffer a native Request body, honoring `signal` while the stream is open:
 * on abort the reader is cancelled and the wait rejects with the signal's
 * reason, so an open body stream cannot pin the call past a caller abort.
 */
async function bufferBody(request: Request, signal: AbortSignal | null): Promise<Buffer> {
  signal?.throwIfAborted();
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks);
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
    // A native `Request` is not undici's own class, so undici's RequestInfo
    // converter would stringify it ("[object Request]"). Unpack it into a URL
    // plus init; an explicit `init` still wins, as it does for native fetch.
    const target: string | URL =
      typeof Request !== 'undefined' && input instanceof Request
        ? input.url
        : (input as string | URL);
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const initOpts = init as { signal?: AbortSignal | null; body?: unknown } | undefined;
    // `signal: null` means "no signal" in fetch; only `undefined` falls back to the request's.
    const bufferSignal =
      initOpts?.signal !== undefined ? initOpts.signal : isRequest ? input.signal : null;
    // Native fetch prefers `init.body`, so the request body is never read then.
    const needsBodyBuffer = isRequest && input.body !== null && initOpts?.body == null;
    const fromRequest = isRequest
      ? {
          method: input.method,
          headers: input.headers,
          signal: input.signal,
          redirect: input.redirect,
          ...(needsBodyBuffer ? { body: await bufferBody(input, bufferSignal) } : {}),
        }
      : {};
    return undiciFetch(target, {
      ...fromRequest,
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  };
}
