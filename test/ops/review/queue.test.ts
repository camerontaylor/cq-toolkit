import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  makeQueueClient,
  sshQueueTransport,
} from '../../../src/ops/review/internal/queueClient.js';
import * as queueClient from '../../../src/ops/review/internal/queueClient.js';
import { readQueueEvidence, sha256 } from '../../../src/ops/review/internal/queueEvidence.js';
import { FindingsRecordSchema } from '../../../src/ops/review/findings.js';
import { makeQueueOps } from '../../../src/ops/review/queue.js';
import { registry } from '../../../src/ops/review/registry.js';
import type {
  QueueEnqueueInput,
  QueueReference,
  QueueStatus,
  QueueTransport,
} from '../../../src/ops/review/internal/queueProtocol.js';
import {
  QueueBindingSchema,
  QueueBindSchema,
} from '../../../src/ops/review/internal/queueProtocol.js';

describe('queue pre-PR binding', () => {
  const binding = {
    kind: 'deferred-author',
    repo: 'owner/repo',
    producer: 'cycle-1',
    head: 'a'.repeat(40),
    target: 'merge-queue',
    targetSelector: 'promoted-main',
  };
  test('records debt before a PR or merge exists', () => {
    expect(QueueBindingSchema.parse(binding)).toEqual(binding);
    expect(QueueBindSchema.parse({ requestId: 'request-1', binding, pr: 12 })).toMatchObject({
      pr: 12,
    });
  });
  test('refuses authority fields, invalid repositories, selectors and mutable heads', () => {
    for (const patch of [
      { issuer: 'queue' },
      { repo: '../repo' },
      { targetSelector: 'HEAD' },
      { head: 'main' },
    ]) {
      expect(QueueBindingSchema.safeParse({ ...binding, ...patch }).success).toBe(false);
    }
  });
});

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'cq-queue-'));
  dirs.push(dir);
  return dir;
}
const ref: QueueReference = {
  requestId: 'request-1',
  binding: {
    kind: 'merged-current',
    repo: 'owner/repo',
    pr: 12,
    mergeSha: 'b'.repeat(40),
    targetSelector: 'promoted-main',
  },
};
const pendingStatus = {
  state: 'pending',
  pr: null,
  mergeSha: null,
  itemId: null,
  receiptId: null,
  consumed: false,
  reviewed: false,
  fixed: false,
};
function fixture(clean = false) {
  const paths = [
    {
      source_path: 'src/a.ts',
      path: 'src/a.ts',
      resolution: 'same-path-current',
      disposition: 'included',
    },
  ];
  // Sorted keys match Python canonical(paths); ASCII fixture here, Unicode covered below.
  const canonicalPaths = JSON.stringify([
    {
      disposition: 'included',
      path: 'src/a.ts',
      resolution: 'same-path-current',
      source_path: 'src/a.ts',
    },
  ]);
  const itemId =
    'current-' +
    sha256(
      Buffer.from(
        JSON.stringify({
          merge_sha: 'b'.repeat(40),
          policy: 'affected-current-additions-v1',
          pr: 12,
          repo: 'owner/repo',
          target_selector: 'promoted-main',
        }),
      ),
    ).slice(0, 32);
  const document = {
    version: 1,
    item_id: itemId,
    request_id: ref.requestId,
    source: {
      repo: 'owner/repo',
      pr: 12,
      merge_sha: 'b'.repeat(40),
      target_selector: 'promoted-main',
      policy: 'affected-current-additions-v1',
    },
    capture: {
      target: 'c'.repeat(40),
      tree: 'd'.repeat(40),
      paths,
      scope_digest: sha256(Buffer.from(canonicalPaths)),
      equivalence: 'e'.repeat(64),
      policy: 'affected-current-additions-v1',
      projection: 'current-affected-files/full-file-addition-projection',
      reviewer: 'coderabbit-review-agent-committed-v1',
      reviewer_version: 'fixture',
      captured_at: '2026-10-28T00:00:00Z',
    },
    classification: { outcome: 'completed', counted: true },
    outcome: clean ? 'terminal-clean' : 'terminal-with-findings',
    counted: true,
    findings: clean ? [] : [{ text: 'large finding '.repeat(3000) }],
    run_id: 'run-1',
    started_at: '2026-10-28T00:00:00Z',
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  };
  const bytes = Buffer.from(JSON.stringify(document));
  const receiptId = sha256(bytes);
  let ack = 0;
  let calls = 0;
  const status = {
    state: document.outcome,
    pr: 12,
    mergeSha: 'b'.repeat(40),
    itemId,
    receiptId,
    consumed: false,
    reviewed: true,
    fixed: false,
  };
  const common = {
    version: 1,
    receipt_id: receiptId,
    sha256: receiptId,
    bytes: bytes.length,
    chunks: Math.ceil(bytes.length / 3072),
    encoding: 'base64-utf8-json',
  };
  const transport: QueueTransport = async (wire) => {
    calls++;
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(8192);
    const req = JSON.parse(wire) as { op: string; cursor?: string | null };
    let result: unknown = status;
    if (req.op === 'report') {
      if (req.cursor === null)
        result = { page: { ...common, kind: 'manifest', cursor: receiptId + ':0' } };
      else {
        const index = Number(req.cursor?.split(':')[1]);
        const chunk = bytes.subarray(index * 3072, (index + 1) * 3072);
        result = {
          page: {
            ...common,
            kind: 'chunk',
            index,
            chunk_sha256: sha256(chunk),
            data: chunk.toString('base64'),
            next_cursor: index + 1 < common.chunks ? receiptId + ':' + (index + 1) : null,
          },
        };
      }
    }
    if (req.op === 'ack') {
      ack++;
      result = { ...status, consumed: true };
    }
    const raw =
      JSON.stringify({ v: 1, requestId: ref.requestId, binding: ref.binding, result }) + '\n';
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8192);
    return raw;
  };
  return {
    transport,
    document,
    receiptId,
    bytes,
    common,
    acknowledgements: () => ack,
    calls: () => calls,
  };
}

describe('complete immutable queue result consumption', () => {
  test('large individual finding, original request, restart and idempotent isolated import', async () => {
    const f = fixture();
    const dir = await directory();
    expect(f.bytes.length).toBeGreaterThan(8192);
    const evidence = await makeQueueClient(f.transport).report(ref, dir);
    expect(evidence?.document.capture.target).toBe('c'.repeat(40));
    expect(evidence?.document.capture.paths).toEqual(f.document.capture.paths);
    expect(evidence?.document.findings).toEqual(f.document.findings);
    expect(await makeQueueClient(f.transport).report(ref, dir)).toEqual(evidence);
    expect(await readdir(dir)).toEqual([f.receiptId + '.json']);
    expect(await readQueueEvidence(dir, f.receiptId)).toEqual(evidence);
    expect(f.acknowledgements()).toBe(2);
  });
  test('affected-current clean cannot become full-branch readiness or independent acceptance', async () => {
    const f = fixture(true);
    const evidence = await makeQueueClient(f.transport).report(ref, await directory());
    expect(evidence).toMatchObject({
      fullBranchReadiness: false,
      independentAcceptance: false,
      fixed: false,
    });
    expect(FindingsRecordSchema.safeParse(evidence).success).toBe(false);
  });
  test.each(['binding', 'digest', 'order', 'snapshot', 'missing', 'oversize', 'manifest'])(
    'refuses %s before import/ack',
    async (fault) => {
      const f = fixture();
      const dir = await directory();
      const transport: QueueTransport = async (wire) => {
        const raw = await f.transport(wire);
        const envelope = JSON.parse(raw) as {
          requestId: string;
          result: { page?: Record<string, unknown> };
        };
        const page = envelope.result.page;
        if (fault === 'binding') envelope.requestId = 'wrong';
        if (page?.['kind'] === 'manifest' && fault === 'manifest') page['chunks'] = 1;
        if (page?.['kind'] === 'chunk') {
          if (fault === 'digest') page['chunk_sha256'] = 'f'.repeat(64);
          if (fault === 'order') page['index'] = 7;
          if (fault === 'snapshot') page['receipt_id'] = 'f'.repeat(64);
          if (fault === 'missing') page['next_cursor'] = null;
          if (fault === 'oversize') return 'x'.repeat(8193);
        }
        return JSON.stringify(envelope);
      };
      await expect(makeQueueClient(transport).report(ref, dir)).rejects.toThrow();
      expect(f.acknowledgements()).toBe(0);
      expect(await readdir(dir)).toEqual([]);
    },
  );
  test('disconnect at each page resumes safely without premature acknowledgement', async () => {
    const f = fixture();
    const dir = await directory();
    for (let interrupted = 0; interrupted < f.common.chunks; interrupted++) {
      const transport: QueueTransport = async (wire) => {
        const req = JSON.parse(wire) as { op: string; cursor?: string };
        if (req.op === 'report' && req.cursor === f.receiptId + ':' + interrupted)
          throw new Error('disconnect');
        return f.transport(wire);
      };
      await expect(makeQueueClient(transport).report(ref, dir)).rejects.toThrow('disconnect');
      expect(f.acknowledgements()).toBe(0);
    }
    await makeQueueClient(f.transport).report(ref, dir);
    expect(f.acknowledgements()).toBe(1);
  });
  test('real registry importer binds authorized transport and old runner stays unsupported', async () => {
    const f = fixture();
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'fixture');
    vi.spyOn(queueClient, 'sshQueueTransport').mockReturnValue(f.transport);
    const entry = registry.find((e) => e.name === 'review.enqueue')!;
    const op = await entry.importer();
    expect(await op(ref)).toMatchObject({
      status: 'ok',
      value: { state: 'terminal-with-findings' },
    });
    vi.mocked(queueClient.sshQueueTransport).mockReturnValue(async () =>
      JSON.stringify({ v: 1, ...ref, result: { unsupported: 'old runner' } }),
    );
    expect(await op(ref)).toMatchObject({
      status: 'ok',
      value: { state: 'unsupported' },
    });
    expect(f.acknowledgements()).toBe(0);
  });
  test('operator alias cannot choose arbitrary commands', () => {
    for (const alias of ['-oProxyCommand=bad', 'host;id', 'host path'])
      expect(() => sshQueueTransport(alias)).toThrow();
  });
  test('registry -> authorized Python capability -> durable enqueue -> runner fixture -> verified import', async () => {
    const root = await directory();
    const store = await directory();
    const f = fixture();
    const transport: QueueTransport = async (wire) =>
      execFileSync(
        'python3',
        [
          '-c',
          'import sys; from test_queue_transport import bridge; sys.stdout.buffer.write(bridge(sys.argv[1], sys.stdin.buffer.read()))',
          root,
        ],
        { cwd: join(process.cwd(), 'apps/crq-python'), input: wire, maxBuffer: 8192 },
      ).toString('utf8');
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'fixture');
    vi.spyOn(queueClient, 'sshQueueTransport').mockReturnValue(transport);
    const enqueue = await registry.find((entry) => entry.name === 'review.enqueue')!.importer();
    expect(await enqueue(ref)).toMatchObject({
      status: 'ok',
      value: { state: 'pending', reviewed: false },
    });
    expect(await enqueue(ref)).toMatchObject({ status: 'ok', value: { state: 'pending' } });
    await writeFile(join(root, 'fixture-document.json'), JSON.stringify(f.document));
    await transport('fixture-tick');
    const report = await registry.find((entry) => entry.name === 'review.report')!.importer();
    expect(await report({ ...ref, evidenceDir: store })).toMatchObject({
      status: 'ok',
      value: {
        state: 'consumed',
        evidence: {
          document: { capture: { target: 'c'.repeat(40) } },
          fullBranchReadiness: false,
          independentAcceptance: false,
          fixed: false,
        },
      },
    });
    const status = await registry.find((entry) => entry.name === 'review.queueStatus')!.importer();
    expect(await status(ref)).toMatchObject({
      status: 'ok',
      value: { consumed: true, reviewed: true, fixed: false },
    });
    expect(await readdir(store)).toHaveLength(1);
  });
});

describe('public queue local alias classification', () => {
  test.each(['host;id', '-oProxyCommand=bad', 'host path'])(
    'malformed operator alias fails every op before any transport invocation: %s',
    async (alias) => {
      vi.stubEnv('CQ_QUEUE_SSH_ALIAS', alias);
      const real = queueClient.sshQueueTransport;
      const dispatched = vi.fn();
      // Wrap the real factory: a malformed alias throws there before any spawn.
      vi.spyOn(queueClient, 'sshQueueTransport').mockImplementation((value: string) => {
        const transport = real(value);
        return async (wire: string) => {
          dispatched();
          return transport(wire);
        };
      });
      const ops = makeQueueOps();
      for (const result of [
        await ops.enqueue(ref),
        await ops.queueStatus(ref),
        await ops.report({ ...ref, evidenceDir: 'evidence' }),
      ])
        expect(result).toEqual({ status: 'failed', error: 'invalid queue SSH alias' });
      expect(dispatched).not.toHaveBeenCalled();
    },
  );
  test('malformed alias is reachable as failed through the review registry', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'host;id');
    for (const name of ['review.enqueue', 'review.queueStatus', 'review.report']) {
      const op = await registry.find((entry) => entry.name === name)!.importer();
      const input = name === 'review.report' ? { ...ref, evidenceDir: 'evidence' } : ref;
      expect(await op(input)).toMatchObject({ status: 'failed' });
    }
  });
  test.each(['invalid queue SSH alias', 'queue delivery unknown: timeout'])(
    'injected transport failure keeps its indeterminate verdict: %s',
    async (detail) => {
      vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'host;id');
      const transport: QueueTransport = async () => {
        throw new Error(detail);
      };
      const result = await makeQueueOps(transport).queueStatus(ref);
      expect(result).toMatchObject({ status: 'indeterminate' });
      if (result.status === 'indeterminate') expect(result.detail).toContain(detail);
    },
  );
  test('injected transport still succeeds while the local alias is unusable', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'host;id');
    const transport: QueueTransport = async () =>
      JSON.stringify({
        v: 1,
        requestId: ref.requestId,
        binding: ref.binding,
        result: pendingStatus,
      });
    expect(await makeQueueOps(transport).queueStatus(ref)).toEqual({
      status: 'ok',
      value: pendingStatus,
    });
  });
  test('missing alias remains an explicit needs-human configuration reason', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', '');
    const result = await makeQueueOps().queueStatus(ref);
    expect(result).toMatchObject({ status: 'needs-human' });
    if (result.status === 'needs-human') expect(result.reason).toContain('CQ_QUEUE_SSH_ALIAS');
  });
});

describe('public queue local input classification', () => {
  test.each([
    { ...ref, action: 'bind' as const },
    { ...ref, pr: 12 },
    { ...ref, action: 'cancel' as const, mergeSha: 'a'.repeat(40) },
  ] satisfies QueueEnqueueInput[])(
    'action-dependent invalid enqueue fails before dispatch: %j',
    async (input) => {
      const transport = vi.fn<QueueTransport>();
      expect(await makeQueueOps(transport).enqueue(input)).toMatchObject({ status: 'failed' });
      expect(transport).not.toHaveBeenCalled();
    },
  );
  test('direct SDK schema rejects fail before dispatch for every op', async () => {
    const transport = vi.fn<QueueTransport>();
    const ops = makeQueueOps(transport);
    expect(await ops.enqueue({ ...ref, requestId: '' })).toMatchObject({ status: 'failed' });
    expect(
      await ops.queueStatus({ ...ref, binding: { ...ref.binding, repo: '../repo' } }),
    ).toMatchObject({ status: 'failed' });
    expect(await ops.report({ ...ref, evidenceDir: '' })).toMatchObject({ status: 'failed' });
    expect(transport).not.toHaveBeenCalled();
  });
  test('invalid input is deterministic even with no queue configuration', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', '');
    expect(await makeQueueOps().enqueue({ ...ref, action: 'bind' })).toMatchObject({
      status: 'failed',
    });
    expect(await makeQueueOps().queueStatus(ref)).toMatchObject({ status: 'needs-human' });
  });
  test('action-dependent reject stays reachable through the review registry', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', '');
    const enqueue = await registry.find((entry) => entry.name === 'review.enqueue')!.importer();
    expect(await enqueue({ ...ref, action: 'bind' })).toMatchObject({ status: 'failed' });
  });
  test('valid commands still dispatch the intended wire payload', async () => {
    type WireRequest = { op: string; pr?: number; mergeSha?: string };
    const sent: WireRequest[] = [];
    const transport: QueueTransport = async (wire) => {
      sent.push(JSON.parse(wire) as WireRequest);
      return JSON.stringify({
        v: 1,
        requestId: ref.requestId,
        binding: ref.binding,
        result: pendingStatus,
      });
    };
    const ops = makeQueueOps(transport);
    expect(await ops.enqueue(ref)).toMatchObject({ status: 'ok' });
    expect(await ops.enqueue({ ...ref, action: 'cancel' })).toMatchObject({ status: 'ok' });
    expect(
      await ops.enqueue({ ...ref, action: 'bind', pr: 12, mergeSha: 'a'.repeat(40) }),
    ).toMatchObject({ status: 'ok' });
    expect(sent.map(({ op }) => op)).toEqual(['enqueue', 'cancel', 'bind']);
    // The optional mergeSha and the positive pr are only proven by the payload.
    expect(sent[2]).toMatchObject({ op: 'bind', pr: 12, mergeSha: 'a'.repeat(40) });
  });
  test.each([
    '{}',
    'not JSON',
    JSON.stringify({
      v: 1,
      requestId: ref.requestId,
      binding: ref.binding,
      result: { state: 'x' },
    }),
  ])('malformed remote response remains indeterminate: %s', async (raw) => {
    const transport = vi.fn<QueueTransport>(async () => raw);
    expect(await makeQueueOps(transport).queueStatus(ref)).toMatchObject({
      status: 'indeterminate',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test('unsupported capability keeps its explicit result', async () => {
    const transport: QueueTransport = async () =>
      JSON.stringify({
        v: 1,
        requestId: ref.requestId,
        binding: ref.binding,
        result: { unsupported: true },
      });
    expect(await makeQueueOps(transport).queueStatus(ref)).toMatchObject({
      status: 'ok',
      value: { state: 'unsupported' },
    });
  });
});

describe('queue report lifetime enforcement', () => {
  const receiptId = 'e'.repeat(64);
  const status: QueueStatus = {
    state: 'terminal-clean',
    pr: 12,
    mergeSha: 'b'.repeat(40),
    itemId: 'item-1',
    receiptId,
    consumed: true,
    reviewed: true,
    fixed: false,
  };
  const manifest = {
    version: 1,
    kind: 'manifest',
    receipt_id: receiptId,
    sha256: receiptId,
    bytes: 1,
    chunks: 1,
    encoding: 'base64-utf8-json',
    cursor: `${receiptId}:0`,
  };
  function envelope(result: unknown) {
    return JSON.stringify({
      v: 1,
      requestId: ref.requestId,
      binding: ref.binding,
      result,
    });
  }

  test('a caller cancellation during receipt delivery prevents the local import, the observer and the ack', async () => {
    const dir = await directory();
    const controller = new AbortController();
    const reason = new Error('caller cancelled before ack');
    const ops: string[] = [];
    let observed = 0;
    let acked = 0;
    const transport: QueueTransport = async (wire) => {
      const op = (JSON.parse(wire) as { op: string }).op;
      ops.push(op);
      if (op === 'status') return envelope(status);
      if (op === 'report') {
        // Cancellation lands while the manifest page is in flight; the next internal step must
        // refuse before touching the filesystem, the observer or the acknowledgement.
        controller.abort(reason);
        return envelope({ page: manifest });
      }
      if (op === 'ack') {
        acked += 1;
        return envelope(status);
      }
      throw new Error(`unexpected queue op: ${op}`);
    };
    const client = makeQueueClient(transport);
    await expect(
      client.report(ref, dir, {
        signal: controller.signal,
        onEvidenceImported: async () => {
          observed += 1;
        },
      }),
    ).rejects.toThrow(reason);
    expect(acked).toBe(0);
    expect(observed).toBe(0);
    expect(ops).not.toContain('ack');
    await expect(readdir(dir)).rejects.toThrow();
  });

  test('an exhausted caller budget refuses before any queue dispatch', async () => {
    const dir = await directory();
    const ops: string[] = [];
    const transport: QueueTransport = async (wire) => {
      ops.push((JSON.parse(wire) as { op: string }).op);
      return envelope(status);
    };
    const client = makeQueueClient(transport);
    await expect(
      client.report(ref, dir, { remainingMs: () => 0 }),
    ).rejects.toThrow(/deadline exhausted/);
    expect(ops).toEqual([]);
    await expect(readdir(dir)).rejects.toThrow();
  });
});
