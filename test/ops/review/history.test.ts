import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import vectors from '../../../apps/crq-python/fixtures/review-operation/vectors.json' with { type: 'json' };
import { makeHistory } from '../../../src/ops/review/history.js';
import { makeStatus } from '../../../src/ops/review/status.js';
import { makeSubmit } from '../../../src/ops/review/submit.js';
import { HistorySchema } from '../../../src/ops/review/internal/reviewOperation.js';

const run = promisify(execFile);
const caps = {
  v: 1,
  command: 'review-v1',
  operations: [
    'capabilities',
    'submit',
    'status',
    'result',
    'cancel',
    'notify-update',
    'review-history',
  ],
  features: [
    'original-commit-snapshot-v1',
    'chunked-result-v1',
    'repeat-generations-v1',
    'review-history-v1',
  ],
  limits: {
    max_request_bytes: 6291456,
    max_snapshot_bytes: 5242880,
    max_content_bytes: 3145728,
    max_objects: 4096,
    chunk_bytes: 3072,
  },
};
const projection = HistorySchema.parse(
  vectors.find((row) => row.name === 'history-response')!.value,
);

test('review.history pages by request id without re-resolving Git', async () => {
  const wire: unknown[] = [];
  const result = await makeHistory(async (raw) => {
    const request = JSON.parse(raw) as { op: string };
    if (request.op === 'capabilities') return JSON.stringify(caps);
    wire.push(request);
    return JSON.stringify(projection);
  })({ repo: 'camerontaylor/cq-toolkit', target: 'main', requestId: 'local-1' });
  expect(result.status).toBe('ok');
  expect(wire).toEqual([
    { v: 1, op: 'review-history', request_id: 'local-1', limit: 20, cursor: 0 },
  ]);
  expect(result.status === 'ok' && result.value).toMatchObject({
    status: 'ok',
    relation: 'ancestral',
    repeat: true,
  });
});

test('review.history observes the attached branch and pinned trees', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cq-history-'));
  const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await git('init', '-q', '--template=', '-b', 'main');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await writeFile(join(cwd, '.gitignore'), '/.cq/\n');
  await writeFile(join(cwd, 'file'), 'base');
  await git('add', 'file', '.gitignore');
  await git('commit', '-qm', 'base');
  const head = await git('rev-parse', 'HEAD');
  const wire: Record<string, unknown>[] = [];
  const result = await makeHistory(async (raw) => {
    const request = JSON.parse(raw) as { op: string };
    if (request.op === 'capabilities') return JSON.stringify(caps);
    wire.push(request);
    return JSON.stringify(projection);
  })({ cwd, repo: 'camerontaylor/cq-toolkit', target: 'main', head, task: 'S3a', limit: 5 });
  expect(result.status).toBe('ok');
  expect(wire[0]).toMatchObject({
    op: 'review-history',
    repo: 'camerontaylor/cq-toolkit',
    target: 'main',
    head_commit: head,
    task: 'S3a',
    branch: 'main',
    limit: 5,
    cursor: 0,
  });
  expect(wire[0]?.base_commit).toBe(head);
  expect(wire[0]?.head_tree).toBe(await git('rev-parse', 'HEAD^{tree}'));
});

test('unsupported servers surface explicitly, never a fallback', async () => {
  const result = await makeHistory(async () =>
    JSON.stringify({
      ...caps,
      operations: ['capabilities', 'submit', 'status', 'result', 'cancel'],
      features: ['chunked-result-v1'],
    }),
  )({ repo: 'camerontaylor/cq-toolkit', target: 'main', requestId: 'local-1' });
  expect(result).toMatchObject({
    status: 'ok',
    value: { state: 'unsupported', reason: 'review-history capability unavailable' },
  });
});

test('submit and status emit the cue once per material digest', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cq-cue-'));
  const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await git('init', '-q', '--template=', '-b', 'main');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await writeFile(join(cwd, '.gitignore'), '/.cq/\n');
  await writeFile(join(cwd, 'file'), 'base');
  await git('add', 'file', '.gitignore');
  await git('commit', '-qm', 'base');
  await git('branch', 'target');
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');

  let digest = 'a'.repeat(64);
  const seen: Record<string, unknown>[] = [];
  const response = (requestId: string) =>
    JSON.stringify({
      v: 1,
      request_id: requestId,
      action: 'created',
      state: 'queued',
      identity: 'b'.repeat(64),
      history: { v: 1, digest, status: 'ok', cue: 'Previously reviewed at abc.' },
    });
  const transport = async (raw: string) => {
    const request = JSON.parse(raw) as { op: string; request_id?: string };
    if (request.op === 'capabilities') return JSON.stringify(caps);
    seen.push(request);
    return response(request.request_id ?? 'cue-one');
  };
  const submit = await makeSubmit(transport)({
    cwd,
    repo: 'owner/repo',
    target: 'target',
    reachable: true,
    task: 'S3a',
    requestId: 'cue-one',
  });
  expect(submit.status).toBe('ok');
  expect(seen[0]).toMatchObject({ op: 'submit', task: 'S3a', branch: 'main' });
  expect(submit.status === 'ok' && submit.value).toMatchObject({
    history: { digest, cue: 'Previously reviewed at abc.' },
  });

  const retried = await makeSubmit(transport)({
    cwd,
    repo: 'owner/repo',
    target: 'target',
    reachable: true,
    task: 'S3a',
    requestId: 'cue-one',
  });
  expect(retried.status === 'ok' && retried.value).toMatchObject({ history: { digest } });
  expect(
    retried.status === 'ok' && 'cue' in ((retried.value as { history: object }).history ?? {}),
  ).toBe(false);

  const firstStatus = await makeStatus(transport)({ cwd, requestId: 'cue-one' });
  expect(firstStatus.status === 'ok' && firstStatus.value).toMatchObject({ history: { digest } });
  expect(
    firstStatus.status === 'ok' &&
      'cue' in ((firstStatus.value as { history: object }).history ?? {}),
  ).toBe(false);

  digest = 'c'.repeat(64);
  const changed = await makeStatus(transport)({ cwd, requestId: 'cue-one' });
  expect(changed.status === 'ok' && changed.value).toMatchObject({
    history: { digest, cue: 'Previously reviewed at abc.' },
  });
});
