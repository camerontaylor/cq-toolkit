import { WaitInputSchema } from './internal/reviewOperation.js';
import { reviewOp, type ReviewClient } from './internal/localReview.js';
import type { QueueTransport } from './internal/queueProtocol.js';
type Observation = Extract<Awaited<ReturnType<ReviewClient['request']>>, { state: unknown }>;
const expiredRead = (error: unknown, deadline: number) =>
  Date.now() >= deadline && error instanceof Error && /timeout|deadline/.test(error.message);
const deadlineResult = (requestId: string, lastKnown?: Observation) => ({
  v: 1 as const,
  action: 'observed' as const,
  request_id: requestId,
  ...lastKnown,
  waitOutcome: 'deadline' as const,
});
export async function observeReview(
  client: ReviewClient,
  requestId: string,
  waitMs: number,
  deadline = Date.now() + waitMs,
  initial?: Observation,
) {
  let lastKnown = initial;
  for (;;) {
    let result: Awaited<ReturnType<ReviewClient['request']>>;
    try {
      result = await client.request(
        { v: 1, op: 'status', request_id: requestId },
        { remainingMs: () => Math.max(1, deadline - Date.now()) },
      );
    } catch (error) {
      if (expiredRead(error, deadline))
        return {
          ...deadlineResult(requestId, lastKnown),
          reason: 'status-unavailable-at-deadline',
        };
      throw error;
    }
    if (!('state' in result)) throw new Error('expected review status');
    lastKnown = result;
    if (!['queued', 'running'].includes(result.state))
      return { ...result, waitOutcome: 'terminal' as const };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return deadlineResult(requestId, lastKnown);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(remaining, 15000 * (0.8 + Math.random() * 0.4))),
    );
    if (Date.now() >= deadline) return deadlineResult(requestId, lastKnown);
  }
}
export const makeWait = (transport?: QueueTransport) =>
  reviewOp(
    WaitInputSchema,
    async (i, getClient) => {
      const deadline = Date.now() + i.waitMs;
      const client = getClient();
      try {
        await client.capabilities({ remainingMs: () => Math.max(1, deadline - Date.now()) });
      } catch (error) {
        if (expiredRead(error, deadline))
          return { ...deadlineResult(i.requestId), reason: 'capabilities-unavailable-at-deadline' };
        throw error;
      }
      if (Date.now() > deadline) return deadlineResult(i.requestId);
      return observeReview(client, i.requestId, i.waitMs, deadline);
    },
    transport,
  );
