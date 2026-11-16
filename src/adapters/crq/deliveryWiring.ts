/**
 * Binds the delivery passes (`deliverPending*`) to the receipt layer: the four
 * post-harvest delivery phases of a tick, each `(queue) => {queue, log}`.
 *
 * Python mutates the queue in place, so `_checkpoint_review_identity(q, ...)` inside a
 * delivery can `save_queue(q)` with every earlier in-pass item update. The TS passes are
 * immutable and never expose their in-flight queue, so a `CheckpointLog` stands in: it
 * applies each checkpoint to the pass's *input* queue, saves that durably before the POST,
 * and re-applies the recorded checkpoints to the pass's output queue. Python divergence:
 * the saved snapshot lacks the pass's earlier in-pass item updates (attempt stamps); the
 * tick's own save still persists them.
 *
 * The receipt layer's `deliver` and `checkpoint` are synchronous, so the queue save at a
 * checkpoint is a synchronous port too. Not wired into any entry point.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  PrReviewKeyError,
  PrReviewRuntimeError,
  PrReviewTypeError,
  PrReviewValueError,
  deliver,
  isRepo,
  isRunId,
  isSha,
  loadFindings,
  type GhPort,
} from '../../policy/crq/prReviewFindings.js';
import { ThreadsNotVisible } from '../../policy/crq/receiptEvidence.js';
import {
  ReceiptDecodeError,
  ReceiptOsError,
  refresh,
  type ReceiptFiles,
} from '../../policy/crq/receiptPrepare.js';
import { bindReceiptHooks, checkpointReviewIdentity } from '../../policy/crq/receiptBinding.js';
import { selectReceiptIdentity } from '../../policy/crq/reviewIdentity.js';
import {
  DeliveryKeyTypeError,
  DeliveryRuntimeError,
  DeliveryValueError,
  ThreadsNotVisibleError,
  deliverPendingCleanReviews,
} from '../../ops/crq/internal/deliverPending.js';
import { deliverPendingPrReviews } from '../../ops/crq/internal/deliverPrReviews.js';
import { deliverPendingReviewRefreshes } from '../../ops/crq/internal/deliverRefreshes.js';
import {
  deliverPendingPushFindings,
  type PushFindingsEffects,
} from '../../ops/crq/internal/deliverPushFindings.js';
import type { PhaseResult } from '../../queue-runner/tickOrchestrator.js';

export interface DeliveryEnv {
  /** `pr_review_findings._gh`: the default gh runner. */
  readonly gh: GhPort;
  /** `crq_review_identity` App authentication; throws `IdentityUnavailable`. */
  readonly authenticate: (repo: string) => GhPort;
  /** Run-directory artifact reader for `crq_review_receipt.prepare`. */
  readonly files: ReceiptFiles;
  /** `Path(p).read_text(errors="replace")`; an OSError is a `ReceiptOsError`. */
  readonly readText: (path: string) => string;
  /** `save_queue`, synchronous: it runs inside the receipt layer's identity checkpoint. */
  readonly saveQueue: (queue: JsonObject) => void;
  readonly now: () => string;
  readonly primaryRepo: string;
  /** `crq.event`: the three delivery event kinds. */
  readonly event: (
    kind: 'findings_delivered' | 'findings_review_delivered' | 'findings_review_abandoned',
    data: Record<string, JsonValue>,
  ) => Promise<void>;
  /** The push-findings issue filer's own effects (repo lookup, findings read, `file_issue`). */
  readonly push: Pick<PushFindingsEffects, 'repoMode' | 'readFindings' | 'fileIssue'>;
}

export interface DeliveryPhases {
  deliverIssues(queue: JsonObject): Promise<PhaseResult>;
  deliverPrReviews(queue: JsonObject): Promise<PhaseResult>;
  deliverCleanReviews(queue: JsonObject): Promise<PhaseResult>;
  deliverReviewRefreshes(queue: JsonObject): Promise<PhaseResult>;
}

/** Python exception classes the delivery passes dispatch on, from the receipt layer's errors. */
export function mapDeliveryError(error: unknown): unknown {
  if (error instanceof ThreadsNotVisible) return new ThreadsNotVisibleError(error.message);
  if (error instanceof PrReviewKeyError || error instanceof PrReviewTypeError)
    return new DeliveryKeyTypeError(error.message);
  if (error instanceof PrReviewValueError || error instanceof ReceiptDecodeError)
    return new DeliveryValueError(error.message);
  if (error instanceof PrReviewRuntimeError || error instanceof ReceiptOsError)
    return new DeliveryRuntimeError(error.message);
  return error;
}

interface Target {
  /** Undefined matches any item (the refresh pass does not name one). */
  readonly itemId: JsonValue | undefined;
  readonly runId: JsonValue;
  readonly head: JsonValue;
}

interface Applied extends Target {
  readonly login: string;
  readonly reason: JsonValue;
}

const sameRequest = (request: JsonValue | undefined, target: Target): request is JsonObject =>
  request instanceof JsonObject &&
  request.get('run_id') === target.runId &&
  request.get('head') === target.head;

/** One pass's identity checkpoints: durable before any POST, re-applied to the pass output. */
export class CheckpointLog {
  private current: JsonObject;
  private readonly applied: Applied[] = [];

  constructor(
    queue: JsonObject,
    private readonly requestKeys: readonly string[],
    private readonly save: (queue: JsonObject) => void,
  ) {
    this.current = queue;
  }

  /** `_checkpoint_review_identity` against the queue's own request, then `save_queue`. */
  record(target: Target, login: string, reason: JsonValue): void {
    const next = this.apply(this.current, target, login, reason);
    if (next === null) return;
    this.current = next;
    this.save(next);
    this.applied.push({ ...target, login, reason });
  }

  /** The pass output with every recorded checkpoint applied. */
  finish(output: JsonObject): JsonObject {
    return this.applied.reduce(
      (queue, hit) => this.apply(queue, hit, hit.login, hit.reason) ?? queue,
      output,
    );
  }

  private apply(
    queue: JsonObject,
    target: Target,
    login: string,
    reason: JsonValue,
  ): JsonObject | null {
    const items = queue.get('items');
    if (!Array.isArray(items)) return null;
    let changed = false;
    const next = items.map((item) => {
      if (
        !(item instanceof JsonObject) ||
        (target.itemId !== undefined && item.get('id') !== target.itemId)
      )
        return item;
      let row = item;
      for (const key of this.requestKeys) {
        const request = row.get(key);
        if (!sameRequest(request, target)) continue;
        const updated = checkpointReviewIdentity(request, login, reason);
        if (updated === null) continue;
        changed = true;
        row = new JsonObject(row.entries.map(([k, v]) => (k === key ? [k, updated] : [k, v])));
      }
      return row;
    });
    if (!changed) return null;
    return new JsonObject(queue.entries.map(([k, v]) => (k === 'items' ? [k, next] : [k, v])));
  }
}

const asPr = (value: JsonValue): number =>
  value instanceof JsonNumber && value.kind === 'int' ? Number(value.integer) : Number.NaN;

function resultObject(result: object): JsonObject {
  return new JsonObject(
    Object.entries(result)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]): [string, JsonValue] => [
        key,
        typeof value === 'number' ? JsonNumber.int(BigInt(value)) : (value as JsonValue),
      ]),
  );
}

interface ReviewInput {
  readonly repo: string;
  readonly pr: JsonValue;
  readonly ndjson: string;
  readonly runId: JsonValue;
  readonly base: JsonValue;
  readonly head: JsonValue;
  readonly itemId: JsonValue;
  readonly postingIdentity: JsonValue;
  readonly identityReason: JsonValue;
}

/** `pr_review_findings.deliver(repo, pr, meta, Path(ndjson))` for a receipt (`crq_receipt`) delivery. */
function deliverReview(
  env: DeliveryEnv,
  log: CheckpointLog,
  input: ReviewInput,
  clean: boolean,
): JsonObject {
  const { runId, base, head } = input;
  const pr = asPr(input.pr);
  // `deliver` validates the identity before reading the findings; keep that order.
  if (
    !isRepo(input.repo) ||
    !Number.isInteger(pr) ||
    pr <= 0 ||
    typeof runId !== 'string' ||
    !isRunId(runId) ||
    !isSha(head) ||
    typeof base !== 'string' ||
    base === ''
  )
    throw new PrReviewValueError('invalid PR review delivery identity');
  const findings = loadFindings(env.readText(input.ndjson), true);
  const identity: Array<[string, JsonValue]> = [
    ['posting_identity', input.postingIdentity],
    ['identity_reason', input.identityReason],
  ];
  const meta = new JsonObject(
    clean
      ? [
          ['run_id', runId],
          ['base', base],
          ['head', head],
          ['item_id', input.itemId],
          ['crq_receipt', true],
          ...identity,
        ]
      : [
          ['run_id', runId],
          ['item_id', input.itemId],
          ['base', base],
          ['head', head],
          ['crq_receipt', true],
          ...identity,
        ],
  );
  const target: Target = { itemId: input.itemId, runId, head };
  const receipt = bindReceiptHooks({
    injected: false,
    authenticate: env.authenticate,
    checkpoint: (login, reason) => log.record(target, login, reason),
    files: env.files,
    ndjson: input.ndjson,
  });
  return resultObject(
    deliver({
      repo: input.repo,
      pr,
      meta,
      findings,
      gh: env.gh,
      login: null,
      injected: false,
      receipt,
    }),
  );
}

/** `crq_review_receipt.refresh(pr_review_findings, repo, pr, meta)`. */
function refreshReview(
  env: DeliveryEnv,
  log: CheckpointLog,
  input: {
    readonly repo: string;
    readonly pr: JsonValue;
    readonly runId: string;
    readonly base: string;
    readonly head: string;
    readonly postingIdentity: JsonValue;
    readonly identityReason: JsonValue;
  },
): JsonObject {
  // The refresh pass does not name the item: the request is found by its scan run and head.
  const target: Target = { itemId: undefined, runId: input.runId, head: input.head };
  const meta = new JsonObject([
    ['run_id', input.runId],
    ['base', input.base],
    ['head', input.head],
    ['posting_identity', input.postingIdentity],
    ['identity_reason', input.identityReason],
  ]);
  const selected = selectReceiptIdentity({
    repo: input.repo,
    meta,
    gh: env.gh,
    login: null,
    injected: false,
    authenticate: env.authenticate,
    checkpoint: (login, reason) => log.record(target, login, reason),
  });
  return refresh(selected.gh, input.repo, asPr(input.pr), selected.meta, selected.login);
}

export function bindDeliveryPhases(env: DeliveryEnv): DeliveryPhases {
  const unused = async (): Promise<never> => {
    throw new Error('delivery closes over its CheckpointLog; the pass checkpoint is not used');
  };
  const guarded = async <T>(work: () => T): Promise<T> => {
    try {
      return work();
    } catch (error) {
      throw mapDeliveryError(error);
    }
  };
  return {
    async deliverIssues(queue) {
      return deliverPendingPushFindings(queue, {
        ...env.push,
        now: env.now,
        primaryRepo: env.primaryRepo,
        event: env.event,
      });
    },
    async deliverPrReviews(queue) {
      const log = new CheckpointLog(queue, ['pr_review_request'], env.saveQueue);
      const out = await deliverPendingPrReviews(queue, {
        deliver: (input) => guarded(() => deliverReview(env, log, input, false)),
        now: env.now,
        primaryRepo: env.primaryRepo,
        checkpoint: unused,
        event: env.event,
      });
      return { queue: log.finish(out.queue), log: out.log };
    },
    async deliverCleanReviews(queue) {
      const log = new CheckpointLog(queue, ['clean_review_request'], env.saveQueue);
      const out = await deliverPendingCleanReviews(queue, {
        deliver: (input) => guarded(() => deliverReview(env, log, input, true)),
        now: env.now,
        primaryRepo: env.primaryRepo,
        checkpoint: unused,
      });
      return { queue: log.finish(out.queue), log: out.log };
    },
    async deliverReviewRefreshes(queue) {
      const log = new CheckpointLog(
        queue,
        ['pr_review_request', 'clean_review_request'],
        env.saveQueue,
      );
      const out = await deliverPendingReviewRefreshes(queue, {
        refresh: (input) => guarded(() => refreshReview(env, log, input)),
        now: env.now,
        primaryRepo: env.primaryRepo,
        checkpoint: unused,
      });
      return { queue: log.finish(out.queue), log: out.log };
    },
  };
}
