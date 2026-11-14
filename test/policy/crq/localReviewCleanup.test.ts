import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { GitPool, type GitResult } from '../../../src/adapters/crq/gitExec.js';
import {
  cleanupLocalReviewWorktree,
  localReviewCleanup,
} from '../../../src/adapters/crq/localReviewCleanup.js';
import { createLocalReviewHarvestCaller } from '../../../src/adapters/crq/localReviewHarvestCaller.js';
function doc(value: unknown): JsonObject {
  const out = parseJsonValue(JSON.stringify(value));
  if (!(out instanceof JsonObject)) throw new Error('invalid');
  return out;
}
const repo = 'camerontaylor/cq-toolkit';
const id = 'local-1-20261114T120000Z';
const branch = `crq/wt-${id}`;
const head = 'a'.repeat(40);
function fixture(root: string, sha = head) {
  const path = join(root, `queue-wt-${id}`);
  const config = doc({
    worktree_root: root,
    worktree_prefix: 'queue-',
    clone: join(root, 'clone'),
  });
  const item = doc({
    id: 'local-1',
    kind: 'local-review',
    run: { run_id: id },
    identity_inputs: { repo, head_commit: sha },
  });
  const meta = doc({
    run_id: id,
    item_id: 'local-1',
    repo,
    head: sha,
    worktree: path,
    wt_branch: branch,
  });
  return { path, config, item, meta, options: { config, runnerRepo: repo, pool: new GitPool() } };
}
const ok = (stdout: string): GitResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: '' });
const listing = (path: string, sha = head, ref = `refs/heads/${branch}`) =>
  `worktree ${path}\0HEAD ${sha}\0branch ${ref}\0\0`;
describe('safe local review worktree cleanup', () => {
  it.each([false, true])('assembles real harvest with dirty=%s', async (dirty) => {
    const root = await mkdtemp(join(tmpdir(), 'crq-caller-'));
    try {
      const clone = join(root, 'clone');
      await mkdir(clone);
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', clone, ...args], {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: root,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
          },
        }).trim();
      git('init', '-q');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      );
      const sha = git('rev-parse', 'HEAD');
      const f = fixture(root, sha);
      git('worktree', 'add', '-q', '-b', branch, f.path, 'HEAD');
      if (dirty) await writeFile(join(f.path, 'untracked.txt'), 'retain');
      const digest = 'b'.repeat(64);
      const profile = { adapter: 'coderabbit-cli', revision: 'v1', flags: [] };
      const identity = {
        v: 1,
        repo,
        base_commit: sha,
        base_tree: sha,
        head_commit: sha,
        head_tree: sha,
        scope: 'full-diff',
        projection: 'full-diff',
        config_digest: digest,
        profile: { adapter: 'coderabbit-cli', revision: 'v1' },
      };
      const queue = doc({
        items: [
          {
            id: 'local-1',
            kind: 'local-review',
            state: 'reviewing',
            run: { run_id: id },
            identity: digest,
            identity_inputs: identity,
            profile,
            observers: [],
          },
        ],
      });
      const item = (queue.get('items') as JsonObject[])[0]!;
      const state = join(root, 'state');
      const dir = join(state, 'runs', id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'meta.json'),
        JSON.stringify({
          run_id: id,
          item_id: 'local-1',
          repo,
          head: sha,
          worktree: f.path,
          wt_branch: branch,
          label: 'review',
          base: sha,
        }),
      );
      await writeFile(join(dir, 'exit.json'), '{"exit":0,"ended_at":"2026-11-14T12:00:00Z"}');
      await writeFile(
        join(dir, 'review.ndjson'),
        '{"type":"complete","status":"review_completed"}\n',
      );
      await writeFile(
        join(dir, 'review.pid'),
        JSON.stringify({
          run_id: id,
          pid: 2147483647,
          pgid: 2147483647,
          sid: 2147483647,
          group_owner: 'foreground-v1',
        }),
      );
      let saved = queue;
      const caller = createLocalReviewHarvestCaller({
        stateRoot: state,
        runnerRepo: repo,
        config: f.config,
        pool: new GitPool(),
        saveQueue: async (q) => {
          saved = q;
        },
        rollout: async () => ({ durableArtifactRoot: join(root, 'artifacts') }),
        defaultBackoffMinutes: 5,
        now: () => new Date('2026-11-14T12:00:00Z'),
      });
      const result = await caller(queue, item, false);
      expect(result.queue).toBe(saved);
      expect((result.queue.get('items') as JsonObject[])[0]!.get('publication_reason')).toBe(
        'publication-spooled',
      );
      const events = await readFile(join(state, 'events.jsonl'), 'utf8');
      expect(events).toContain('review_finished');
      if (dirty) {
        expect(events).toContain('local_review_cleanup_failed');
        expect(await readFile(join(f.path, 'untracked.txt'), 'utf8')).toBe('retain');
        expect(git('worktree', 'list', '--porcelain')).toContain(f.path);
      } else {
        expect(events).not.toContain('local_review_cleanup_failed');
        expect(git('worktree', 'list', '--porcelain')).not.toContain(f.path);
      }
      expect(git('rev-parse', `refs/heads/${branch}`)).toBe(sha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('removes an actually registered disposable worktree but retains its branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-cleanup-'));
    try {
      const clone = join(root, 'clone');
      await mkdir(clone);
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', clone, ...args], {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: root,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
          },
        }).trim();
      git('init', '-q');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      );
      const f = fixture(root, git('rev-parse', 'HEAD'));
      git('worktree', 'add', '-q', '-b', branch, f.path, 'HEAD');
      await writeFile(join(f.path, 'untracked.txt'), 'preserve me');
      await expect(localReviewCleanup(f.options)(f.item, f.meta)).rejects.toThrow();
      expect(await readFile(join(f.path, 'untracked.txt'), 'utf8')).toBe('preserve me');
      await unlink(join(f.path, 'untracked.txt'));
      await localReviewCleanup(f.options)(f.item, f.meta);
      expect(git('worktree', 'list', '--porcelain')).not.toContain(f.path);
      expect(git('rev-parse', `refs/heads/${branch}`)).toBe(f.meta.get('head'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses mismatched run, branch, path and repository before git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-cleanup-'));
    try {
      const f = fixture(root);
      await mkdir(f.path);
      const calls: string[][] = [];
      const git = async (_cwd: string, args: readonly string[]) => {
        calls.push([...args]);
        return ok(listing(f.path));
      };
      for (const bad of [
        doc({
          run_id: 'wrong',
          item_id: 'local-1',
          repo,
          head,
          worktree: f.path,
          wt_branch: branch,
        }),
        doc({ run_id: id, item_id: 'local-1', repo, head, worktree: f.path, wt_branch: 'main' }),
        doc({ run_id: id, item_id: 'local-1', repo, head, worktree: root, wt_branch: branch }),
        doc({
          run_id: id,
          item_id: 'local-1',
          repo: 'foreign/repo',
          head,
          worktree: f.path,
          wt_branch: branch,
        }),
      ])
        await expect(cleanupLocalReviewWorktree(f.options, f.item, bad, git)).rejects.toThrow();
      expect(calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses mismatched registry proof without removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-cleanup-'));
    try {
      const f = fixture(root);
      await mkdir(f.path);
      const calls: string[][] = [];
      const git = async (_cwd: string, args: readonly string[]) => {
        calls.push([...args]);
        return ok(listing(f.path, 'b'.repeat(40)));
      };
      await expect(cleanupLocalReviewWorktree(f.options, f.item, f.meta, git)).rejects.toThrow(
        'registry ownership mismatch',
      );
      expect(calls).toEqual([['worktree', 'list', '--porcelain', '-z']]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses a symlink even when its name matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-cleanup-'));
    try {
      const f = fixture(root);
      const target = join(root, 'target');
      await mkdir(target);
      await symlink(target, f.path);
      await expect(
        cleanupLocalReviewWorktree(f.options, f.item, f.meta, async () => {
          throw new Error('unexpected git');
        }),
      ).rejects.toThrow('not a directory');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
