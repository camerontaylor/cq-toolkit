/**
 * File adapter for the `crq reconcile-merged` route.
 *
 * Binds the route's effects to the runner's own state root:
 *
 * - wrappers live at `state/reconcile/<key>.json` and are replaced through the
 *   durable atomic write (temp file, file fsync, rename, directory fsync);
 * - the forge is the existing `gh` transport (`api graphql -f query=…`) bounded
 *   by a {@link ForgeBudget}; exhaustion becomes `BudgetExhausted` and every
 *   expected transport failures become `PageFailed`, while programming errors
 *   from an injected transport remain visible;
 * - the queue is the lossless document writer the queue-v1 capability uses, so
 *   the reconcile route and the rest of the runner cannot disagree on bytes;
 * - the operator invocation holds the persistent `tick.lock` inode.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GhError, makeGhRunner, ghJson, type GhFn } from '../forge-github/gh.js';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { SlotBusyError } from '../lock/slotLock.js';
import { isoUtc, loadQueueDocument, queueBytes } from './queueEffects.js';
import { ForgeBudget, RefreshExhausted } from '../../policy/crq/forgeBudget.js';
import { BudgetExhausted, PageFailed } from '../../policy/crq/reconcileInventory.js';
import { ReconcileRefused } from '../../policy/crq/reconcileCheckpoint.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
import { JsonParseError, parseJsonValue } from '../../policy/crq/jsonValue.js';
import {
  ReconcileStorageFailed,
  runReconcileMerged,
  type ReconcileMergedEffects,
  type ReconcileRouteResult,
} from '../../ops/crq/reconcileMerged.js';

export interface ReconcileSourceOptions {
  /** `crq.REPO`. */
  readonly repo: string;
  /** `<runner>/state`. */
  readonly stateRoot: string;
  /** The forge transport; defaults to the real `gh` CLI. Injected calls time out but cannot be cancelled. */
  readonly gh?: GhFn;
  /** The aggregate allowance; defaults to the shared 24/30 recovery window. */
  readonly budget?: ForgeBudget;
  /** Clock override for tests. */
  readonly now?: () => Date;
}

/** Build the route's effects bound to one runner's state. */
export function fileReconcileMergedEffects(
  options: ReconcileSourceOptions,
): ReconcileMergedEffects {
  const budget = options.budget ?? new ForgeBudget();
  const queuePath = join(options.stateRoot, 'queue.json');
  const forgeRead = async (args: string[], lossless = false): Promise<unknown> => {
    let timeoutSeconds: number;
    try {
      timeoutSeconds = budget.take();
    } catch (error) {
      if (error instanceof RefreshExhausted) {
        throw new BudgetExhausted('aggregate forge budget exhausted; cursor retained');
      }
      throw error;
    }
    const timeoutMs = Math.max(1, Math.ceil(timeoutSeconds * 1000));
    const run: GhFn =
      options.gh === undefined
        ? makeGhRunner({ timeoutMs })
        : async (argv) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                options.gh!(argv),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new PageFailed('forge read unavailable; cursor retained')),
                    timeoutMs,
                  );
                }),
              ]);
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
          };
    try {
      if (!lossless) return await ghJson(run, args);
      const result = await run(args);
      if (result.code !== 0) throw new PageFailed('forge read unavailable; cursor retained');
      try {
        return parseJsonValue(result.stdout, { duplicates: 'last' });
      } catch (error) {
        if (error instanceof JsonParseError)
          throw new PageFailed('forge read unavailable; cursor retained');
        throw error;
      }
    } catch (error) {
      if (error instanceof PageFailed) throw error;
      if (error instanceof GhError) throw new PageFailed('forge read unavailable; cursor retained');
      throw error;
    }
  };
  return {
    repo: options.repo,
    nowIso: () => isoUtc(options.now?.() ?? new Date()),
    async readWrapperText(path) {
      try {
        const bytes = await readFile(path);
        try {
          // Keep a BOM as U+FEFF: Python's utf-8 decoder retains it and its
          // JSON parser refuses it rather than silently stripping it.
          return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw new ReconcileRefused('wrapper-decode: invalid text');
        }
      } catch (error) {
        if (error instanceof ReconcileRefused) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new ReconcileStorageFailed('wrapper-read', error);
      }
    },
    async writeWrapperText(path, text) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await atomicWrite(path, text);
      } catch (error) {
        throw new ReconcileStorageFailed('wrapper-save', error);
      }
    },
    reconcilePath: (key) => join(options.stateRoot, 'reconcile', `${key}.json`),
    async forgeQuery(query) {
      return fromPlainJson(await forgeRead(['api', 'graphql', '-f', `query=${query}`]));
    },
    forgeClosedPage: (size, page) =>
      forgeRead(
        [
          'api',
          `repos/${options.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${size}&page=${page}`,
        ],
        true,
      ),
    loadQueue: () => loadQueueDocument(queuePath),
    saveQueue: (queue) => atomicWrite(queuePath, queueBytes(queue)),
    async withTickLock(work) {
      try {
        return await withLock(join(options.stateRoot, 'tick.lock'), { wait: false }, work);
      } catch (error) {
        if (error instanceof SlotBusyError) return null;
        throw error;
      }
    },
  };
}

/** `crq reconcile-merged …`: the operator-live entry over a resolved state root. */
export async function runReconcileMergedUnit(
  argv: readonly string[],
  options: ReconcileSourceOptions,
): Promise<ReconcileRouteResult> {
  return runReconcileMerged(argv, fileReconcileMergedEffects(options));
}
