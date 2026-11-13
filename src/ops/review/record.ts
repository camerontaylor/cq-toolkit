import { z } from 'zod';
import { RecordInputSchema, RecordResponseSchema } from './internal/reviewOperation.js';
import { QueueUnsupported } from './internal/queueClient.js';
import { reviewOp } from './internal/localReview.js';
import type { QueueTransport } from './internal/queueProtocol.js';

/**
 * review.record: import an external review as ledger evidence. The import is
 * idempotent on `(producer, source id, artifact digest)`; corrections name the
 * record they supersede; malformed imports come back quarantined with a
 * readable reason while scheduling continues. Importing never dispatches work,
 * reserves vendor capacity, grants CodeRabbit completion, or issues an
 * independent-acceptance verdict.
 */
export const makeRecord = (transport?: QueueTransport) =>
  reviewOp(
    RecordInputSchema,
    async (i, getClient) => {
      const client = getClient();
      const capabilities = await client.capabilities();
      if (
        !capabilities.operations.includes('record') ||
        !capabilities.features.includes('review-record-v1')
      )
        throw new QueueUnsupported('review-record capability unavailable');
      const wire = {
        v: 1 as const,
        op: 'record' as const,
        producer: i.producer,
        source_id: i.sourceId,
        ...(i.repo === undefined ? {} : { repo: i.repo }),
        ...(i.head === undefined ? {} : { head_commit: i.head }),
        ...(i.base === undefined ? {} : { base_commit: i.base }),
        ...(i.headTree === undefined ? {} : { head_tree: i.headTree }),
        ...(i.target === undefined ? {} : { target: i.target }),
        ...(i.reviewer === undefined ? {} : { reviewer: i.reviewer }),
        ...(i.authenticatedSubmitter === undefined
          ? {}
          : { authenticated_submitter: i.authenticatedSubmitter }),
        ...(i.verdict === undefined ? {} : { verdict: i.verdict }),
        ...(i.claimedScope === undefined ? {} : { claimed_scope: i.claimedScope }),
        ...(i.independence === undefined ? {} : { independence: i.independence }),
        ...(i.supersedes === undefined ? {} : { supersedes: i.supersedes }),
        ...(i.forgeEvidence === undefined ? {} : { forge_evidence: i.forgeEvidence }),
        report: { encoding: 'utf8' as const, data: i.report },
      };
      // An operator-disabled runner answers the generic unsupported envelope
      // (action observed, state unsupported) instead of a record result;
      // preserve that disposition rather than letting the record parse turn
      // it into an indeterminate failure, so callers can distinguish an
      // operator-disabled import from an unknown-delivery fault.
      const raw = await client.request(wire);
      const unsupported = z
        .object({
          v: z.literal(1),
          action: z.literal('observed'),
          state: z.literal('unsupported'),
          reason: z.string().min(1),
        })
        .loose()
        .safeParse(raw);
      if (unsupported.success)
        return { state: unsupported.data.state, reason: unsupported.data.reason };
      return RecordResponseSchema.parse(raw);
    },
    transport,
  );
