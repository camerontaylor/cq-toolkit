import { describe, expect, test } from 'vitest';
import { makeRecord } from '../../../src/ops/review/record.js';
import type { QueueTransport } from '../../../src/ops/review/internal/queueProtocol.js';

/** Fake queue transport: JSON string in, JSON string out, capabilities stubbed. */
const fakeTransport = (
  respond: (wire: unknown) => unknown,
  caps: Partial<{ operations: string[]; features: string[] }> = {},
): { transport: QueueTransport; requests: unknown[] } => {
  const requests: unknown[] = [];
  const transport: QueueTransport = async (request: string) => {
    const wire = JSON.parse(request) as { op?: string };
    requests.push(wire);
    if (wire.op === 'capabilities')
      return JSON.stringify({
        v: 1,
        command: 'review-v1',
        operations: caps.operations ?? [
          'capabilities',
          'submit',
          'status',
          'result',
          'cancel',
          'record',
        ],
        features: caps.features ?? ['chunked-result-v1', 'review-record-v1'],
        limits: {
          max_request_bytes: 6291456,
          max_snapshot_bytes: 5242880,
          max_content_bytes: 3145728,
          max_objects: 4096,
          chunk_bytes: 3072,
        },
      });
    return JSON.stringify(respond(wire));
  };
  return { transport, requests };
};

const goodInput = {
  producer: 'agent' as const,
  sourceId: 'helper-run-7',
  report: 'agent says it looks fine',
  reviewer: 'helper-agent',
  authenticatedSubmitter: 'queue-client',
  forgeEvidence: 'off-forge-import' as const,
};

describe('review.record', () => {
  test('maps camelCase input to the record wire operation', async () => {
    const { transport, requests } = fakeTransport(() => ({
      v: 1,
      op: 'record',
      action: 'recorded',
      record_digest: 'a'.repeat(64),
      duplicate_of: null,
      supersedes: null,
    }));
    const record = makeRecord(transport);
    const result = await record({
      ...goodInput,
      claimedScope: [{ path: 'src/x.ts', blob: 'b'.repeat(64), intervals: [[1, 2]] }],
      independence: 'agent lane',
      supersedes: 'c'.repeat(64),
      verdict: 'APPROVED',
    });
    expect(result).toEqual({
      status: 'ok',
      value: {
        v: 1,
        op: 'record',
        action: 'recorded',
        record_digest: 'a'.repeat(64),
        duplicate_of: null,
        supersedes: null,
      },
    });
    const wire = requests[1] as Record<string, unknown>;
    expect(wire.op).toBe('record');
    expect(wire.producer).toBe('agent');
    expect(wire.source_id).toBe('helper-run-7');
    expect(wire.claimed_scope).toEqual([
      { path: 'src/x.ts', blob: 'b'.repeat(64), intervals: [[1, 2]] },
    ]);
    expect(wire.independence).toBe('agent lane');
    expect(wire.supersedes).toBe('c'.repeat(64));
    expect(wire.authenticated_submitter).toBe('queue-client');
    expect(wire.report).toEqual({
      encoding: 'utf8',
      data: 'agent says it looks fine',
    });
  });

  test('parses a quarantined response with its reason', async () => {
    const { transport } = fakeTransport(() => ({
      v: 1,
      op: 'record',
      action: 'quarantined',
      record_digest: null,
      duplicate_of: null,
      supersedes: null,
      reason: 'report missing',
    }));
    const result = await makeRecord(transport)(goodInput);
    expect(result).toEqual({
      status: 'ok',
      value: {
        v: 1,
        op: 'record',
        action: 'quarantined',
        record_digest: null,
        duplicate_of: null,
        supersedes: null,
        reason: 'report missing',
      },
    });
  });

  test('reflects the duplicate disposition', async () => {
    const { transport } = fakeTransport(() => ({
      v: 1,
      op: 'record',
      action: 'duplicate',
      record_digest: null,
      duplicate_of: 'd'.repeat(64),
      supersedes: null,
    }));
    const result = await makeRecord(transport)(goodInput);
    expect(result).toEqual({
      status: 'ok',
      value: {
        v: 1,
        op: 'record',
        action: 'duplicate',
        record_digest: null,
        duplicate_of: 'd'.repeat(64),
        supersedes: null,
      },
    });
  });

  test('reports unsupported when the queue lacks the capability', async () => {
    const { transport } = fakeTransport(() => ({}), { operations: [], features: [] });
    const result = await makeRecord(transport)(goodInput);
    // The base review-v1 handshake fails first: without chunked-result-v1 the
    // capabilities probe itself is unsupported, before the record check runs.
    expect(result).toEqual({
      status: 'ok',
      value: { state: 'unsupported', reason: 'review-v1 capability unavailable' },
    });
  });

  test('reports unsupported when the record capability is missing', async () => {
    // Full base handshake present, but the queue does not offer record.
    const { transport } = fakeTransport(() => ({}), {
      operations: ['capabilities', 'submit', 'status', 'result', 'cancel'],
      features: ['chunked-result-v1'],
    });
    const result = await makeRecord(transport)(goodInput);
    expect(result).toEqual({
      status: 'ok',
      value: { state: 'unsupported', reason: 'review-record capability unavailable' },
    });
  });

  test('fails input missing the report body without contacting the queue', async () => {
    const { transport, requests } = fakeTransport(() => ({}));
    const record = makeRecord(transport);
    const result = await record({
      ...goodInput,
      report: undefined,
    } as unknown as Parameters<typeof record>[0]);
    expect(result).toMatchObject({ status: 'failed' });
    // The op rejects before any wire traffic: only the capabilities probe
    // would appear if validation had passed.
    expect(requests).toEqual([]);
  });

  test('constructs without a transport for local registry wiring', () => {
    expect(() => makeRecord()).not.toThrow();
  });
});
