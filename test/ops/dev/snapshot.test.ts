import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { captureSnapshot, snapshotHead } from '../../../src/ops/dev/internal/snapshot.js';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { DevReviewInputSchema } from '../../../src/ops/dev/registry.js';

const exec = promisify(execFile);
// Fixture Git must never follow a caller's GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, env })).stdout.trim();
const CRQ = fileURLToPath(new URL('../../../apps/crq-python/', import.meta.url));

let root: string;
let worker: string;
let base: string;
let tree: string;
let accept: string;
let scanners = 0;

async function scanner(body: string): Promise<string> {
  const path = join(root, `scan-${++scanners}`);
  await writeFile(path, `#!/bin/sh\n${body}`, { mode: 0o700 });
  return path;
}

/** A transport that records whether anything was sent. */
function recorder() {
  const sent: string[] = [];
  return {
    sent,
    transport: async (request: string) => {
      sent.push(request);
      return '';
    },
  };
}

const input = {
  action: 'enroll' as const,
  requestId: 'tree-wire',
  target: 'origin/merge-queue',
  cycle: 1,
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cq-tree-wire-'));
  worker = join(root, 'worker');
  await exec('git', ['init', '-q', '--template=', worker], { env });
  await git(worker, 'config', 'user.name', 'Fixture');
  await git(worker, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(worker, 'file.txt'), 'baseline\n');
  await git(worker, 'add', 'file.txt');
  await git(worker, 'commit', '-qm', 'base');
  base = await git(worker, 'rev-parse', 'HEAD');
  await writeFile(join(worker, 'file.txt'), 'staged change\n');
  await git(worker, 'add', 'file.txt');
  tree = await git(worker, 'write-tree');
  await writeFile(join(worker, 'file.txt'), 'unstaged content stays here\n');
  accept = await scanner(
    '[ "$#" = 3 ] || exit 1\n[ "$GIT_NO_REPLACE_OBJECTS" = 1 ] || exit 1\ngit -C "$1" cat-file -e "$3^{commit}"\n',
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('tree snapshot capture', () => {
  it('is deterministic and leaves HEAD, the index and working files alone', async () => {
    const indexBefore = await readFile(join(worker, '.git/index'));
    const fileBefore = await readFile(join(worker, 'file.txt'));
    const captured = await captureSnapshot(worker, base, tree, accept);
    expect(captured.head).toBe(snapshotHead(base, tree));
    expect((await captureSnapshot(worker, base, tree, accept)).snapshot).toEqual(captured.snapshot);
    expect(await readFile(join(worker, '.git/index'))).toEqual(indexBefore);
    expect(await readFile(join(worker, 'file.txt'))).toEqual(fileBefore);
    expect(await git(worker, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('kills scanner descendants at the scan deadline', async () => {
    const marker = join(root, 'late-marker');
    const slow = await scanner(`(sleep 2; touch "${marker}") &\nwait\n`);
    await expect(captureSnapshot(worker, base, tree, slow, 300)).rejects.toThrow('scan refused');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await expect(readFile(marker)).rejects.toThrow();
  });
});

describe('dev.review with a tree', () => {
  it('enrolls through the real Python admission and pins the synthetic head', async () => {
    const server = join(root, 'server');
    const state = join(root, 'state');
    await exec('git', ['clone', '-q', '--no-hardlinks', worker, server], { env });
    await exec('mkdir', [state]);
    await writeFile(join(state, 'queue.json'), JSON.stringify({ items: [], starts: [] }));
    await writeFile(
      join(state, 'policy.json'),
      JSON.stringify({ review: { reviewerTimeoutMin: 25 } }),
    );
    const python = (request: string) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          'python3',
          [
            '-B',
            '-c',
            'from test_author_snapshot import wire_fixture_main; wire_fixture_main()',
            server,
            state,
          ],
          { cwd: CRQ, env, timeout: 25_000, maxBuffer: 8192 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        child.stdin?.end(request);
      });
    const result = await makeDevReview(python, (b, t) => captureSnapshot(worker, b, t, accept))({
      ...input,
      base,
      tree,
    });
    const head = snapshotHead(base, tree);
    expect(result).toMatchObject({
      status: 'ok',
      value: { binding: { head }, issuer: 'waiting', dispatch: false },
    });
    expect(await git(server, 'rev-parse', 'refs/crq/author-snapshots/v1/' + head)).toBe(head);
    expect(await git(server, 'show', head + ':file.txt')).toBe('staged change');
    const persisted = JSON.parse(await readFile(join(state, 'queue.json'), 'utf8')) as {
      starts: unknown;
    };
    expect(persisted.starts).toEqual([]);
  });

  it('derives the head locally for status and fallback, without capture or objects', async () => {
    for (const action of ['status', 'fallback'] as const) {
      const wire = recorder();
      await makeDevReview(wire.transport, () => {
        throw new Error(`${action} must not capture`);
      })({ ...input, action, base, tree });
      expect(wire.sent.map((request) => JSON.parse(request) as unknown)).toEqual([
        {
          v: 1,
          op: action,
          binding: {
            request_id: input.requestId,
            base,
            head: snapshotHead(base, tree),
            target: input.target,
            cycle: 1,
          },
        },
      ]);
    }
  });

  it('fails definitively, sending nothing, when the pre-upload scan refuses', async () => {
    const refuse = await scanner('exit 1\n');
    const wire = recorder();
    const result = await makeDevReview(wire.transport, (b, t) =>
      captureSnapshot(worker, b, t, refuse),
    )({ ...input, base, tree });
    expect(result.status).toBe('failed');
    expect(wire.sent).toEqual([]);
  });

  it.each([
    ['missing', () => join(root, 'no-such-scanner')],
    ['unset', () => undefined],
  ])('asks the operator to configure a %s scanner, sending nothing', async (_, path) => {
    const wire = recorder();
    const result = await makeDevReview(wire.transport, (b, t) =>
      captureSnapshot(worker, b, t, path()),
    )({ ...input, base, tree });
    expect(result.status).toBe('needs-human');
    expect('reason' in result ? result.reason : '').toContain('CQ_AUTHOR_SNAPSHOT_SCANNER');
    expect(wire.sent).toEqual([]);
  });
});

describe('dev.review input schema', () => {
  it('publishes the exactly-one-of head or tree rule that the runtime enforces', () => {
    const published = z.toJSONSchema(DevReviewInputSchema, { io: 'input', unrepresentable: 'any' });
    const branches = (published as { oneOf?: { required: string[] }[] }).oneOf ?? [];
    expect(branches).toEqual([{ required: ['head'] }, { required: ['tree'] }]);
    const oid = (c: string) => c.repeat(40);
    for (const subject of [
      { head: oid('b') },
      { tree: oid('c') },
      { head: oid('b'), tree: oid('c') },
      {},
    ]) {
      const candidate = { ...input, base: oid('a'), ...subject };
      const matches = branches.filter((b) => b.required.every((k) => k in candidate)).length;
      expect(DevReviewInputSchema.safeParse(candidate).success).toBe(matches === 1);
    }
  });
});
