/** File and bounded forge bindings for inactive deferred-author recovery. */
import { join } from 'node:path';
import { ghJson, GhError, makeGhRunner, type GhFn } from '../forge-github/gh.js';
import { branchPathFault } from '../../shared/refname.js';
import { ForgeBudget, RefreshExhausted } from '../../policy/crq/forgeBudget.js';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import {
  DeferredIdentityError,
  DeferredUnavailableError,
  type DeferredRefreshEffects,
} from '../../queue-runner/deferredRefresh.js';
import { atomicWrite } from './atomic.js';
import { loadQueueDocument, queueBytes, verifyDeferredSource } from './queueEffects.js';

export interface DeferredSourceOptions {
  readonly repo: string;
  readonly stateRoot: string;
  readonly budget: ForgeBudget;
  readonly gh?: GhFn;
}

/** Caller owns tick.lock; the shared budget is also passed to merged discovery. */
export function fileDeferredRefreshEffects(
  options: DeferredSourceOptions,
): DeferredRefreshEffects & {
  loadQueue(): Promise<JsonObject>;
  saveQueue(queue: JsonObject): Promise<void>;
} {
  const budgeted: GhFn = async (args) => {
    const timeoutMs = Math.max(1, Math.ceil(options.budget.take() * 1000));
    if (!options.gh) return makeGhRunner({ timeoutMs })(args);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.gh(args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DeferredUnavailableError('forge timeout')),
            timeoutMs,
          );
        }),
      ]);
    } catch {
      throw new DeferredUnavailableError('forge unavailable');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const verify = async (repo: string, pr: number): Promise<JsonObject> => {
    if (
      repo !== options.repo ||
      !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      !Number.isSafeInteger(pr) ||
      pr <= 0
    )
      throw new DeferredIdentityError('invalid deferred source');
    try {
      return await verifyDeferredSource(budgeted, repo, pr);
    } catch (error) {
      if (error instanceof RefreshExhausted || error instanceof DeferredUnavailableError)
        throw error;
      if (error instanceof GhError) throw new DeferredUnavailableError('forge unavailable');
      throw new DeferredIdentityError('invalid forge identity');
    }
  };
  return {
    mayContinue: () => options.budget.available(),
    verify,
    async find(repo, producer, head, target, limit) {
      if (
        repo !== options.repo ||
        !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
        !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/.test(producer) ||
        !/^[0-9a-f]{40}$/.test(head) ||
        branchPathFault(target) !== null ||
        limit !== 2
      )
        throw new DeferredIdentityError('invalid deferred binding');
      let data: unknown;
      try {
        data = await ghJson(budgeted, [
          'api',
          '--method',
          'GET',
          'search/issues',
          '-f',
          `q=repo:${repo} is:pr author:${producer} base:${target} ${head}`,
          '-f',
          'per_page=2',
          '-f',
          'page=1',
        ]);
      } catch (error) {
        if (error instanceof RefreshExhausted || error instanceof DeferredUnavailableError)
          throw error;
        throw new DeferredUnavailableError('forge search unavailable');
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data))
        throw new DeferredUnavailableError('incomplete search');
      const result = data as Record<string, unknown>;
      if (
        result.incomplete_results !== false ||
        !Number.isSafeInteger(result.total_count) ||
        (result.total_count as number) < 0 ||
        (result.total_count as number) > 2 ||
        !Array.isArray(result.items) ||
        result.items.length !== result.total_count
      )
        throw new DeferredUnavailableError('incomplete search');
      const seen = new Set<number>();
      const matches: JsonObject[] = [];
      for (const candidate of result.items as unknown[]) {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
          throw new DeferredIdentityError('invalid search candidate');
        const row = candidate as Record<string, unknown>;
        if (
          row.pull_request === null ||
          typeof row.pull_request !== 'object' ||
          Array.isArray(row.pull_request) ||
          !Number.isSafeInteger(row.number) ||
          (row.number as number) <= 0
        )
          throw new DeferredIdentityError('invalid search candidate');
        const pr = row.number as number;
        const actual = await verify(repo, pr);
        if (seen.has(pr)) throw new DeferredUnavailableError('duplicate search candidate');
        seen.add(pr);
        if (
          actual.get('producer') === producer &&
          actual.get('head') === head &&
          actual.get('target') === target
        )
          matches.push(actual);
      }
      return matches;
    },
    loadQueue: () => loadQueueDocument(join(options.stateRoot, 'queue.json')),
    saveQueue: (queue) => atomicWrite(join(options.stateRoot, 'queue.json'), queueBytes(queue)),
  };
}
