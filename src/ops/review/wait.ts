import { WaitInputSchema } from './internal/reviewOperation.js';
import { reviewOp, type ReviewClient } from './internal/localReview.js';
import type { QueueTransport } from './internal/queueProtocol.js';
export async function observeReview(client: ReviewClient, requestId: string, waitMs: number) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await client
      .request(
        { v: 1, op: 'status', request_id: requestId },
        { remainingMs: () => Math.max(1, deadline - Date.now()) },
      )
      .catch((error: unknown) => {
        if (
          Date.now() >= deadline &&
          error instanceof Error &&
          /timeout|deadline/.test(error.message)
        )
          return {
            v: 1 as const,
            action: 'observed' as const,
            request_id: requestId,
            waitOutcome: 'deadline' as const,
            reason: 'status-unavailable-at-deadline',
          };
        throw error;
      });
    if ('waitOutcome' in result) return result;
    if (!('state' in result)) throw new Error('expected review status');
    if (!['queued', 'running'].includes(result.state))
      return { ...result, waitOutcome: 'terminal' as const };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...result, waitOutcome: 'deadline' as const };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(remaining, 15000 * (0.8 + Math.random() * 0.4))),
    );
    if (Date.now() >= deadline) return { ...result, waitOutcome: 'deadline' as const };
  }
}
export const makeWait = (transport?: QueueTransport) =>
  reviewOp(
    WaitInputSchema,
    async (i, getClient) => {
      const client = getClient();
      await client.capabilities();
      return observeReview(client, i.requestId, i.waitMs);
    },
    transport,
  );
