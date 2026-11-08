import { StatusInputSchema } from './internal/reviewOperation.js';
import { QueueUnsupported } from './internal/queueClient.js';
import { reviewOp } from './internal/localReview.js';
import type { QueueTransport } from './internal/queueProtocol.js';
export const makeStatus = (transport?: QueueTransport) =>
  reviewOp(
    StatusInputSchema,
    async (i, getClient) => {
      const client = getClient();
      const capabilities = await client.capabilities();
      if (i.notify !== undefined && !capabilities.operations.includes('notify-update'))
        throw new QueueUnsupported('notify-update capability unavailable');
      return client.request(
        i.notify === undefined
          ? { v: 1, op: 'status', request_id: i.requestId }
          : { v: 1, op: 'notify-update', request_id: i.requestId, notify: i.notify },
      );
    },
    transport,
  );
