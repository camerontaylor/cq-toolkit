import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { makeSubmit } from '../../../src/ops/review/submit.js';
import { SnapshotSchema } from '../../../src/ops/review/internal/reviewOperation.js';
const run = promisify(execFile);
let cwd: string;
const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
const caps = {
  v: 1,
  command: 'review-v1',
  operations: ['capabilities', 'submit', 'status', 'result', 'cancel'],
  features: ['original-commit-snapshot-v1', 'chunked-result-v1'],
  limits: {
    max_request_bytes: 6291456,
    max_snapshot_bytes: 6291456,
    max_content_bytes: 4194304,
    max_objects: 4096,
    chunk_bytes: 3072,
  },
};
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'cq-submit-'));
  await git('init', '-q', '--template=');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await writeFile(join(cwd, 'file'), 'base');
  await git('add', 'file');
  await git('commit', '-qm', 'base');
  await git('branch', 'target');
});
test('empty committed diff avoids all network calls and reports exclusions', async () => {
  await writeFile(join(cwd, 'file'), 'staged');
  await git('add', 'file');
  await writeFile(join(cwd, 'file'), 'unstaged');
  const result = await makeSubmit(async () => {
    throw new Error('network forbidden');
  })({ cwd, repo: 'owner/repo', target: 'target' });
  expect(result).toMatchObject({
    status: 'ok',
    value: { action: 'no-changes', exclusions: { staged: 'file', unstaged: 'file' } },
  });
});
test('A-2 lost response retries the durable original request despite checkout movement; A-9 names reviewed head', async () => {
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');
  const head = await git('rev-parse', 'HEAD');
  let lost = true;
  const submissions: unknown[] = [];
  const op = makeSubmit(async (raw) => {
    const wire = JSON.parse(raw) as { op: string; request_id: string };
    if (wire.op === 'capabilities') return JSON.stringify(caps);
    const record = JSON.parse(
      await readFile(join(cwd, '.cq/queue-evidence/requests/request-one.json'), 'utf8'),
    ) as { wire: unknown };
    expect(record.wire).toEqual(wire);
    submissions.push(wire);
    if (lost) throw new Error('response lost');
    return JSON.stringify({ v: 1, action: 'joined', state: 'queued', request_id: wire.request_id });
  });
  const input = {
    cwd,
    repo: 'owner/repo',
    target: 'target',
    requestId: 'request-one',
    reachable: true,
  };
  expect(await op(input)).toMatchObject({
    status: 'indeterminate',
    detail: expect.stringContaining('request-one') as unknown,
  });
  await git('commit', '--allow-empty', '-qm', 'moved');
  lost = false;
  expect(await op(input)).toMatchObject({
    status: 'ok',
    value: { reviewedHead: head, message: expect.stringContaining(head) as unknown },
  });
  expect(submissions[0]).toEqual(submissions[1]);
  expect(
    (await readdir(join(cwd, '.cq/queue-evidence/requests'))).filter(
      (x) => !x.includes('.response.'),
    ),
  ).toEqual(['request-one.json']);
});
test('snapshot contains the original commit, its parents and complete outgoing objects', async () => {
  const base = await git('rev-parse', 'HEAD');
  await writeFile(join(cwd, 'file'), 'middle');
  await git('add', 'file');
  await git('commit', '-qm', 'middle');
  const middle = await git('rev-parse', 'HEAD');
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');
  const head = await git('rev-parse', 'HEAD');
  const scanner = join(cwd, 'scan');
  await writeFile(scanner, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const op = makeSubmit(async (raw) => {
    const wire = JSON.parse(raw) as {
      op: string;
      inputs: { head_commit: string };
      snapshot: unknown;
    };
    if (wire.op === 'capabilities') return JSON.stringify(caps);
    const snapshot = SnapshotSchema.parse(wire.snapshot);
    expect(wire.inputs.head_commit).toBe(head);
    expect(
      snapshot.objects
        .filter((x) => x.type === 'commit')
        .map((x) => x.oid)
        .sort(),
    ).toEqual([head, middle].sort());
    expect(snapshot.objects.map((x) => x.oid)).not.toContain(base);
    return JSON.stringify({ v: 1, action: 'created', state: 'queued' });
  });
  expect(await op({ cwd, repo: 'owner/repo', target: 'target', scanner })).toMatchObject({
    status: 'ok',
  });
});

test('persisted request exists before discovery, and conflicting key reuse makes no network call', async () => {
  await writeFile(join(cwd, 'file'), 'head');
  await git('add', 'file');
  await git('commit', '-qm', 'head');
  const op = makeSubmit(async (raw) => {
    const req = JSON.parse(raw) as { op: string };
    const saved = JSON.parse(
      await readFile(join(cwd, '.cq/queue-evidence/requests/discover.json'), 'utf8'),
    ) as { key: string };
    expect(saved.key).toBe('discover');
    return JSON.stringify(
      req.op === 'capabilities' ? caps : { v: 1, action: 'created', state: 'queued' },
    );
  });
  const input = {
    cwd,
    repo: 'owner/repo',
    target: 'target',
    requestId: 'discover',
    reachable: true,
  };
  expect(await op(input)).toMatchObject({ status: 'ok' });
  expect(
    await makeSubmit(async () => {
      throw new Error('network forbidden');
    })({ ...input, repo: 'other/repo' }),
  ).toMatchObject({ status: 'failed' });
});
