/** Host effects for receipt repair reconciliation. Caller owns tick.lock and queue persistence. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonNumber, JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { sourcePath } from '../../policy/crq/repairBinding.js';
import { mergeHeadEvidence } from '../../ops/crq/internal/mergeHeadEvidence.js';
import {
  ForgeBudget,
  RECONCILE_FORGE_REQUESTS,
  RECONCILE_FORGE_SECONDS,
} from '../../policy/crq/forgeBudget.js';
import type { CurrentRepairEffects } from '../../ops/crq/internal/reconcileCurrentRepair.js';
import { makeGhRunner, type GhFn } from '../forge-github/gh.js';
import { runGitIn } from './publishSource.js';
import type { RunGit } from './ledgerGit.js';

const JOB = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `inbox/<job>.json` finding source path, one per FIXED verdict (Python `source_path`). */
async function fixedAnchors(stateRoot: string, record: JsonObject): Promise<string[]> {
  const verdicts = record.get('verdicts');
  const anchors = new Set<string>();
  for (const verdict of Array.isArray(verdicts) ? verdicts : []) {
    if (!(verdict instanceof JsonObject) || verdict.get('verdict') !== 'FIXED') continue;
    const job = verdict.get('job');
    if (typeof job !== 'string' || !JOB.test(job) || job.includes('..'))
      throw new Error('invalid repair job id');
    const value = parseJsonValue(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readFile(join(stateRoot, 'repair', 'inbox', `${job}.json`)),
      ),
      { duplicates: 'last' },
    );
    if (!(value instanceof JsonObject)) throw new Error('repair job is not an object');
    const path = sourcePath(value.get('finding') ?? null);
    if (!path.ok) throw new Error('invalid repair source path');
    anchors.add(path.path);
  }
  return [...anchors];
}

export interface CurrentRepairSourceOptions {
  readonly stateRoot: string;
  readonly clone: string;
  readonly repo: string;
  readonly budget?: ForgeBudget;
  readonly gh?: GhFn;
  readonly runGit?: RunGit;
}

/** Bind the receipt, git and budgeted forge reads to the real runner state. */
export function fileCurrentRepairEffects(
  options: CurrentRepairSourceOptions,
): CurrentRepairEffects {
  const git = options.runGit ?? runGitIn(options.clone);
  const budget =
    options.budget ??
    new ForgeBudget({ requests: RECONCILE_FORGE_REQUESTS, seconds: RECONCILE_FORGE_SECONDS });
  return {
    async readReceipt(id) {
      if (!/^[0-9a-f]{64}$/.test(id)) return null;
      try {
        return await readFile(join(options.stateRoot, 'receipts', `${id}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async prInfo(number) {
      if (
        !(number instanceof JsonNumber) ||
        number.kind !== 'int' ||
        number.integer === null ||
        number.integer <= 0n
      )
        throw new Error('invalid repair PR number');
      const timeoutMs = Math.max(1, Math.ceil(budget.take() * 1000));
      const gh = options.gh ?? makeGhRunner({ timeoutMs });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const call = gh([
          'pr',
          'view',
          number.integer.toString(),
          '--repo',
          options.repo,
          '--json',
          'number,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeCommit,mergedAt',
        ]);
        const response = await Promise.race([
          call,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('forge read timed out')), timeoutMs);
          }),
        ]);
        if (response.code !== 0) throw new Error('forge read failed');
        const value = parseJsonValue(response.stdout, { duplicates: 'last' });
        if (!(value instanceof JsonObject)) throw new Error('forge response is not an object');
        return value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    targetRef(selector) {
      if (selector !== 'promoted-main' && selector !== 'merge-queue')
        throw new Error('unknown target selector');
      return 'origin/main';
    },
    async resolveRef(ref) {
      const call = await git(['rev-parse', ref]);
      if (call.code !== 0) throw new Error('target ref unavailable');
      const value = new TextDecoder('utf-8', { fatal: true }).decode(call.stdout).trim();
      if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('invalid target ref');
      return value;
    },
    async proveMergeTree(record, head, merge) {
      const publication = record.get('publication');
      if (!(publication instanceof JsonObject)) throw new Error('publication unavailable');
      const published = publication.get('head');
      if (typeof published !== 'string' || !published)
        throw new Error('publication head unavailable');
      // Nothing moved: no source is read, as in Python's early return.
      if (published === head && head === merge) return;
      const commits = publication.get('commits');
      await mergeHeadEvidence(
        {
          published,
          actual: head,
          merge,
          commits: Array.isArray(commits)
            ? commits.map((c) => (typeof c === 'string' ? c : ''))
            : [],
          anchors: await fixedAnchors(options.stateRoot, record),
        },
        git,
      );
    },
    async isAncestor(ancestor, descendant) {
      if (!/^[0-9a-f]{40}$/.test(ancestor) || !/^[0-9a-f]{40}$/.test(descendant))
        throw new Error('invalid ancestry operand');
      const call = await git(['merge-base', '--is-ancestor', ancestor, descendant]);
      // Git exits 1 only for "not an ancestor"; any other nonzero status (or a
      // null code) is a probe failure, not a negative answer, so the caller's
      // catch counts it as deferred instead of silently skipping the evidence.
      if (call.code === 0) return true;
      if (call.code === 1) return false;
      throw new Error(
        `git merge-base --is-ancestor failed with status ${call.code === null ? 'signal' : call.code}`,
      );
    },
  };
}
