/**
 * File adapter for the `crq reconcile-merged` route.
 *
 * Binds the route's effects to the runner's own state root:
 *
 * - wrappers live at `state/reconcile/<key>.json` and are replaced through the
 *   durable atomic write (temp file, file fsync, rename, directory fsync);
 * - the forge is the existing `gh` transport (`api graphql -f query=…`) bounded
 *   by a {@link ForgeBudget}; exhaustion becomes `BudgetExhausted` and every
 *   other transport failure becomes `PageFailed`, exactly as Python maps
 *   `RefreshExhausted` and `(OSError, RuntimeError, TimeoutExpired, ValueError)`;
 * - the queue is the lossless document writer the queue-v1 capability uses, so
 *   the reconcile route and the rest of the runner cannot disagree on bytes;
 * - the operator invocation holds the persistent `tick.lock` inode.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeGhRunner, ghJson, type GhFn } from '../forge-github/gh.js';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { SlotBusyError } from '../lock/slotLock.js';
import { isoUtc, loadQueueDocument, queueBytes } from './queueEffects.js';
import { ForgeBudget, RefreshExhausted } from '../../policy/crq/forgeBudget.js';
import { BudgetExhausted, PageFailed } from '../../policy/crq/reconcileInventory.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
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
  /** The forge transport; defaults to the real `gh` CLI. */
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
  return {
    repo: options.repo,
    nowIso: () => isoUtc(options.now?.() ?? new Date()),
    async readWrapperText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new ReconcileStorageFailed('wrapper-read', error);
      }
    },
    async writeWrapperText(path, text) {
      await mkdir(dirname(path), { recursive: true });
      try {
        await atomicWrite(path, text);
      } catch (error) {
        throw new ReconcileStorageFailed('wrapper-save', error);
      }
    },
    reconcilePath: (key) => join(options.stateRoot, 'reconcile', `${key}.json`),
    async forgeQuery(query) {
      let timeoutSeconds: number;
      try {
        timeoutSeconds = budget.take();
      } catch (error) {
        if (error instanceof RefreshExhausted) {
          throw new BudgetExhausted('aggregate forge budget exhausted; cursor retained');
        }
        throw error;
      }
      // Python bounds the spawned read with the budget's remaining seconds.
      // With an injected transport the caller owns that bound; the default
      // spawn gets a fresh per-call timeout.
      const run: GhFn =
        options.gh ?? makeGhRunner({ timeoutMs: Math.max(1, Math.ceil(timeoutSeconds * 1000)) });
      try {
        // `ghJson` parses with JSON.parse; the policy layer needs the lossless
        // model so a Python `1.0` lexeme is never rewritten as `1`.
        return fromPlainJson(await ghJson(run, ['api', 'graphql', '-f', `query=${query}`]));
      } catch {
        throw new PageFailed('forge read unavailable; cursor retained');
      }
    },
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
