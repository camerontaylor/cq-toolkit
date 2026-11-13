// Split provenance: the receipt-consumption cases moved verbatim from
// test/ops/review/queue.test.ts (round-2 pure-move split); the shared fixtures
// live in `queue.helpers.ts`.
import { execFileSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FindingsRecordSchema } from '../../../src/ops/review/findings.js';
import {
  makeQueueClient,
  sshQueueTransport,
} from '../../../src/ops/review/internal/queueClient.js';
import * as queueClient from '../../../src/ops/review/internal/queueClient.js';
import {
  parseQueueReceipt,
  readQueueEvidence,
  sha256,
} from '../../../src/ops/review/internal/queueEvidence.js';
import type { QueueTransport } from '../../../src/ops/review/internal/queueProtocol.js';
import { makeQueueOps } from '../../../src/ops/review/queue.js';
import { cleanupQueueDirs, directory, fixture, ref } from './queue.helpers.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupQueueDirs();
});

test('parseStatus accepts independent fixed evidence without replacing the receipt outcome', async () => {
  const f = fixture(false, true);
  const status = await makeQueueClient(f.transport).status(ref);
  expect(status).toMatchObject({
    state: 'terminal-with-findings',
    fixed: true,
    consumed: false,
    remediation: {
      receiptId: f.receiptId,
      captureDigest: 'd'.repeat(64),
      fixPr: 99,
      mergeSha: 'e'.repeat(40),
      headSha: 'f'.repeat(40),
      targetSha: 'a'.repeat(40),
    },
  });
});

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
  test('Unicode receipt scope matches Python ensure_ascii canonical bytes', async () => {
    // Generated independently with Python json.dumps(sort_keys=True,
    // separators=(',', ':'), ensure_ascii=True), then hashlib.sha256.
    const canonical =
      '[{"disposition":"included","path":"src/\\u00e9\\ud83d\\ude00.ts","resolution":"same-path-current","source_path":"src/\\u00e9\\ud83d\\ude00.ts"}]';
    const f = fixture(true, false, true);
    expect(sha256(Buffer.from(canonical))).toBe(f.document.capture.scope_digest);
    const dir = await directory();
    await makeQueueClient(f.transport).report(ref, dir);
    expect((await readQueueEvidence(dir, f.receiptId))?.document.capture.paths).toEqual(
      f.document.capture.paths,
    );
    f.document.capture.paths[0]!.path = 'src/changed.ts';
    expect(() => parseQueueReceipt(f.document)).toThrow('queue scope manifest digest mismatch');
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
    const op = makeQueueOps().enqueue;
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
          'import sys; from test_queue_transport_fixtures import bridge; sys.stdout.buffer.write(bridge(sys.argv[1], sys.stdin.buffer.read()))',
          root,
        ],
        { cwd: join(process.cwd(), 'apps/crq-python'), input: wire, maxBuffer: 8192 },
      ).toString('utf8');
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'fixture');
    vi.spyOn(queueClient, 'sshQueueTransport').mockReturnValue(transport);
    const enqueue = makeQueueOps().enqueue;
    expect(await enqueue(ref)).toMatchObject({
      status: 'ok',
      value: { state: 'pending', reviewed: false },
    });
    expect(await enqueue(ref)).toMatchObject({ status: 'ok', value: { state: 'pending' } });
    await writeFile(join(root, 'fixture-document.json'), JSON.stringify(f.document));
    await transport('fixture-tick');
    const report = makeQueueOps().report;
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
    const status = makeQueueOps().queueStatus;
    expect(await status(ref)).toMatchObject({
      status: 'ok',
      value: { consumed: true, reviewed: true, fixed: false },
    });
    const files = await readdir(store);
    expect(files).toHaveLength(1);
    const evidence = await readQueueEvidence(store, files[0]!.replace(/\.json$/, ''));
    expect(parseQueueReceipt(evidence.document).remediation).toBe('disabled/deferred');
  });
});
