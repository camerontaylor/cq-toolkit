/** SDK-first queue ops. No vendor dispatch and no author admission mutation. */
import { ZodError } from 'zod';
import type { Op } from '../../kernel/types.js';
import { messageOf } from '../../shared/messageOf.js';
import {
  makeQueueClient,
  QueueReadFault,
  QueueUnsupported,
  sshQueueTransport,
} from './internal/queueClient.js';
import {
  QueueHealthReferenceSchema,
  type QueueHealthReference,
  QueueEnqueueInputSchema,
  QueueRetryInputSchema,
  QueueDrainInputSchema,
  type QueueRetryInput,
  type QueueDrainInput,
  QueueReferenceSchema,
  QueueReportInputSchema,
  type QueueEnqueueInput,
  type QueueReference,
  type QueueReportInput,
  type QueueStatus,
  type QueueHealthResult,
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
  QueueHealthReference,
  QueueHealth,
  QueueHealthResult,
  QueueReference,
  QueueBindInput,
  QueueStatus,
  QueueTransport,
  QueueReason,
} from './internal/queueProtocol.js';

type Unsupported = { state: 'unsupported'; reason: string };
export function makeQueueOps(transport?: QueueTransport): {
  retry: Op<QueueRetryInput, unknown>;
  drain: Op<QueueDrainInput, unknown>;
  enqueue: Op<QueueEnqueueInput, QueueStatus | Unsupported>;
  queueStatus: Op<QueueReference, QueueStatus | Unsupported>;
  queueHealth: Op<QueueHealthReference, QueueHealthResult | Unsupported>;
  report: Op<
    QueueReportInput,
    { state: 'pending' | 'consumed'; evidence: QueueEvidence | null } | Unsupported
  >;
} {
  type EnqueueCommand =
    | { kind: 'enqueue' | 'cancel'; ref: QueueReference }
    | { kind: 'bind'; ref: QueueReference; pr: number; mergeSha?: string };

  // Caller input and its action requirements are decidable before any
  // configuration or transport step; this is the only pre-dispatch proof of a
  // caller error. Bind requirements are encoded here so the dispatch stage
  // narrows on the command instead of re-checking (or asserting) fields.
  function enqueueCommand(input: QueueEnqueueInput): EnqueueCommand {
    const i = QueueEnqueueInputSchema.parse(input);
    const ref = { requestId: i.requestId, binding: i.binding };
    if (i.action === 'bind') {
      if (i.pr === undefined) throw new Error('bind requires pr');
      return { kind: 'bind', ref, pr: i.pr, ...(i.mergeSha ? { mergeSha: i.mergeSha } : {}) };
    }
    if (i.pr !== undefined || i.mergeSha !== undefined)
      throw new Error('PR attachment fields require action=bind');
    return { kind: i.action === 'cancel' ? 'cancel' : 'enqueue', ref };
  }

  function wrap<I, P, O>(
    validate: (input: I) => P,
    fn: (client: ReturnType<typeof makeQueueClient>, input: P) => Promise<O>,
    failInvalidResponse = false,
  ): Op<I, O | Unsupported> {
    return async (input) => {
      let parsed: P;
      // Response schemas also use Zod, so this stage stays separate from the
      // dispatch catch that owns delivery and malformed-response outcomes.
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
      let queueTransport: QueueTransport;
      try {
        // The only pre-dispatch local step: an alias that cannot form a
        // capability is a definite configuration failure, not an unknown outcome.
        // Construction does no I/O, so this catch can never see a remote error.
        queueTransport = transport ?? sshQueueTransport(alias!);
      } catch (error) {
        return { status: 'failed', error: messageOf(error) };
      }
      try {
        return {
          status: 'ok',
          value: await fn(makeQueueClient(queueTransport), parsed),
        };
      } catch (error) {
        if (failInvalidResponse && error instanceof ZodError)
          return { status: 'failed', error: messageOf(error) };
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
    retry: wrap(
      (input: QueueRetryInput) => QueueRetryInputSchema.parse(input),
      async (client, i) => {
        const ref = { requestId: i.requestId, binding: i.binding };
        if (!i.transient)
          return { action: 'observed', accepted: false, current: await client.status(ref) };
        return client.retry(ref, i.expectedReceiptId!);
      },
    ),
    drain: wrap(
      (input: QueueDrainInput) => QueueDrainInputSchema.parse(input),
      async (client, i) => {
        const deadline = Date.now() + i.waitMs;
        let pending = [...i.requests];
        while (pending.length && Date.now() < deadline) {
          const unfinished: QueueReference[] = [];
          for (const ref of pending) {
            if (Date.now() >= deadline) {
              unfinished.push(ref);
              continue;
            }
            try {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const current = await Promise.race([
                client.status(ref, { remainingMs: () => deadline - Date.now() }),
                new Promise<null>((resolve) => {
                  timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
                }),
              ]).finally(() => clearTimeout(timer));
              if (
                !current ||
                (!current.reviewed && !['cancelled', 'no-current-code'].includes(current.state))
              )
                unfinished.push(ref);
            } catch (error) {
              if (!(error instanceof QueueReadFault)) throw error;
              unfinished.push(ref);
            }
          }
          pending = unfinished;
          if (pending.length && Date.now() < deadline)
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, Math.min(i.pollMs, deadline - Date.now()))),
            );
        }
        return {
          action: 'observed',
          accepted: false,
          unfinished: pending.map((ref) => ref.requestId),
        };
      },
    ),
    enqueue: wrap(enqueueCommand, async (client, command) => {
      if (command.kind === 'bind')
        return client.bind({
          ...command.ref,
          pr: command.pr,
          ...(command.mergeSha ? { mergeSha: command.mergeSha } : {}),
        });
      return command.kind === 'cancel' ? client.cancel(command.ref) : client.enqueue(command.ref);
    }),
    queueHealth: wrap(
      (input: QueueHealthReference) => QueueHealthReferenceSchema.parse(input),
      (client, reference) => client.health(reference),
      true,
    ),
    queueStatus: wrap(
      (input: QueueReference) => QueueReferenceSchema.parse(input),
      (client, reference) => client.status(reference),
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
