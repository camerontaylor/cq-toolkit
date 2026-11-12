import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureSnapshot, snapshotHead } from '../../../src/ops/dev/internal/snapshot.js';

const exec = promisify(execFile);
// Fixture Git must never follow a caller's GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, env })).stdout.trim();

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
  it('bounds original decoded content at 3 MiB while retaining the legacy 4 MiB cap', async () => {
    const repo = join(root, 'content-bound');
    await exec('git', ['clone', '-q', '--no-hardlinks', worker, repo], { env });
    await writeFile(join(repo, 'file.txt'), Buffer.alloc(3 * 1024 * 1024, 120));
    await git(repo, 'add', 'file.txt');
    await git(
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'head',
    );
    const head = await git(repo, 'rev-parse', 'HEAD');
    const headTree = await git(repo, 'rev-parse', 'HEAD^{tree}');
    await expect(captureSnapshot(repo, base, headTree, accept, 30000, head)).rejects.toThrow(
      'snapshot content exceeds bound',
    );
    const legacy = await captureSnapshot(repo, base, headTree, accept);
    expect(Buffer.byteLength(JSON.stringify(legacy.snapshot))).toBeLessThan(5 * 1024 * 1024);
  });

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

  it.each([
    ['at the scan deadline', 'wait\n', 'scan refused'],
    ['after the scanner exits successfully', 'exit 0\n', null],
  ])('kills scanner descendants %s', async (_, tail, refusal) => {
    const marker = join(root, `late-marker-${++scanners}`);
    const forks = await scanner(`(sleep 2; touch "${marker}") &\n${tail}`);
    const capture = captureSnapshot(worker, base, tree, forks, 300);
    await (refusal
      ? expect(capture).rejects.toThrow(refusal)
      : expect(capture).resolves.toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await expect(readFile(marker)).rejects.toThrow();
  });
});
