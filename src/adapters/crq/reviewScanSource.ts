/** Inactive ordinary-review scanner binding. Caller holds tick.lock. */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { scanReviewDiff } from '../../queue-runner/reviewScan.js';
import type { ReviewPreparationEffects } from '../../queue-runner/reviewPreparation.js';
import { atomicWrite } from './atomic.js';
import { GitPool, gitCall } from './gitExec.js';
import { fileReviewGitleaks } from './reviewGitleaks.js';
import { matchReviewRegexBatch } from './reviewRegexMatcher.js';

/**
 * The run directory must already be allocated exclusively. The returned blocked
 * queue still needs saving by the lock holder after the blocked event. A crash
 * between event and save may replay it. Orphaned artifacts require reconciliation.
 */
export function fileOrdinaryReviewScanner(options: {
  stateRoot: string;
  primaryRepo: string;
  defaultRef: string;
  repositories: readonly { repo: string; clone: string; extraClasses: readonly string[] }[];
  pool: GitPool;
  path: string;
  scratchRoot: string;
}): ReviewPreparationEffects['scan'] {
  const gitleaks = fileReviewGitleaks({ path: options.path, scratchRoot: options.scratchRoot });
  const repository = (name: string) => {
    const entries = options.repositories.filter(
      (entry) => entry.repo.toLowerCase() === name.toLowerCase(),
    );
    if (entries.length !== 1 || !entries[0] || !isAbsolute(entries[0].clone))
      throw new Error('unconfigured or ambiguous scanner repository');
    return entries[0];
  };
  const readGit = async (clone: string, args: readonly string[]) => {
    const result = await gitCall(options.pool, clone, args);
    // gitCall can report a zero exit after an output overflow raced process exit.
    if (result.code !== 0 || result.stderr === 'output exceeded bound')
      throw new Error('review scan git unavailable');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    } catch {
      throw new Error('invalid review scan input encoding');
    }
  };
  return async ({ runId, repo, base, head }) => {
    if (
      !isAbsolute(options.stateRoot) ||
      !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(runId) ||
      runId === '.' ||
      runId === '..' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.defaultRef) ||
      ![base, head].every((oid) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
    )
      throw new Error('invalid review scan identity');
    const target = repository(repo);
    const primary = repository(options.primaryRepo);
    const runs = resolve(options.stateRoot, 'runs');
    const run = join(runs, runId);
    if (
      (await realpath(runs)) !== runs ||
      !(await lstat(run)).isDirectory() ||
      (await realpath(run)) !== run
    )
      throw new Error('invalid allocated review run directory');
    const artifact = join(run, 'secret-scan.json');
    try {
      await lstat(artifact);
      throw new Error('review scan artifact already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const patternsText = await readGit(primary.clone, [
      'show',
      `${options.defaultRef}:policy/denylist/patterns.yml`,
    ]);
    const diff = await readGit(target.clone, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--unified=0',
      base,
      head,
    ]);
    return scanReviewDiff(
      {
        patternsText,
        diff,
        base,
        head,
        foreign: repo.toLowerCase() !== options.primaryRepo.toLowerCase(),
        extraClasses: target.extraClasses,
        artifactPath: artifact,
      },
      {
        match: matchReviewRegexBatch,
        gitleaks,
        writeReport: (text) => atomicWrite(artifact, text),
      },
    );
  };
}
