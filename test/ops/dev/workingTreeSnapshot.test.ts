import { readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { captureWorkingTree } from '../../../src/ops/dev/internal/snapshot.js';
import { makeManagedReviewSubmit } from '../../../src/ops/dev/managedReview.js';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { capturingScanner } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';
let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});
const privateDirectories = async () =>
  (await readdir(tmpdir())).filter((path) => path.startsWith('cq-working-tree-')).sort();
const indexBytes = async () =>
  readFile(repo.git('rev-parse', '--path-format=absolute', '--git-path', 'index').trim());

test('private index captures staged, final unstaged, untracked, deletion and rename; deterministic and isolated', async () => {
  const head = repo.git('rev-parse', 'HEAD').trim();
  await repo.write('staged.txt', 'index body\n');
  repo.git('add', 'staged.txt');
  await repo.write('staged.txt', 'final body\n');
  await repo.write('untracked.txt', 'new body\n');
  repo.git('mv', 'src/a.ts', 'src/renamed.ts');
  await rm(join(repo.root, 'README.md'));
  await repo.write('.cq/operational.json', 'excluded\n');
  const before = await indexBytes();
  const status = repo.git('status', '--porcelain=v1', '-uall');
  const directories = await privateDirectories();
  const captured = await captureWorkingTree(repo.root, head);
  expect(repo.git('show', `${captured.head}:staged.txt`).trim()).toBe('final body');
  expect(repo.git('show', `${captured.stagedTree}:staged.txt`).trim()).toBe('index body');
  expect(repo.git('show', `${captured.head}:untracked.txt`).trim()).toBe('new body');
  const files = repo.git('ls-tree', '-r', '--name-only', captured.head);
  expect(files).toContain('src/renamed.ts');
  expect(files).not.toContain('src/a.ts');
  expect(files).not.toContain('README.md');
  expect(files).not.toContain('.cq/');
  expect(repo.git('rev-parse', `${captured.head}^`).trim()).toBe(head);
  expect(await captureWorkingTree(repo.root, head)).toEqual(captured);
  expect(await indexBytes()).toEqual(before);
  expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(repo.git('status', '--porcelain=v1', '-uall')).toBe(status);
  expect(await privateDirectories()).toEqual(directories);
});

test('refused non-regular capture cleans private index without changing real index or HEAD', async () => {
  const head = repo.git('rev-parse', 'HEAD').trim();
  await symlink('README.md', join(repo.root, 'link'));
  const before = await indexBytes();
  const directories = await privateDirectories();
  await expect(captureWorkingTree(repo.root, head)).rejects.toThrow('non-regular');
  expect(await indexBytes()).toEqual(before);
  expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(await privateDirectories()).toEqual(directories);
});

test('staged reversal is separately scanned, but no final diff never dispatches or grants coverage', async () => {
  const effects = repoEffects(repo);
  const original = await readFile(join(repo.root, 'src/a.ts'), 'utf8');
  await repo.write('src/a.ts', 'export const staged = "hidden staged content";\n');
  repo.git('add', 'src/a.ts');
  await repo.write('src/a.ts', original);
  const before = await indexBytes();
  const scanner = capturingScanner();
  const transport = vi.fn(async () => {
    throw new Error('no queue request allowed');
  });
  const result = await makeDevReview({
    effects,
    scanSecrets: scanner,
    managedSubmit: makeManagedReviewSubmit(
      () => transport,
      async () => 'owner/repo',
    ),
  })({ repoRoot: repo.root, uncommitted: true });
  expect(result).toMatchObject({
    status: 'needs-human',
    reason: expect.stringContaining('no reviewable final working-tree diff') as unknown,
  });
  expect(scanner.seen.map(({ component }) => component)).toEqual([
    'staged:src/a.ts',
    'unstaged:src/a.ts',
  ]);
  expect(scanner.seen.every(({ text }) => text.includes('hidden staged content'))).toBe(true);
  expect(transport).not.toHaveBeenCalled();
  expect(effects.openLedger('feature/x').load().records).toHaveLength(0);
  expect(await indexBytes()).toEqual(before);
});

test('untracked bytes changed by the snapshot scanner refuse before admission and preserve index/HEAD', async () => {
  await repo.write('untracked.txt', 'scanned original body\n');
  const scannerPath = join(repo.root, '.git', 'snapshot-scanner');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    scannerPath,
    '#!/bin/sh\nprintf "changed body\\n" > "$1/untracked.txt"\nexit 0\n',
    { mode: 0o700 },
  );
  const before = await indexBytes();
  const head = repo.git('rev-parse', 'HEAD').trim();
  const effects = repoEffects(repo);
  const operations: string[] = [];
  const real = makeManagedReviewSubmit(
    () => async (raw) => {
      const wire = JSON.parse(raw) as { op: string };
      operations.push(wire.op);
      if (wire.op !== 'capabilities') throw new Error('must not admit changed work');
      return JSON.stringify({
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
      });
    },
    async () => 'owner/repo',
  );
  const result = await makeDevReview({
    effects,
    scanSecrets: capturingScanner(),
    managedSubmit: (input) => real({ ...input, scanner: scannerPath }),
  })({ repoRoot: repo.root });
  expect(result).toMatchObject({
    status: 'needs-human',
    reason: expect.stringContaining('working-tree contents changed') as unknown,
  });
  expect(operations).toEqual(['capabilities']);
  expect(effects.openLedger('feature/x').load().records).toHaveLength(0);
  expect(await indexBytes()).toEqual(before);
  expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head);
});

test('tracked symlink and file-to-directory changes use final tree without following links', async () => {
  await symlink('README.md', join(repo.root, 'tracked-link'));
  repo.commitAll('tracked symlink');
  const head = repo.git('rev-parse', 'HEAD').trim();
  await rm(join(repo.root, 'src/a.ts'));
  await repo.write('src/a.ts/child.txt', 'replacement directory body\n');
  const before = await indexBytes();
  const captured = await captureWorkingTree(repo.root, head);
  expect(repo.git('show', `${captured.head}:tracked-link`).trim()).toBe('README.md');
  expect(repo.git('ls-tree', captured.head, 'tracked-link')).toContain('120000');
  expect(repo.git('show', `${captured.head}:src/a.ts/child.txt`).trim()).toBe(
    'replacement directory body',
  );
  expect(await indexBytes()).toEqual(before);
});

test('skip-worktree paths refuse capture rather than inventing deletions', async () => {
  const head = repo.git('rev-parse', 'HEAD').trim();
  repo.git('update-index', '--skip-worktree', 'src/a.ts');
  await rm(join(repo.root, 'src/a.ts'));
  const before = await indexBytes();
  const directories = await privateDirectories();
  await expect(captureWorkingTree(repo.root, head)).rejects.toThrow('skip-worktree');
  expect(await indexBytes()).toEqual(before);
  expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(await privateDirectories()).toEqual(directories);
});

test('unpublished HEAD with uncommitted content refuses locally with a supported alternative', async () => {
  const head = repo.git('rev-parse', 'HEAD').trim();
  await repo.write('src/a.ts', 'export const a = 2;\n');
  const transport = vi.fn(async () => {
    throw new Error('no queue writes');
  });
  const result = await makeManagedReviewSubmit(
    () => transport,
    async () => 'owner/repo',
  )({
    cwd: repo.root,
    target: 'main',
    base: head,
    head,
    workingTree: 'uncommitted',
    scanner: '/bin/true',
  });
  expect(result).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining('use full scope') as unknown,
  });
  expect(transport).not.toHaveBeenCalled();
});
