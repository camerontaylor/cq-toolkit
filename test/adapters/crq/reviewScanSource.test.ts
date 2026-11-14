import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { fileOrdinaryReviewScanner } from '../../../dist/adapters/crq/reviewScanSource.js';
import { GitPool } from '../../../dist/adapters/crq/gitExec.js';
import { fileReviewPreparationEffects } from '../../../src/adapters/crq/reviewPreparation.js';
import { GitPool as SourceGitPool } from '../../../src/adapters/crq/gitExec.js';
import { JsonNumber, JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { prepareOrdinaryReview } from '../../../src/queue-runner/reviewPreparation.js';
import type { fileOrdinaryReviewScanner as ScannerFactory } from '../../../src/adapters/crq/reviewScanSource.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'crq-scan-source-'));
  roots.push(root);
  const clone = join(root, 'clone');
  const worktrees = join(root, 'worktrees');
  const bin = join(root, 'bin');
  await Promise.all([mkdir(clone), mkdir(worktrees), mkdir(bin), mkdir(join(root, 'runs'))]);
  const git = async (...args: string[]) =>
    (await exec('git', ['-C', clone, ...args])).stdout.trim();
  await git('init', '-q');
  await mkdir(join(clone, 'policy', 'denylist'), { recursive: true });
  await writeFile(
    join(clone, 'policy', 'denylist', 'patterns.yml'),
    await readFile(new URL('../../../policy/denylist/patterns.yml', import.meta.url)),
  );
  await writeFile(join(clone, 'a.env'), 'first\n');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  const base = await git('rev-parse', 'HEAD');
  await writeFile(join(clone, 'a.env'), 'unique-nonsecret-payload\n');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'head',
  );
  const head = await git('rev-parse', 'HEAD');
  const foreign = join(root, 'foreign');
  await exec('git', ['clone', '-q', clone, foreign]);
  await writeFile(join(clone, 'policy', 'denylist', 'patterns.yml'), 'not the committed policy');
  const settings = {
    stateRoot: root,
    primaryRepo: 'o/r',
    defaultRef: base,
    repositories: [
      { repo: 'o/r', clone, extraClasses: [] },
      { repo: 'other/r', clone: foreign, extraClasses: [] },
    ],
    path: bin,
    scratchRoot: root,
  } satisfies Omit<Parameters<typeof ScannerFactory>[0], 'pool'>;
  const options = { ...settings, pool: new GitPool() };
  return { root, clone, worktrees, bin, base, head, options, git };
}

describe('inactive ordinary review scanner file binding', () => {
  it('scans target Git diff using primary committed policy and persists redacted blocked result before event', async () => {
    const f = await fixture();
    const scan = fileOrdinaryReviewScanner(f.options);
    const item = new JsonObject([
      ['id', 'pr-1'],
      ['kind', 'open'],
      ['state', 'pending'],
      ['repo', 'other/r'],
      ['pr', JsonNumber.int(1)],
    ]);
    const queue = new JsonObject([['items', [item]]]);
    const plan = new JsonObject([
      ['base', f.base],
      ['head', f.head],
      ['target', 'origin/main'],
      ['label', 'review'],
      ['cycle', JsonNumber.int(1)],
      ['branch', 'topic'],
    ]);
    const order: string[] = [];
    const effects = fileReviewPreparationEffects({
      stateRoot: f.root,
      worktreeRoot: f.worktrees,
      prefix: 'crq-',
      repositories: f.options.repositories,
      pool: new SourceGitPool(),
      now: () => new Date('2026-11-14T17:00:00Z'),
      scan,
      blocked: async () => {
        order.push('blocked');
        const text = await readFile(
          join(f.root, 'runs', 'pr-1-20261114T170000Z', 'secret-scan.json'),
          'utf8',
        );
        expect(text).not.toContain('unique-nonsecret-payload');
        expect(JSON.parse(text)).toMatchObject({
          gitleaks: 'not-run',
          denylist_hits: [
            { rule: 'class:key-material-env', diff_line: 6 },
            { rule: 'class:key-material-env', diff_line: 7 },
          ],
        });
      },
      launch: {
        writeMeta: async () => {
          order.push('meta');
        },
        workStarted: async () => {},
        saveQueue: async () => {
          order.push('save');
        },
        spawn: async () => {
          order.push('spawn');
          return 1;
        },
        event: async () => {},
        nowIso: () => '2026-11-14T17:00:00Z',
      },
    });
    const result = await prepareOrdinaryReview(
      queue,
      { itemIndex: 0, plan, repo: 'other/r', band: 'background' },
      effects,
    );
    expect(result.outcome).toBe('blocked');
    expect(order).toEqual(['blocked']);
    expect(await readdir(f.worktrees)).toEqual([]);
    expect((result.queue.get('items') as JsonObject[])[0]?.get('state')).toBe('blocked');
    expect(item.get('state')).toBe('pending');
  });
  it('writes a clean report before checkout, reservation and fake spawn', async () => {
    const f = await fixture();
    const item = new JsonObject([
      ['id', 'pr-2'],
      ['kind', 'delta'],
      ['state', 'pending'],
      ['repo', 'o/r'],
      ['pr', JsonNumber.int(2)],
    ]);
    const queue = new JsonObject([['items', [item]]]);
    const plan = new JsonObject([
      ['base', f.base],
      ['head', f.base],
      ['target', 'origin/main'],
      ['label', 'review'],
      ['cycle', JsonNumber.int(1)],
      ['branch', 'topic'],
    ]);
    const order: string[] = [];
    const effects = fileReviewPreparationEffects({
      stateRoot: f.root,
      worktreeRoot: f.worktrees,
      prefix: 'crq-',
      repositories: f.options.repositories,
      pool: new SourceGitPool(),
      now: () => new Date('2026-11-14T17:00:00Z'),
      scan: fileOrdinaryReviewScanner(f.options),
      blocked: async () => {
        throw new Error('unexpected refusal');
      },
      launch: {
        writeMeta: async (_id, meta) => {
          const report: unknown = JSON.parse(
            await readFile(
              join(f.root, 'runs', 'pr-2-20261114T170000Z', 'secret-scan.json'),
              'utf8',
            ),
          );
          expect(report).toMatchObject({ gitleaks: 'not-run', denylist_hits: [] });
          expect(await readFile(join(String(meta.get('worktree')), 'a.env'), 'utf8')).toBe(
            'first\n',
          );
          order.push('meta');
        },
        workStarted: async () => {},
        saveQueue: async () => {
          order.push('save');
        },
        spawn: async () => {
          order.push('spawn');
          return 123;
        },
        event: async () => {},
        nowIso: () => '2026-11-14T17:00:00Z',
      },
    });
    const result = await prepareOrdinaryReview(
      queue,
      { itemIndex: 0, plan, repo: 'o/r', band: 'background' },
      effects,
    );
    expect(result.outcome).toBe('launched');
    expect(order).toEqual(['meta', 'save', 'spawn', 'save']);
  });
  it('runs a fake gitleaks on clean diff and refuses a pre-existing artifact', async () => {
    const f = await fixture();
    await writeFile(
      join(f.bin, 'gitleaks'),
      '#!/bin/sh\nwhile [ "$1" != "--report-path" ]; do shift; done\nIFS= read -r value || :\nprintf "[]" > "$2"\n',
    );
    await chmod(join(f.bin, 'gitleaks'), 0o755);
    await mkdir(join(f.root, 'runs', 'run-1'));
    const scan = fileOrdinaryReviewScanner(f.options);
    const request = { runId: 'run-1', repo: 'o/r', base: f.base, head: f.base };
    expect(await scan(request)).toMatchObject({ clean: true, denylistHits: 0, gitleaksHits: 0 });
    const text = await readFile(join(f.root, 'runs', 'run-1', 'secret-scan.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ gitleaks: 'exit 0' });
    await expect(scan(request)).rejects.toThrow('artifact already exists');
    expect(await readFile(join(f.root, 'runs', 'run-1', 'secret-scan.json'), 'utf8')).toBe(text);
  });
  it('refuses malformed gitleaks output without writing a report', async () => {
    const f = await fixture();
    await writeFile(
      join(f.bin, 'gitleaks'),
      '#!/bin/sh\nwhile [ "$1" != "--report-path" ]; do shift; done\nIFS= read -r value || :\nprintf "not-json" > "$2"\n',
    );
    await chmod(join(f.bin, 'gitleaks'), 0o755);
    await mkdir(join(f.root, 'runs', 'run-1'));
    await expect(
      fileOrdinaryReviewScanner(f.options)({
        runId: 'run-1',
        repo: 'o/r',
        base: f.base,
        head: f.base,
      }),
    ).rejects.toThrow('review gitleaks unavailable');
    await expect(readFile(join(f.root, 'runs', 'run-1', 'secret-scan.json'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });
  it('rejects invalid UTF-8 in the Git patch without a report', async () => {
    const f = await fixture();
    await writeFile(join(f.clone, 'invalid.txt'), Buffer.from([0xff, 0x0a]));
    await f.git('add', 'invalid.txt');
    await f.git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'invalid',
    );
    const head = await f.git('rev-parse', 'HEAD');
    await mkdir(join(f.root, 'runs', 'run-1'));
    await expect(
      fileOrdinaryReviewScanner(f.options)({ runId: 'run-1', repo: 'o/r', base: f.base, head }),
    ).rejects.toThrow('invalid review scan input encoding');
    await expect(readFile(join(f.root, 'runs', 'run-1', 'secret-scan.json'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });
  it('rejects oversized diffs before producing an artifact', async () => {
    const f = await fixture();
    await writeFile(join(f.clone, 'large.txt'), `${'x'.repeat(7 * 1024 * 1024)}\n`);
    await f.git('add', 'large.txt');
    await f.git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'large',
    );
    const head = await f.git('rev-parse', 'HEAD');
    await mkdir(join(f.root, 'runs', 'run-1'));
    await expect(
      fileOrdinaryReviewScanner(f.options)({ runId: 'run-1', repo: 'o/r', base: f.base, head }),
    ).rejects.toThrow('review scan git unavailable');
    await expect(readFile(join(f.root, 'runs', 'run-1', 'secret-scan.json'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });
  it('fails closed on unknown foreign classes, invalid policy, and symlinked run directories', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'runs', 'run-1'));
    const request = { runId: 'run-1', repo: 'other/r', base: f.base, head: f.head };
    const withUnknown = {
      ...f.options,
      repositories: f.options.repositories.map((r) =>
        r.repo === 'other/r' ? { ...r, extraClasses: ['missing-rule'] } : r,
      ),
    };
    const duplicate = {
      ...f.options,
      repositories: [...f.options.repositories, f.options.repositories[0]!],
    };
    await expect(fileOrdinaryReviewScanner(duplicate)(request)).rejects.toThrow(
      'ambiguous scanner repository',
    );
    await expect(fileOrdinaryReviewScanner(withUnknown)(request)).rejects.toThrow(
      'unknown scan class',
    );
    await expect(
      fileOrdinaryReviewScanner({ ...f.options, defaultRef: 'missing' })(request),
    ).rejects.toThrow('review scan git unavailable');
    await symlink(join(f.root, 'runs', 'run-1'), join(f.root, 'runs', 'run-link'));
    await expect(
      fileOrdinaryReviewScanner(f.options)({ ...request, runId: 'run-link' }),
    ).rejects.toThrow('invalid allocated review run directory');
  });
});
