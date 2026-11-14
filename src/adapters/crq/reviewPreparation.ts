/* Inactive preparation filesystem and non-destructive checkout bindings. */
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { GitPool, gitCall } from './gitExec.js';
import type { ReviewPreparationEffects } from '../../queue-runner/reviewPreparation.js';

function safePart(value: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
}
/** Exclusive Python-style run ID reservation. Existing run artifacts are never reused. */
export async function allocateReviewRun(
  stateRoot: string,
  itemId: string,
  now: Date,
): Promise<string> {
  if (!safePart(itemId) || !isAbsolute(stateRoot) || !Number.isFinite(now.getTime()))
    throw new Error('invalid run allocation');
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const runId = `${itemId}-${stamp}`;
  await mkdir(join(stateRoot, 'runs', runId));
  return runId;
}
/**
 * Safe divergence from Python: no remove, force, branch reset, or prune. An
 * ambiguous Git failure leaves any created artifacts for operator recovery.
 */
export async function checkoutReviewWorktree(options: {
  clone: string;
  worktreeRoot: string;
  prefix: string;
  runId: string;
  head: string;
  pool: GitPool;
}): Promise<{ path: string; branch: string }> {
  if (
    !isAbsolute(options.clone) ||
    !isAbsolute(options.worktreeRoot) ||
    !safePart(options.runId) ||
    !safePart(options.prefix) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.head)
  )
    throw new Error('invalid checkout identity');
  const root = resolve(options.worktreeRoot);
  if ((await realpath(root)) !== root)
    throw new Error('worktree root must not resolve through symlinks');
  const path = join(root, `${options.prefix}wt-${options.runId}`);
  const branch = `crq/wt-${options.runId}`;
  // Git accepts an existing empty directory, so claim this path exclusively
  // before invoking Git rather than accidentally taking over somebody's path.
  try {
    await mkdir(path);
  } catch (error) {
    throw new Error('worktree checkout refused: path unavailable', { cause: error });
  }
  const result = await gitCall(
    options.pool,
    options.clone,
    [
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      'worktree',
      'add',
      '--quiet',
      '-b',
      branch,
      '--',
      path,
      options.head,
    ],
    { skipLfsSmudge: true },
  );
  if (result.code !== 0)
    throw new Error(
      `worktree checkout refused: ${result.stderr.trim().slice(0, 200) || 'git failed'}`,
    );
  return { path, branch };
}

/** Bind only allocation and checkout. A real, parity-complete scanner is mandatory. */
export function fileReviewPreparationEffects(options: {
  stateRoot: string;
  worktreeRoot: string;
  prefix: string;
  repositories: readonly { repo: string; clone: string }[];
  pool: GitPool;
  scan: ReviewPreparationEffects['scan'];
  blocked: ReviewPreparationEffects['blocked'];
  launch: ReviewPreparationEffects['launch'];
  now?: () => Date;
}): ReviewPreparationEffects {
  const now = options.now ?? (() => new Date());
  const cloneFor = (repo: string): string => {
    const matches = options.repositories.filter(
      (entry) => entry.repo.toLowerCase() === repo.toLowerCase(),
    );
    if (matches.length !== 1 || !matches[0] || !isAbsolute(matches[0].clone))
      throw new Error('unconfigured or ambiguous review repository');
    return matches[0].clone;
  };
  return {
    allocate: (id) => allocateReviewRun(options.stateRoot, id, now()),
    scan: async (request) => {
      cloneFor(request.repo);
      return options.scan(request);
    },
    blocked: options.blocked,
    checkout: ({ runId, repo, head }) =>
      checkoutReviewWorktree({
        clone: cloneFor(repo),
        worktreeRoot: options.worktreeRoot,
        prefix: options.prefix,
        runId,
        head,
        pool: options.pool,
      }),
    nowIso: () => `${now().toISOString().slice(0, 19)}Z`,
    launch: options.launch,
  };
}
