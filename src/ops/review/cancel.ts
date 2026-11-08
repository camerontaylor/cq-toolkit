import { ReferenceSchema } from './internal/reviewOperation.js';
import { reviewOp } from './internal/localReview.js';
import type { QueueTransport } from './internal/queueProtocol.js';
export const makeCancel = (transport?: QueueTransport) =>
  reviewOp(
    ReferenceSchema,
    async (i, getClient) => {
      const client = getClient();
      await client.capabilities();
      return client.request({ v: 1, op: 'cancel', request_id: i.requestId });
    },
    transport,
  );
