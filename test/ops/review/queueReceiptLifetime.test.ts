import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  makeQueueClient,
  sshQueueTransport,
} from '../../../src/ops/review/internal/queueClient.js';
import { consumeDeferredVendorReport } from '../../../src/ops/dev/internal/deferredSettlement.js';
import type { DeferredVendorDebt } from '../../../src/ops/dev/internal/deferredReview.js';
import { makeFakeEffects, okResult } from '../dev/fakes.js';
import type { RunCommand } from '../../../src/ops/dev/effects.js';
import { sha256 } from '../../../src/ops/review/internal/queueEvidence.js';
import type {
  QueueReference,
  QueueTransport,
} from '../../../src/ops/review/internal/queueProtocol.js';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'cq-lifetime-'));
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
function fixture(clean = false) {
  const paths = [
    {
      source_path: 'src/a.ts',
      path: 'src/a.ts',
      resolution: 'same-path-current',
      disposition: 'included',
    },
  ];
  // Sorted ASCII keys match the producer scope digest.
  const canonicalPaths = JSON.stringify([
    {
      disposition: 'included',
      path: 'src/a.ts',
      resolution: 'same-path-current',
      source_path: 'src/a.ts',
    },
  ]);
  const document = {
    version: 1,
    item_id: 'current-1',
    request_id: 'original-alias',
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
    itemId: 'current-1',
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

describe('shared queue receipt lifetime', () => {
  test('already aborted callers dispatch nothing', async () => {
    const transport = vi.fn<QueueTransport>();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      makeQueueClient(transport).report(ref, await directory(), { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(transport).not.toHaveBeenCalled();
  });
  test('abort on a delivered page stops further requests and acknowledgement; replay restarts verified delivery', async () => {
    const f = fixture();
    const controller = new AbortController();
    const cursors: unknown[] = [];
    const dir = await directory();
    const client = makeQueueClient(async (wire, options) => {
      expect(options?.signal).toBeDefined();
      const request = JSON.parse(wire) as { cursor?: string };
      cursors.push(request.cursor);
      const result = await f.transport(wire);
      if (request.cursor === f.receiptId + ':0') controller.abort(new Error('between pages'));
      return result;
    });
    await expect(client.report(ref, dir, { signal: controller.signal })).rejects.toThrow(
      'between pages',
    );
    expect(cursors).toEqual([undefined, null, f.receiptId + ':0']);
    expect(f.acknowledgements()).toBe(0);
    expect(await readdir(dir)).toEqual([]);
    const delivered = await client.report(ref, dir);
    expect(delivered?.receiptId).toBe(f.receiptId);
    expect(f.acknowledgements()).toBe(1);
    expect((await readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });
  test('abort races an uncooperative in-flight transport and never acknowledges', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport = vi.fn<QueueTransport>((_wire, options) => {
      expect(options?.signal?.aborted).toBe(false);
      started();
      return new Promise(() => undefined);
    });
    const pending = makeQueueClient(transport).report(ref, await directory(), {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow('in flight');
    await ready;
    controller.abort(new Error('in flight'));
    await rejected;
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test('one deadline spans status and pages instead of renewing on every request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const budgets: number[] = [];
    const transport: QueueTransport = async (wire, options) => {
      budgets.push(options!.remainingMs!());
      await new Promise((resolve) => setTimeout(resolve, 40));
      return f.transport(wire);
    };
    const pending = makeQueueClient(transport).report(ref, await directory(), {
      remainingMs: () => 100,
    });
    const rejected = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(budgets).toHaveLength(3);
    expect(budgets[1]).toBeLessThan(budgets[0]!);
    expect(f.acknowledgements()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(budgets).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  test.each(['abort', 'deadline'] as const)(
    'SSH %s kills the process and releases pipes and timers',
    async (mode) => {
      vi.useFakeTimers();
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      mocks.spawn.mockReturnValue(child);
      const controller = new AbortController();
      const pending = sshQueueTransport('offline-fixture')('{}\n', {
        signal: controller.signal,
        remainingMs: () => 50,
      });
      const rejected = expect(pending).rejects.toThrow(mode === 'abort' ? 'stop ssh' : 'deadline');
      if (mode === 'abort') controller.abort(new Error('stop ssh'));
      else await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
      child.emit('close', null);
      expect(child.listenerCount('close')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

test('settlement propagates cancellation and remaining budget without mutating visible debt', async () => {
  const controller = new AbortController();
  const debt: DeferredVendorDebt = {
    reference: {
      requestId: 'intent-1',
      binding: {
        kind: 'deferred-author',
        repo: 'owner/repo',
        producer: 'author',
        head: 'a'.repeat(40),
        target: 'merge-queue',
        targetSelector: 'promoted-main',
      },
    },
    queue: {
      state: 'enqueued',
      pr: 12,
      mergeSha: 'b'.repeat(40),
      itemId: 'item',
      receiptId: null,
      consumed: false,
      reviewed: false,
      fixed: false,
    },
    originAttempt: {
      cycleId: 'origin',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      target: 'merge-queue',
      scope: 'full',
      dirtySha256: 'clean-tree',
      failure: { source: 'vendor', category: 'vendor-rate-limited', codes: ['rate_limited'] },
    },
    deferral: { id: 'intent-1', base: 'b'.repeat(40), dirtySha256: 'clean-tree' },
    vendor: 'vendor-pending',
    vendorCompleted: false,
  };
  const retained = structuredClone(debt);
  const effects = makeFakeEffects();
  effects.runCommand = vi.fn<RunCommand>(async (_command, _args, options) => {
    expect(options.signal).toBeDefined();
    expect(options.timeoutMs).toBeLessThanOrEqual(1000);
    return okResult('/offline');
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = {
    ...makeQueueClient(async () => {
      throw new Error('unexpected transport');
    }),
    report: vi.fn<ReturnType<typeof makeQueueClient>['report']>((_ref, _dir, options) => {
      expect(options?.remainingMs?.()).toBeLessThanOrEqual(1000);
      expect(options?.signal).not.toBe(controller.signal);
      started();
      return new Promise(() => undefined);
    }),
    status: vi.fn(),
  };
  const pending = consumeDeferredVendorReport(effects, client, debt, controller.signal, () => 1000);
  const rejected = expect(pending).rejects.toThrow('settlement cancelled');
  await ready;
  controller.abort(new Error('settlement cancelled'));
  await rejected;
  expect(client.status).not.toHaveBeenCalled();
  expect(debt).toEqual(retained);
});
