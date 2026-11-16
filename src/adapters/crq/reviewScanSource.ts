/** Inactive ordinary-review scanner binding. Caller holds tick.lock. */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pythonUnicode16Space } from '../../policy/crq/pythonUnicode16.js';
import { HARDENED_DIFF_FLAGS } from '../../shared/gitHarden.js';
import { scanReviewDiff } from '../../queue-runner/reviewScan.js';
import type { ReviewPreparationEffects } from '../../queue-runner/reviewPreparation.js';
import { atomicWrite } from './atomic.js';
import { GitPool, gitCall, type GitResult } from './gitExec.js';
import { fileReviewGitleaks } from './reviewGitleaks.js';
import { matchReviewRegexBatch } from './reviewRegexMatcher.js';

/** Match Python text-mode universal newlines and str.strip, after rejecting truncated output. */
export function decodeReviewScanGit(result: GitResult): string {
  if (result.code !== 0 || result.stderr === 'output exceeded bound')
    throw new Error('review scan git unavailable');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(result.stdout)
      .replace(/\r\n?/g, '\n');
  } catch {
    throw new Error('invalid review scan input encoding');
  }
  let start = 0;
  let end = text.length;
  // Every Unicode 16 whitespace code point is in the BMP.
  while (start < end && pythonUnicode16Space(text.charCodeAt(start))) start++;
  while (end > start && pythonUnicode16Space(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

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
    // An exit-0 overflow can race process exit. Never accept emptied truncated output.
    return decodeReviewScanGit(await gitCall(options.pool, clone, args));
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
    // Safer than Python's ordinary diff: never execute textconv or omit binary content.
    const diff = await readGit(target.clone, [
      'diff',
      ...HARDENED_DIFF_FLAGS,
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
