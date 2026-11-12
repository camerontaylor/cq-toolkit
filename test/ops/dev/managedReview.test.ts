// S2b-i fake-transport end-to-end (plan §S2b-i): the REAL managed seam
// (submit → wait → fetch) over a scripted review-v1 server on a REAL git
// repo — no direct CLI launch anywhere on this route.
//
// submit → complete → receipt read → no second start:
//  1. submit CREATES the queue item (action=created, deterministic
//     requestId `dev-{base8}-{head8}`), the fake server starts one review;
//  2. completion arrives through status polling; the result fetch verifies
//     chunk digests, persists receipt.json, and the seam maps the receipt
//     outcome/findings (completed + findings, findings verbatim);
//  3. a second submit with the same pins REJOINS (action=joined): the fake
//     server starts NO second review, and both submits resolve completed
//     with the same receipt.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { makeManagedReviewSubmit } from '../../../src/ops/dev/managedReview.js';
import {
  canonicalReview,
  reviewDigest,
  ReceiptSchema,
} from '../../../src/ops/review/internal/reviewOperation.js';
import { makeTestRepo, type TestRepo } from './repo.js';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const caps = {
  v: 1,
  command: 'review-v1',
  operations: ['capabilities', 'submit', 'status', 'result', 'cancel'],
  features: ['original-commit-snapshot-v1', 'chunked-result-v1'],
  limits: {
    max_request_bytes: 6291456,
    max_snapshot_bytes: 5242880,
    max_content_bytes: 3145728,
    max_objects: 4096,
    chunk_bytes: 3072,
  },
};

test('S2b-i e2e: fake-transport submit completes and rejoins without a second review', async () => {
  const root = repo.root;
  const base = repo.git('rev-parse', 'origin/merge-queue').trim();
  const head = repo.git('rev-parse', 'HEAD').trim();
  const baseTree = repo.git('rev-parse', `${base}^{tree}`).trim();
  const headTree = repo.git('rev-parse', 'HEAD^{tree}').trim();
  const requestId = `dev-${base.slice(0, 8)}-${head.slice(0, 8)}`;

  // The fake review-v1 server: one review per request id. Submit CREATES on
  // first sight and JOINS after; status reports running until the review is
  // marked done; result serves the receipt in 3072-byte chunks.
  let reviewsStarted = 0;
  let done = false;
  const receipt = ReceiptSchema.parse({
    v: 1,
    kind: 'local-review-full-diff',
    identity: '0'.repeat(64),
    identity_inputs: {
      v: 1,
      repo: 'owner/repo',
      base_commit: base,
      base_tree: baseTree,
      head_commit: head,
      head_tree: headTree,
      scope: 'full-diff',
      projection: 'full-diff',
      config_digest: '0'.repeat(64),
      profile: { adapter: 'coderabbit-cli', revision: 'fake' },
    },
    profile: { adapter: 'coderabbit-cli', revision: 'fake', flags: [] },
    run_id: 'fake-run-1',
    outcome: 'findings',
    scope_adequate: true,
    findings: [
      {
        type: 'finding',
        severity: 'major',
        fileName: 'src/a.ts',
        comment: 'fake finding',
        startLine: 1,
        rule: 'fake-rule',
      },
    ],
    report: '# fake report\n',
    observed: {},
    independent_acceptance: false,
  });
  receipt.identity = reviewDigest(receipt.identity_inputs);
  const bytes = Buffer.from(canonicalReview(receipt));
  // chunk.sha256 === chunk.receipt_id is a result-op integrity rule, so
  // the fake server carries the BYTES digest in both wire fields; the seam
  // binds findings to that transport receipt id, which also names the
  // persisted receipt file.
  const receiptId = sha256(bytes);
  const chunks = Math.max(1, Math.ceil(bytes.length / 3072));
  const submitWires: unknown[] = [];
  const seen = new Set<string>();
  const transport = async (raw: string): Promise<string> => {
    const wire = JSON.parse(raw) as { op: string; request_id?: string; index?: number };
    if (wire.op === 'capabilities') return JSON.stringify(caps);
    if (wire.op === 'submit') {
      submitWires.push(wire);
      if (!seen.has(wire.request_id!)) {
        seen.add(wire.request_id!);
        reviewsStarted += 1;
        return JSON.stringify({
          v: 1,
          action: 'created',
          state: 'queued',
          request_id: wire.request_id,
        });
      }
      // A rejoin of the same request: no second review starts.
      return JSON.stringify({
        v: 1,
        action: 'joined',
        state: done ? 'completed' : 'running',
        request_id: wire.request_id,
      });
    }
    if (wire.op === 'status')
      return JSON.stringify({
        v: 1,
        action: 'observed',
        state: done ? 'completed' : 'running',
        request_id: wire.request_id,
      });
    if (wire.op === 'result') {
      if (!done) return JSON.stringify({ v: 1, action: 'observed', state: 'running' });
      const index = wire.index ?? 0;
      const data = bytes.subarray(index * 3072, (index + 1) * 3072);
      return JSON.stringify({
        v: 1,
        receipt_id: receiptId,
        index,
        chunks,
        bytes: bytes.length,
        sha256: receiptId,
        encoding: 'base64-utf8-json',
        data: data.toString('base64'),
        chunk_sha256: sha256(data),
        next_index: index + 1 === chunks ? null : index + 1,
      });
    }
    throw new Error(`unexpected op ${wire.op}`);
  };

  const submit = makeManagedReviewSubmit(
    () => transport,
    async () => 'owner/repo',
  );

  // The D11 wait polls every ~15 s; complete the review as soon as the first
  // status poll lands so the test never sleeps the real interval.
  const completing = (async () => {
    for (let i = 0; i < 200 && !done; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (submitWires.length > 0) done = true;
    }
  })();

  const first = await submit({
    cwd: root,
    target: 'merge-queue',
    base,
    head,
    remainingWallMs: () => 60_000,
  });
  await completing;
  expect(first).toMatchObject({
    status: 'completed',
    value: {
      // value.receiptId is the transport receipt id (the bytes digest the
      // result op verified); the findings' evidence binding is the receipt
      // document's own identity field, pinned for provenance.
      receiptId,
      completion: { kind: 'terminal' },
      findings: [
        {
          severity: 'major',
          fileName: 'src/a.ts',
          excerpt: 'fake finding',
          line: 1,
          rule: 'fake-rule',
          evidence: receipt.identity,
        },
      ],
    },
  });
  // The read-back document the seam mapped is exactly the verified bytes.
  expect(
    await readFile(join(root, '.cq/queue-evidence/results', receiptId, 'receipt.json'), 'utf8'),
  ).toBe(bytes.toString());
  // The receipt id IS the sha256 of the canonical receipt the result op
  // verified — the transport id arrives on the wire and names the file.
  expect(reviewsStarted).toBe(1);
  expect(submitWires[0]).toMatchObject({
    op: 'submit',
    request_id: requestId,
    inputs: { repo: 'owner/repo', target: 'merge-queue', base_commit: base, head_commit: head },
  });

  // The second submit rejoins the same queue item: the server starts no
  // second review and the same completed receipt resolves again. The
  // durable request file persists, so the rejoin spends no new mutation.
  const second = await submit({ cwd: root, target: 'merge-queue', base, head });
  expect(second).toMatchObject({ status: 'completed', value: { receiptId } });
  expect(reviewsStarted).toBe(1);
  expect(submitWires).toHaveLength(2);
  expect(submitWires[1]).toMatchObject({ op: 'submit', request_id: requestId });
});
