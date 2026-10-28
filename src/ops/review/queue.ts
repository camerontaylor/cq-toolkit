/** SDK-first queue ops. No vendor dispatch and no author admission mutation. */
import type { Op } from '../../kernel/types.js';
import { messageOf } from '../../shared/messageOf.js';
import { makeQueueClient, QueueUnsupported, sshQueueTransport } from './internal/queueClient.js';
import {
  QueueEnqueueInputSchema,
  QueueReferenceSchema,
  QueueReportInputSchema,
  type QueueEnqueueInput,
  type QueueReference,
  type QueueReportInput,
  type QueueStatus,
  type QueueTransport,
} from './internal/queueProtocol.js';
import type { QueueEvidence } from './internal/queueEvidence.js';
export {
  makeQueueClient,
  makeConfiguredQueueClient,
  sshQueueTransport,
  QueueUnsupported,
  QueueConfigurationError,
} from './internal/queueClient.js';
export { importQueueEvidence, readQueueEvidence } from './internal/queueEvidence.js';
export type { QueueEvidence } from './internal/queueEvidence.js';
export type {
  DeferredAuthorBinding,
  DeferredQueueClient,
  QueueBinding,
  QueueReference,
  QueueBindInput,
  QueueStatus,
  QueueTransport,
  QueueReason,
} from './internal/queueProtocol.js';

type Unsupported = { state: 'unsupported'; reason: string };
export function makeQueueOps(transport?: QueueTransport): {
  enqueue: Op<QueueEnqueueInput, QueueStatus | Unsupported>;
  queueStatus: Op<QueueReference, QueueStatus | Unsupported>;
  report: Op<
    QueueReportInput,
    { state: 'pending' | 'consumed'; evidence: QueueEvidence | null } | Unsupported
  >;
} {
  function wrap<I, P, O>(
    validate: (input: I) => P,
    fn: (client: ReturnType<typeof makeQueueClient>, input: P) => Promise<O>,
  ): Op<I, O | Unsupported> {
    return async (input) => {
      let parsed: P;
      // Only this pre-dispatch boundary can prove a deterministic caller error.
      // Response schemas also use Zod, so the transport catch must stay separate.
      try {
        parsed = validate(input);
      } catch (error) {
        return { status: 'failed', error: messageOf(error) };
      }
      const alias = process.env['CQ_QUEUE_SSH_ALIAS'];
      if (!transport && !alias)
        return {
          status: 'needs-human',
          reason:
            'Configure CQ_QUEUE_SSH_ALIAS for an activated queue-v1 capability; reviewed D1C deployment required.',
        };
      try {
        return {
          status: 'ok',
          value: await fn(makeQueueClient(transport ?? sshQueueTransport(alias!)), parsed),
        };
      } catch (error) {
        if (error instanceof QueueUnsupported)
          return { status: 'ok', value: { state: 'unsupported', reason: error.message } };
        return {
          status: 'indeterminate',
          detail:
            messageOf(error) +
            '; retain the same requestId and binding; no dispatch or review credit',
        };
      }
    };
  }
  return {
    enqueue: wrap(
      (input: QueueEnqueueInput) => {
        const i = QueueEnqueueInputSchema.parse(input);
        if (i.action === 'bind') {
          if (i.pr === undefined) throw new Error('bind requires pr');
        } else if (i.pr !== undefined || i.mergeSha !== undefined)
          throw new Error('PR attachment fields require action=bind');
        return i;
      },
      async (client, i) => {
        const ref = { requestId: i.requestId, binding: i.binding };
        if (i.action === 'bind')
          return client.bind({
            ...ref,
            pr: i.pr!,
            ...(i.mergeSha ? { mergeSha: i.mergeSha } : {}),
          });
        return i.action === 'cancel' ? client.cancel(ref) : client.enqueue(ref);
      },
    ),
    queueStatus: wrap(
      (input: QueueReference) => QueueReferenceSchema.parse(input),
      (client, input) => client.status(input),
    ),
    report: wrap(
      (input: QueueReportInput) => QueueReportInputSchema.parse(input),
      async (client, i) => {
        const evidence = await client.report(
          { requestId: i.requestId, binding: i.binding },
          i.evidenceDir,
        );
        return { state: evidence ? 'consumed' : 'pending', evidence };
      },
    ),
  };
}
