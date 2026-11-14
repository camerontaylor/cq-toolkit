/** File and git effects for inactive push discovery. No call is installed in tick. */
import { join } from 'node:path';
import { branchPathFault } from '../../shared/refname.js';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import type { PushDiscoveryEffects, PushDiscoveryRepo } from '../../queue-runner/pushDiscovery.js';
import { atomicWrite } from './atomic.js';
import type { RunGit } from './ledgerGit.js';
import { runGitIn } from './publishSource.js';
import { loadQueueDocument, queueBytes } from './queueEffects.js';

export interface PushRepository extends PushDiscoveryRepo {
  readonly clone: string;
  readonly defaultBranch: string;
}
export interface PushDiscoverySourceOptions {
  readonly stateRoot: string;
  readonly repos: readonly PushRepository[];
  readonly event: PushDiscoveryEffects['event'];
  readonly git?: (repo: PushRepository) => RunGit;
  readonly now?: () => Date;
}
/** Caller holds tick.lock. Git is selected only from the supplied registry. */
export function filePushDiscoveryEffects(
  options: PushDiscoverySourceOptions,
): PushDiscoveryEffects & {
  loadQueue(): Promise<JsonObject>;
  saveQueue(queue: JsonObject): Promise<void>;
} {
  const configured = (requested: PushDiscoveryRepo): PushRepository => {
    const repo = options.repos.find((candidate) => candidate === requested);
    if (!repo || branchPathFault(repo.defaultBranch) !== null || !repo.clone)
      throw new Error('invalid push repository');
    return repo;
  };
  const execute = async (requested: PushDiscoveryRepo, args: readonly string[]) => {
    const repo = configured(requested);
    return (options.git?.(repo) ?? runGitIn(repo.clone))(args);
  };
  const output = async (requested: PushDiscoveryRepo, args: readonly string[]) => {
    const result = await execute(requested, args);
    if (result.code !== 0) throw new Error('git discovery failed');
    return new TextDecoder().decode(result.stdout).trim();
  };
  const clock = options.now ?? (() => new Date());
  return {
    async fetchTip(requested) {
      const repo = configured(requested);
      await output(repo, [
        'fetch',
        'origin',
        `+refs/heads/${repo.defaultBranch}:refs/remotes/origin/${repo.defaultBranch}`,
      ]);
      return output(repo, ['rev-parse', `refs/remotes/origin/${repo.defaultBranch}^{commit}`]);
    },
    async floorBase(requested) {
      const repo = configured(requested);
      if (!repo.floor) return null;
      const value = await output(repo, [
        'rev-list',
        '--first-parent',
        '-1',
        `--before=${repo.floor}`,
        `refs/remotes/origin/${repo.defaultBranch}`,
      ]);
      return value || null;
    },
    async isAncestor(repo, base, tip) {
      const result = await execute(repo, ['merge-base', '--is-ancestor', base, tip]);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new Error('git ancestry unavailable');
    },
    async commitTime(repo, tip) {
      const value = await output(repo, ['show', '-s', '--format=%ct', tip]);
      if (!/^[0-9]+$/.test(value)) throw new Error('invalid commit time');
      return Number(value);
    },
    nowSeconds: () => clock().getTime() / 1000,
    nowIso: () =>
      clock()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    event: options.event,
    loadQueue: () => loadQueueDocument(join(options.stateRoot, 'queue.json')),
    saveQueue: (queue) => atomicWrite(join(options.stateRoot, 'queue.json'), queueBytes(queue)),
  };
}
