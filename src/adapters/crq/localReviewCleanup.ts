import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { LocalReviewCleanupError } from '../../ops/crq/internal/localReviewExit.js';
import { GitPool, gitCall, type GitResult } from './gitExec.js';

/** Cleanup refuses unverifiable ownership rather than following Python's permissive fallbacks. */
export interface LocalCleanupOptions {
  config: JsonObject;
  runnerRepo: string;
  pool: GitPool;
}
type Git = (cwd: string, args: readonly string[]) => Promise<GitResult>;

function refuse(reason: string): never {
  throw new LocalReviewCleanupError(reason);
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) return refuse(`missing ${label}`);
  return value;
}
function cloneFor(config: JsonObject, primary: string, repo: string): string {
  if (primary.toLowerCase() === repo.toLowerCase()) return text(config.get('clone'), 'clone');
  const repos = config.get('repos');
  if (!Array.isArray(repos)) return refuse('unconfigured review repository');
  const matches = repos.filter(
    (entry) =>
      entry instanceof JsonObject &&
      typeof entry.get('repo') === 'string' &&
      (entry.get('repo') as string).toLowerCase() === repo.toLowerCase(),
  );
  if (matches.length !== 1 || !(matches[0] instanceof JsonObject))
    return refuse('unconfigured or ambiguous review repository');
  return text(matches[0].get('clone'), 'clone');
}
function registry(bytes: Uint8Array): Map<string, { head: string; branch: string | null }> {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('invalid worktree registry');
  }
  if (!decoded.endsWith('\0\0')) return refuse('invalid worktree registry');
  const records = new Map<string, { head: string; branch: string | null }>();
  for (const record of decoded.slice(0, -2).split('\0\0')) {
    const fields = record.split('\0');
    if (!fields[0]?.startsWith('worktree ')) return refuse('invalid worktree registry');
    const path = fields[0].slice(9);
    const head = fields.filter((v) => v.startsWith('HEAD '));
    const branch = fields.filter((v) => v.startsWith('branch '));
    if (!path || head.length !== 1 || branch.length > 1 || records.has(path))
      return refuse('invalid worktree registry');
    records.set(path, {
      head: head[0]!.slice(5),
      branch: branch.length ? branch[0]!.slice(7) : null,
    });
  }
  return records;
}

/** Internal injectable seam for deterministic tests; callers must hold the existing tick lock. */
export async function cleanupLocalReviewWorktree(
  options: LocalCleanupOptions,
  item: JsonObject,
  meta: JsonObject,
  git: Git,
): Promise<void> {
  const run = item.get('run');
  const facts = item.get('identity_inputs');
  if (!(run instanceof JsonObject) || !(facts instanceof JsonObject))
    return refuse('missing run ownership');
  const id = text(run.get('run_id'), 'run id');
  const itemId = text(item.get('id'), 'item id');
  const repo = text(facts.get('repo'), 'repository');
  const head = text(facts.get('head_commit'), 'head');
  if (
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id) ||
    !id.startsWith(`${itemId}-`) ||
    meta.get('run_id') !== id ||
    meta.get('item_id') !== itemId ||
    meta.get('repo') !== repo ||
    meta.get('head') !== head ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)
  )
    return refuse('run ownership mismatch');
  const root = text(options.config.get('worktree_root'), 'worktree root');
  const prefix = text(options.config.get('worktree_prefix'), 'worktree prefix');
  if (!isAbsolute(root) || /[/\\\0]/.test(prefix) || prefix === '.' || prefix === '..')
    return refuse('invalid worktree configuration');
  const name = `${prefix}wt-${id}`;
  const expected = join(resolve(root), name);
  const branch = `crq/wt-${id}`;
  if (meta.get('worktree') !== expected || meta.get('wt_branch') !== branch)
    return refuse('worktree path or branch mismatch');
  const clone = cloneFor(options.config, options.runnerRepo, repo);
  if (!isAbsolute(clone)) return refuse('clone is not absolute');
  const stat = await lstat(expected);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return refuse('worktree is not a directory');
  const rootReal = await realpath(root);
  if ((await realpath(expected)) !== join(rootReal, name))
    return refuse('worktree path resolves outside root');
  const call = async (args: readonly string[]): Promise<Uint8Array> => {
    const result = await git(clone, args);
    if (result.code !== 0)
      return refuse(result.stderr.trim().slice(0, 200) || 'git cleanup failed');
    return result.stdout;
  };
  const records = registry(await call(['worktree', 'list', '--porcelain', '-z']));
  const record = records.get(expected);
  if (!record || record.head !== head || record.branch !== `refs/heads/${branch}`)
    return refuse('worktree registry ownership mismatch');
  // No force, recursive fallback or global prune: Git refuses dirty, locked or
  // unregistered worktrees. The per-run branch is intentionally retained.
  await call(['worktree', 'remove', '--', expected]);
}

/** Production binding uses the bounded, environment-hardened Git adapter. */
export function localReviewCleanup(
  options: LocalCleanupOptions,
): (item: JsonObject, meta: JsonObject) => Promise<void> {
  return (item, meta) =>
    cleanupLocalReviewWorktree(options, item, meta, (cwd, args) =>
      gitCall(options.pool, cwd, args),
    );
}
