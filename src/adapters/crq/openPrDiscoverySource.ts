/** Inactive bounded forge and configured-git effects for open PR enrollment. */
import { ghJson, ghNameOk, makeGhRunner, type GhFn } from '../forge-github/gh.js';
import { branchPathFault } from '../../shared/refname.js';
import type {
  OpenPr,
  PrDiscoveryEffects,
  PrDiscoveryRepo,
} from '../../queue-runner/openPrDiscovery.js';
import type { RunGit } from './ledgerGit.js';
import { runGitIn } from './publishSource.js';

export interface OpenPrRepository extends PrDiscoveryRepo {
  readonly clone: string;
  readonly defaultBranch: string;
}
export interface OpenPrSourceOptions {
  readonly repos: readonly OpenPrRepository[];
  readonly associate: PrDiscoveryEffects['associate'];
  readonly ownRange: PrDiscoveryEffects['ownRange'];
  readonly event: PrDiscoveryEffects['event'];
  readonly gh?: GhFn;
  readonly git?: (repo: OpenPrRepository) => RunGit;
  readonly now?: () => Date;
}
/** tick.lock remains caller-owned. Association and repair proof are required, not guessed. */
export function openPrDiscoveryEffects(options: OpenPrSourceOptions): PrDiscoveryEffects {
  const configured = (requested: PrDiscoveryRepo): OpenPrRepository => {
    const repo = options.repos.find((candidate) => candidate === requested);
    const parts = repo?.repo.split('/') ?? [];
    if (
      !repo ||
      parts.length !== 2 ||
      !parts.every(ghNameOk) ||
      !repo.clone ||
      branchPathFault(repo.defaultBranch) !== null
    )
      throw new Error('invalid PR repository');
    return repo;
  };
  const git = (repo: OpenPrRepository) => options.git?.(repo) ?? runGitIn(repo.clone);
  const gh = options.gh ?? makeGhRunner({ timeoutMs: 30_000 });
  return {
    async list(requested) {
      const repo = configured(requested);
      const value: unknown = await ghJson(gh, [
        'pr',
        'list',
        '--repo',
        repo.repo,
        '--state',
        'open',
        '--limit',
        '200',
        '--json',
        'number,isDraft,baseRefName,headRefName,headRefOid',
      ]);
      if (!Array.isArray(value)) throw new Error('invalid PR inventory');
      return (value as unknown[]).map((v): OpenPr => {
        if (!v || typeof v !== 'object' || Array.isArray(v))
          throw new Error('invalid PR inventory');
        const row = v as Record<string, unknown>;
        if (
          !Number.isSafeInteger(row.number) ||
          (row.number as number) <= 0 ||
          typeof row.isDraft !== 'boolean' ||
          typeof row.baseRefName !== 'string' ||
          typeof row.headRefName !== 'string' ||
          typeof row.headRefOid !== 'string' ||
          branchPathFault(row.baseRefName) !== null ||
          branchPathFault(row.headRefName) !== null ||
          !/^[0-9a-f]{40}$/.test(row.headRefOid)
        )
          throw new Error('invalid PR inventory');
        return {
          number: row.number as number,
          draft: row.isDraft,
          base: row.baseRefName,
          headRef: row.headRefName,
          head: row.headRefOid,
        };
      });
    },
    async fetchDefault(requested) {
      const repo = configured(requested);
      const result = await git(repo)([
        'fetch',
        '--quiet',
        'origin',
        `+refs/heads/${repo.defaultBranch}:refs/remotes/origin/${repo.defaultBranch}`,
      ]);
      if (result.code !== 0) throw new Error('default branch unavailable');
    },
    async rangeBase(requested, pr) {
      const repo = configured(requested);
      if (
        !Number.isSafeInteger(pr.number) ||
        pr.number <= 0 ||
        !/^[0-9a-f]{40}$/.test(pr.head) ||
        branchPathFault(pr.base) !== null
      )
        throw new Error('invalid PR identity');
      const run = git(repo);
      const have = () => run(['cat-file', '-e', `${pr.head}^{commit}`]);
      if ((await have()).code !== 0) {
        await run([
          'fetch',
          '--quiet',
          'origin',
          `+refs/pull/${pr.number}/head:refs/remotes/pr/${pr.number}`,
        ]);
        if ((await have()).code !== 0) return null;
      }
      const result = await run(['merge-base', `origin/${pr.base}`, pr.head]);
      if (result.code !== 0) return null;
      const base = new TextDecoder().decode(result.stdout).trim();
      return /^[0-9a-f]{40}$/.test(base) ? base : null;
    },
    associate: options.associate,
    ownRange: options.ownRange,
    event: options.event,
    nowIso: () => (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}
