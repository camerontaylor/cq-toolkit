import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateReviewRun,
  checkoutReviewWorktree,
  fileReviewPreparationEffects,
} from '../../../src/adapters/crq/reviewPreparation.js';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';
import { JsonNumber, JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { prepareOrdinaryReview } from '../../../src/queue-runner/reviewPreparation.js';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'crq-prepare-'));
  roots.push(root);
  const clone = join(root, 'clone');
  const wt = join(root, 'worktrees');
  await mkdir(clone);
  await mkdir(wt);
  await mkdir(join(root, 'runs'));
  const git = async (...args: string[]) =>
    (await exec('git', ['-C', clone, ...args])).stdout.trim();
  await git('init', '-q');
  await writeFile(join(clone, 'file.txt'), 'original\n');
  await git('add', 'file.txt');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'initial',
  );
  const head = await git('rev-parse', 'HEAD');
  return { root, clone, wt, head, git };
}
describe('review preparation filesystem', () => {
  it('reserves a run directory exclusively without touching prior artifacts', async () => {
    const { root } = await fixture();
    const date = new Date('2026-11-14T17:00:00Z');
    const id = await allocateReviewRun(root, 'pr-1', date);
    expect(id).toBe('pr-1-20261114T170000Z');
    await writeFile(join(root, 'runs', id, 'existing'), 'keep');
    await expect(allocateReviewRun(root, 'pr-1', date)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(root, 'runs', id, 'existing'), 'utf8')).toBe('keep');
  });
  it('checks out a pinned commit and refuses both path and branch collisions', async () => {
    const { root, clone, wt, head, git } = await fixture();
    const options = {
      clone,
      worktreeRoot: wt,
      prefix: 'crq-',
      runId: 'pr-1-20261114T170000Z',
      head,
      pool: new GitPool(),
    };
    const created = await checkoutReviewWorktree(options);
    expect(await readFile(join(created.path, 'file.txt'), 'utf8')).toBe('original\n');
    await writeFile(join(created.path, 'keep'), 'untouched');
    await expect(checkoutReviewWorktree(options)).rejects.toThrow('checkout refused');
    expect(await readFile(join(created.path, 'keep'), 'utf8')).toBe('untouched');
    const other = { ...options, runId: 'pr-2-20261114T170000Z' };
    await git('branch', `crq/wt-${other.runId}`, head);
    await expect(checkoutReviewWorktree(other)).rejects.toThrow('checkout refused');
    expect(await git('rev-parse', `crq/wt-${other.runId}`)).toBe(head);
    expect(root).toBeTruthy();
  });
  it('refuses an existing empty worktree directory', async () => {
    const { clone, wt, head } = await fixture();
    const runId = 'pr-3-20261114T170000Z';
    const path = join(wt, `crq-wt-${runId}`);
    await mkdir(path);
    await expect(
      checkoutReviewWorktree({
        clone,
        worktreeRoot: wt,
        prefix: 'crq-',
        runId,
        head,
        pool: new GitPool(),
      }),
    ).rejects.toThrow('path unavailable');
  });
  it('assembles injected scan and real checkout before fake launch', async () => {
    const { root, clone, wt, head } = await fixture();
    const order: string[] = [];
    const item = new JsonObject([
      ['id', 'pr-1'],
      ['kind', 'open'],
      ['state', 'pending'],
      ['repo', 'o/r'],
      ['pr', JsonNumber.int(1)],
    ]);
    const queue = new JsonObject([['items', [item]]]);
    const plan = new JsonObject([
      ['base', head],
      ['head', head],
      ['target', 'origin/main'],
      ['label', 'review'],
      ['cycle', JsonNumber.int(1)],
      ['branch', 'topic'],
    ]);
    const effects = fileReviewPreparationEffects({
      stateRoot: root,
      worktreeRoot: wt,
      prefix: 'crq-',
      repositories: [{ repo: 'o/r', clone }],
      pool: new GitPool(),
      now: () => new Date('2026-11-14T17:00:00Z'),
      scan: async () => {
        order.push('scan');
        return {
          clean: true,
          denylistHits: 0,
          gitleaksHits: 0,
          artifactPath: join(root, 'runs', 'pr-1', 'secret-scan.json'),
        };
      },
      blocked: async () => {},
      launch: {
        writeMeta: async (_id, meta) => {
          order.push('meta');
          expect(await readFile(join(String(meta.get('worktree')), 'file.txt'), 'utf8')).toBe(
            'original\n',
          );
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
    await prepareOrdinaryReview(
      queue,
      { itemIndex: 0, plan, repo: 'o/r', band: 'background' },
      effects,
    );
    expect(order).toEqual(['scan', 'meta', 'save', 'spawn', 'save']);
  });
  it('rejects traversal and noncanonical heads before running git', async () => {
    const { clone, wt } = await fixture();
    await expect(
      checkoutReviewWorktree({
        clone,
        worktreeRoot: wt,
        prefix: 'crq-',
        runId: '../unsafe',
        head: 'a'.repeat(40),
        pool: new GitPool(),
      }),
    ).rejects.toThrow('invalid checkout identity');
  });
});
