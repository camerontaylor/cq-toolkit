/**
 * The `crq reconcile-merged` route (`crq.reconcile_merged`).
 *
 * This is the effectful half of the S2 reconcile boundary. It owns:
 *
 * - the frozen interval's upper-bound check against the caller's clock;
 * - the `state/reconcile/<digest>.json` wrapper
 *   (`{source, checkpoint, digest}`), read losslessly and written with the
 *   Python atomic bytes (`json.dump(indent=2)`, one trailing newline);
 * - page effects through the injected forge query (numeric all-slot windows by
 *   default; the rolling `closed-updated-v1` page adapter is refused until that
 *   slice lands, while its wrapper key/method is already supported);
 * - resumption: a complete checkpoint revalidates without a forge read, an
 *   incomplete one resumes at its retained cursor without repeating a page;
 * - queue staging: enrollment happens before `merged_reconcile` is recorded, and
 *   a queue save failure leaves the persisted page progress intact so the next
 *   run retries only the enrollment.
 *
 * The command is an operator-live route, not the queue-v1 forced command: the
 * forced command is read-only, while this route mutates the queue under the
 * tick lock.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { atomicJsonText } from '../../policy/crq/pythonJson.js';
import {
  isJsonInt,
  isJsonRecord,
  jsonIntValue,
  recordEntries,
  recordGet,
  withObjectKeys,
  type JsonRecordLike,
} from '../../policy/crq/queueDoc.js';
import { enrollMergedCurrent, type QueueSelector } from '../../policy/crq/queueReceipt.js';
import {
  DISCOVERY_SELECTOR,
  RECONCILE_METHOD_CLOSED_UPDATED,
  RECONCILE_METHOD_NUMERIC,
  ReconcileRefused,
  checkpointDigest,
  loadCheckpoint,
  normalizeInterval,
  normalizePageBudget,
  readReconcileWrapper,
  reconcileWrapperKey,
  type ReconcileInterval,
} from '../../policy/crq/reconcileCheckpoint.js';
import {
  PageFailed,
  enrollmentPlan,
  freezeSource,
  numberPage,
  reconcile,
  type PageFetch,
} from '../../policy/crq/reconcileInventory.js';

/** A durable read/write failure: persisted progress must be revalidated. */
export class ReconcileStorageFailed extends Error {
  override readonly name = 'ReconcileStorageFailed';
  readonly stage: string;

  constructor(stage: string, cause?: unknown) {
    super(
      `merged discovery storage failure: ${stage}; tick aborted; persisted progress must be revalidated`,
      cause === undefined ? undefined : { cause },
    );
    this.stage = stage;
  }
}

/** A usage/argv refusal (Python argparse exit 2). */
export class ReconcileUsageError extends Error {
  override readonly name = 'ReconcileUsageError';
}

/** Every effect the route may perform. */
export interface ReconcileMergedEffects {
  /** `crq.REPO`: the runner's configured repository. */
  readonly repo: string;
  /** `crq.iso()`: whole-second UTC with a trailing `Z`. */
  nowIso(): string;
  /** Read the wrapper text; `null` only when the file is absent. */
  readWrapperText(path: string): Promise<string | null>;
  /** Atomically replace the wrapper with exactly these bytes. */
  writeWrapperText(path: string, text: string): Promise<void>;
  /** `<stateRoot>/reconcile/<key>.json`. */
  reconcilePath(key: string): string;
  /** One GraphQL query; budget/transport failures are typed by the adapter. */
  forgeQuery(query: string): Promise<unknown>;
  /** `runner.load_queue()`. */
  loadQueue(): Promise<JsonObject>;
  /** `runner.save_queue()`, atomic and Python-byte-identical. */
  saveQueue(queue: JsonObject): Promise<void>;
  /** Non-blocking `tick.lock`; `null` when another tick holds it. */
  withTickLock<T>(work: () => Promise<T>): Promise<T | null>;
}

export interface ReconcileMergedOptions {
  readonly after: string;
  readonly before: string;
  readonly pageBudget: number;
  readonly dryRun?: boolean;
  /** Rolling `closed-updated-v1` scans (the page adapter is not ported yet). */
  readonly recent?: boolean;
  /** A page adapter seam; production leaves it unset for numeric windows. */
  readonly pageFetch?: PageFetch;
}

function copyJson(value: JsonValue): JsonValue {
  if (value instanceof JsonObject) {
    return new JsonObject(value.entries.map(([key, entry]) => [key, copyJson(entry)] as const));
  }
  if (Array.isArray(value)) return value.map(copyJson);
  return value;
}

/** The synthetic `closed-updated-v1` source Python builds for rolling scans. */
function recentSource(repo: string): JsonObject {
  return new JsonObject([
    ['version', JsonNumber.int(1)],
    ['method', RECONCILE_METHOD_CLOSED_UPDATED],
    ['repo', repo],
    ['base', DISCOVERY_SELECTOR],
    ['repository_id', repo],
    ['ceiling', JsonNumber.int(0)],
    ['window', JsonNumber.int(50)],
  ]);
}

/** `[v["binding"] for v in q.get("merged_current_requests", {}).values()]`. */
function existingBindings(queue: JsonObject): unknown[] {
  const requests = queue.get('merged_current_requests');
  if (!(requests instanceof JsonObject)) return [];
  return recordEntries(requests)
    .filter(([, entry]) => isJsonRecord(entry))
    .map(([, entry]) => recordGet(entry as JsonRecordLike, 'binding'));
}

function bindingField(binding: JsonRecordLike, key: string): unknown {
  return recordGet(binding, key);
}

/**
 * Stage one enrollment plan on a private copy of the queue. Every intent entry
 * becomes a `review_receipt.enroll`-equivalent mutation; an already-enrolled
 * entry is left alone. The summary is recorded only after the whole plan
 * succeeded, so a partial enrollment cannot claim a completed interval.
 */
function stageEnrollment(
  queue: JsonObject,
  plan: JsonObject,
  repo: string,
  at: () => string,
): JsonObject {
  const entries = plan.get('entries');
  if (!Array.isArray(entries)) throw new ReconcileRefused('invalid enrollment plan');
  let staged = copyJson(queue) as JsonObject;
  for (const entry of entries) {
    if (!isJsonRecord(entry) || recordGet(entry, 'disposition') !== 'intent') continue;
    const binding = recordGet(entry, 'binding');
    const requestId = recordGet(entry, 'request_id');
    if (!isJsonRecord(binding) || typeof requestId !== 'string') {
      throw new ReconcileRefused('invalid enrollment plan');
    }
    const pr = bindingField(binding, 'pr');
    const mergeSha = bindingField(binding, 'merge_sha');
    const targetSelector = bindingField(binding, 'target_selector');
    if (
      !isJsonInt(pr) ||
      typeof mergeSha !== 'string' ||
      typeof targetSelector !== 'string' ||
      bindingField(binding, 'repo') !== repo
    ) {
      throw new ReconcileRefused('invalid enrollment binding');
    }
    staged = enrollMergedCurrent(staged, {
      repo,
      pr: Number(jsonIntValue(pr)),
      mergeSha,
      requestId,
      at: at(),
      targetSelector: targetSelector as QueueSelector,
    }).queue;
  }
  return staged;
}

/**
 * `crq.reconcile_merged`: one bounded inventory pass. Throws {@link ReconcileRefused}
 * for invalid input, {@link PageFailed} for a retryable forge read, and
 * {@link ReconcileStorageFailed} when a durable write failed.
 */
export async function reconcileMerged(
  options: ReconcileMergedOptions,
  effects: ReconcileMergedEffects,
): Promise<JsonObject> {
  const interval = normalizeInterval(options.after, options.before);
  if (interval.before >= effects.nowIso()) {
    throw new ReconcileRefused('upper bound must precede scan startup');
  }
  const budget = normalizePageBudget(options.pageBudget);
  const recent = options.recent === true;
  const method = recent ? RECONCILE_METHOD_CLOSED_UPDATED : undefined;
  const key = reconcileWrapperKey(effects.repo, interval, method);
  const path = effects.reconcilePath(key);

  let wrapper: JsonObject | null = null;
  const text = await effects.readWrapperText(path);
  if (text !== null) {
    wrapper = readReconcileWrapper(
      text,
      interval,
      budget,
      effects.repo,
      method ?? RECONCILE_METHOD_NUMERIC,
    );
  }

  const saveWrapper = async (): Promise<void> => {
    if (wrapper === null) throw new ReconcileStorageFailed('wrapper-save');
    const sealed = withObjectKeys(wrapper, [['digest', checkpointDigest(wrapper)]]);
    try {
      await effects.writeWrapperText(path, atomicJsonText(sealed));
    } catch (error) {
      throw new ReconcileStorageFailed('wrapper-save', error);
    }
    wrapper = sealed;
  };

  if (wrapper === null) {
    const source = recent
      ? recentSource(effects.repo)
      : await freezeSource(effects.forgeQuery, {
          repo: effects.repo,
          base: DISCOVERY_SELECTOR,
        });
    wrapper = new JsonObject([
      ['source', source],
      ['checkpoint', null],
    ]);
    if (options.dryRun !== true) await saveWrapper();
  }
  const source = wrapper.get('source');
  if (!(source instanceof JsonObject)) {
    throw new ReconcileRefused('wrapper-schema: source identity malformed');
  }

  const persist = async (snapshot: JsonObject): Promise<void> => {
    if (wrapper === null) throw new ReconcileStorageFailed('wrapper-save');
    wrapper = withObjectKeys(wrapper, [['checkpoint', snapshot]]);
    await saveWrapper();
  };

  const raw = wrapper.get('checkpoint');
  let result: JsonObject;
  if (raw instanceof JsonObject && raw.get('complete') === true) {
    // A completed scan revalidates from disk and costs no forge read; the
    // enrollment retry below is idempotent by binding.
    result = loadCheckpoint(raw, interval, budget, effects.repo, DISCOVERY_SELECTOR, true);
  } else {
    if (recent && options.pageFetch === undefined) {
      throw new ReconcileRefused('rolling closed-updated-v1 discovery page adapter is not ported');
    }
    const pageFetch =
      options.pageFetch ??
      ((cursor: string | null) =>
        numberPage(effects.forgeQuery, source, cursor, {
          repo: effects.repo,
          base: DISCOVERY_SELECTOR,
        }));
    result = await reconcile(pageFetch, {
      repo: effects.repo,
      base: DISCOVERY_SELECTOR,
      after: interval.after,
      before: interval.before,
      pageBudget: budget,
      checkpointRaw: raw,
      checkpointSave: persist,
      dryRun: options.dryRun === true,
    });
  }

  const summaryValue = result.get('summary');
  if (!(summaryValue instanceof JsonObject)) throw new ReconcileRefused('invalid inventory');
  const summary = withObjectKeys(summaryValue, [
    ['inventory_digest', result.get('digest') as JsonValue],
    ['source', source],
    ['checkpoint_key', key],
  ]);

  if (result.get('complete') === true) {
    const queue = await loadQueue(effects);
    const plan = enrollmentPlan(result, {
      repo: effects.repo,
      existingRequests: existingBindings(queue),
      dryRun: options.dryRun === true,
    });
    if (options.dryRun !== true) {
      const staged = stageEnrollment(queue, plan, effects.repo, () => effects.nowIso());
      try {
        await effects.saveQueue(withObjectKeys(staged, [['merged_reconcile', summary]]));
      } catch (error) {
        throw new ReconcileStorageFailed('enrollment-save', error);
      }
    }
  } else if (options.dryRun !== true) {
    const queue = await loadQueue(effects);
    try {
      await effects.saveQueue(
        withObjectKeys(copyJson(queue) as JsonObject, [['merged_reconcile', summary]]),
      );
    } catch (error) {
      throw new ReconcileStorageFailed('inventory-summary-save', error);
    }
  }
  return summary;
}

async function loadQueue(effects: ReconcileMergedEffects): Promise<JsonObject> {
  try {
    return await effects.loadQueue();
  } catch (error) {
    throw new ReconcileStorageFailed('queue-read', error);
  }
}

export interface ParsedReconcileArgv {
  readonly after: string;
  readonly before: string;
  readonly pageBudget: number;
  readonly dryRun: boolean;
}

/**
 * Parse Python's `reconcile-merged` argv. Both `--name value` and `--name=value`
 * are accepted, a repeated option keeps the last value (argparse), and anything
 * unknown or incomplete is a usage error.
 */
export function parseReconcileArgv(argv: readonly string[]): ParsedReconcileArgv {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!token.startsWith('--')) throw new ReconcileUsageError(`unrecognized argument: ${token}`);
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    if (name !== '--after' && name !== '--before' && name !== '--page-budget') {
      throw new ReconcileUsageError(`unrecognized argument: ${name}`);
    }
    let value: string;
    if (equals >= 0) {
      value = token.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new ReconcileUsageError(`argument ${name}: expected one argument`);
      }
      value = next;
      index += 1;
    }
    values.set(name, value);
  }
  const after = values.get('--after');
  const before = values.get('--before');
  const pageBudgetText = values.get('--page-budget');
  if (after === undefined)
    throw new ReconcileUsageError('the following arguments are required: --after');
  if (before === undefined)
    throw new ReconcileUsageError('the following arguments are required: --before');
  if (pageBudgetText === undefined) {
    throw new ReconcileUsageError('the following arguments are required: --page-budget');
  }
  if (!/^[+-]?[0-9]+$/.test(pageBudgetText)) {
    throw new ReconcileUsageError(`argument --page-budget: invalid int value: '${pageBudgetText}'`);
  }
  return { after, before, pageBudget: Number(pageBudgetText), dryRun };
}

export type ReconcileRouteResult =
  | { readonly artifact: { readonly status: 'ok'; readonly value: unknown }; readonly exitCode: 0 }
  | {
      readonly artifact: { readonly status: 'failed'; readonly error: string };
      readonly exitCode: 2 | 3;
    };

function failed(message: string, exitCode: 2 | 3): ReconcileRouteResult {
  return { artifact: { status: 'failed', error: message }, exitCode };
}

/** `crq reconcile-merged …`: the operator-live entry. */
export async function runReconcileMerged(
  argv: readonly string[],
  effects: ReconcileMergedEffects,
): Promise<ReconcileRouteResult> {
  let parsed: ParsedReconcileArgv;
  try {
    parsed = parseReconcileArgv(argv);
  } catch (error) {
    if (error instanceof ReconcileUsageError) return failed(error.message, 2);
    throw error;
  }
  try {
    const outcome = await effects.withTickLock(() =>
      reconcileMerged(
        {
          after: parsed.after,
          before: parsed.before,
          pageBudget: parsed.pageBudget,
          dryRun: parsed.dryRun,
        },
        effects,
      ),
    );
    if (outcome === null) return failed('another crq tick holds the lock; exiting', 3);
    return { artifact: { status: 'ok', value: outcome }, exitCode: 0 };
  } catch (error) {
    if (error instanceof ReconcileStorageFailed) return failed(error.message, 3);
    if (error instanceof ReconcileRefused || error instanceof PageFailed) {
      return failed(`reconcile-merged refused: ${error.message}`, 3);
    }
    throw error;
  }
}

/** Re-exported for the adapter and tests that need the interval shape. */
export type { ReconcileInterval };
