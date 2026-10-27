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
import { Agent, fetch as undiciFetch } from 'undici';

/** Socket-timeout slack over the step bound, so `timeout.stepMs` always fires first. */
export const STEP_FETCH_MARGIN_MS = 5_000;

/**
 * A fetch for the ai-sdk providers whose undici dispatcher waits up to
 * `stepTimeoutMs + marginMs` for headers and between body chunks. The
 * dispatcher is created on first use, once per returned fetch (one per
 * driver instance). It is never explicitly closed: the Driver seam has no
 * dispose path, and an idle undici Agent holds only keep-alive sockets that
 * it closes itself after `keepAliveTimeout` (4 s default), so a dropped
 * driver leaves nothing open. Abort signals pass through unchanged.
 */
export function createStepFetch(
  stepTimeoutMs: number,
  marginMs: number = STEP_FETCH_MARGIN_MS,
): typeof globalThis.fetch {
  let dispatcher: Agent | undefined;
  return (input, init) => {
    dispatcher ??= new Agent({
      headersTimeout: stepTimeoutMs + marginMs,
      bodyTimeout: stepTimeoutMs + marginMs,
    });
    // undici's own fetch pairs with its own Agent (the bundled global fetch
    // is a different undici copy); its Request/Response types are the
    // WHATWG shapes the providers consume.
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>;
  };
}
