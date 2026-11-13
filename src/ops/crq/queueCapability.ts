/**
 * The queue-v1 capability state machine (`queue_transport.handle`).
 *
 * The wire (`queueWire`) decides *whether* a request may run; this module decides
 * *what it does*, and owns every durable effect: tick-lock serialized queue
 * writes, receipt byte verification, the delivery journal, the forge identity
 * check and retry liveness. Policy stays pure; the runner adapter supplies the
 * effects.
 *
 * Rollback compatibility: the queue document is mutated exactly where Python
 * mutates it (client entries, items, merged-current mappings) and written with
 * the Python `json.dump(indent=2)` byte encoding, so a Python runner can adopt a
 * queue file this module wrote and vice versa.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { receiptJsonDigest } from '../../policy/crq/pythonJson.js';
import {
  MAX_RECEIPT_BYTES,
  QUEUE_RECEIPT_POLICY,
  ReceiptSnapshot,
  clientStatusProjection,
  enrollMergedCurrent,
  receiptStatus,
  refuseQueue,
  remediationFixed,
  remediationSummary,
  reusableNoncountedTerminal,
} from '../../policy/crq/queueReceipt.js';
import {
  fromPlainJson,
  isJsonInt,
  isJsonRecord,
  jsonIntValue,
  pyTruthy,
  pythonValueEqual,
  recordGet,
  withObjectKeys,
  withoutObjectKey,
  type JsonRecordLike,
} from '../../policy/crq/queueDoc.js';
import { currentEquivalence, reusableCurrent } from '../../policy/crq/receiptIdentity.js';
import {
  retryTransient,
  vendorRateLimit,
  vendorRateLimitReason,
} from '../../policy/crq/queueRetry.js';
import { queueHealthSnapshot } from '../../policy/crq/queueHealth.js';
import { inventoryWrapperKey, projectInventory } from '../../policy/crq/queueInventory.js';
import { normalizeInterval, readReconcileWrapper } from '../../policy/crq/reconcileCheckpoint.js';
import {
  QUEUE_READ_OPS,
  authorizeQueueRequest,
  decodeQueueRequest,
  encodeQueueResponse,
  validateQueuePolicy,
  type DeferredAuthorBinding,
  type MergedCurrentBinding,
  type QueueBinding,
  type QueueInventoryBinding,
  type QueuePolicy,
  type QueueRequest,
} from '../../policy/crq/queueWire.js';

/** The runner-side effects the capability needs; every one is fail-closed. */
export interface QueueCapabilityEffects {
  /** `CONFIG.queue.project_fixed` for this runner. */
  readonly projectFixed: boolean;
  /** `crq.iso()`: `YYYY-MM-DDTHH:MM:SSZ`. */
  nowIso(): string;
  /** Wall clock as epoch microseconds. */
  nowMicros(): bigint;
  /** `_queue_generation`: `[st_dev, st_ino, st_size, st_mtime_ns]`. */
  queueGeneration(): Promise<JsonValue>;
  /** `runner.load_queue()`: the lossless queue document. */
  loadQueue(): Promise<JsonObject>;
  /** `runner.save_queue()`: the Python queue byte encoding, atomically. */
  saveQueue(queue: JsonObject): Promise<void>;
  /** Non-blocking `tick.lock`; null when the tick already holds it. */
  withQueueLock<T>(work: () => Promise<T>): Promise<T | null>;
  /** One of the two non-blocking read slots; null when both are held. */
  withReadSlot<T>(work: () => Promise<T>): Promise<T | null>;
  /** `_ReceiptSnapshot.__init__`'s read: at most `maxBytes + 1` bytes. */
  readReceipt(receiptId: string, maxBytes: number): Promise<Uint8Array>;
  /** `Path(...).stat().st_size` for one receipt. */
  receiptSize(receiptId: string): Promise<number>;
  /** `deliveries/<digest>.json` read; null when absent. */
  readJournal(key: string): Promise<JsonObject | null>;
  /** Merge-and-write one delivery journal under the short journal lock. */
  updateJournal(key: string, update: (previous: JsonObject | null) => JsonObject): Promise<void>;
  /** `_cached_forge`: run `check` once per exact binding within the TTL. */
  withForgeCache(key: string, check: () => Promise<void>): Promise<void>;
  /** `<stateRoot>/reconcile/<key>.json`. */
  reconcilePath(key: string): string;
  /** One full read of the reconcile wrapper text. */
  readReconcileWrapperText(path: string): Promise<string>;
  /** `verify_source(repo, pr)`: trusted forge metadata for one pull request. */
  verifySource(repo: string, pr: number): Promise<JsonValue>;
  /** `<runs>/<runId>`. */
  runDir(runId: string): string;
  /** `(rdir / "exit.json").is_file()`. */
  hasExit(runDir: string): Promise<boolean>;
  /** `crq.read_pidfile(rdir)`. */
  readPidfile(runDir: string): Promise<JsonRecordLike | null>;
  /** `crq.run_liveness(rdir, run, has_exit)`. */
  runLiveness(runDir: string, recorded: JsonRecordLike): Promise<'alive' | 'harvest' | 'ambiguous'>;
}

export interface QueueCapabilityInput {
  readonly raw: Uint8Array;
  readonly principal: string;
  /** The operator queue policy document, validated here exactly as Python does. */
  readonly policy: unknown;
  /** The running runner's configured repository (`crq.REPO`). */
  readonly runnerRepo: string;
}

const REASON_NO_RECEIPT = { source: 'queue', category: 'unknown', code: 'no-receipt' };
const REASON_UNCLASSIFIED = { source: 'queue', category: 'unknown', code: 'unclassified' };
const REASON_SCAN_BLOCK = { source: 'queue', category: 'scan', code: 'blocked-secret-scan' };
const UNSUPPORTED = 'Reviewed D1C queue-v1 activation required';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const NONCOUNTED_STATES = new Set(['no-current-code', 'partial-scope', 'unsupported']);

function refuse(message: string): never {
  refuseQueue(message);
}

function busyResult(): JsonObject {
  return new JsonObject([
    [
      'error',
      new JsonObject([
        ['code', 'busy'],
        ['retryable', true],
      ]),
    ],
  ]);
}

function deepCopy(value: JsonValue): JsonValue {
  if (value instanceof JsonObject) {
    return new JsonObject(value.entries.map(([key, entry]) => [key, deepCopy(entry)] as const));
  }
  if (Array.isArray(value)) return value.map(deepCopy);
  return value;
}

function asObject(value: unknown): JsonObject | null {
  return value instanceof JsonObject ? value : null;
}

function asObjectOrEmpty(value: unknown): JsonObject {
  return value instanceof JsonObject ? value : new JsonObject([]);
}

function requireString(object: JsonObject, key: string): string {
  const value = object.get(key);
  if (typeof value !== 'string') refuse(`invalid receipt ${key}`);
  return value;
}

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

/**
 * `queue_transport.handle`: authorize, gate on activation, then serve one
 * operation. Throws a queue refusal for every refusal; a denial of
 * `retry-capability` is a normal `{denied}` result.
 */
export async function runQueueCapability(
  input: QueueCapabilityInput,
  effects: QueueCapabilityEffects,
): Promise<Uint8Array> {
  const policy = validateQueuePolicy(input.policy);
  const request = decodeQueueRequest(input.raw);
  const compatible = input.runnerRepo === policy.repo;
  if (request.op === 'retry-capability') {
    // The probe still answers from a disabled policy; a runner serving another
    // repository reports the capability as inactive rather than guessing.
    const probe = policy.enabled && !compatible ? { ...policy, enabled: false } : policy;
    return handle(request, input.principal, probe, null);
  }
  // `queue_main` authorizes before the activation gate, so a denied principal
  // learns nothing about whether the capability is enabled.
  authorizeQueueRequest(request, input.principal, policy);
  if (!policy.enabled || !compatible) {
    return handle(request, input.principal, { ...policy, enabled: false }, null);
  }
  return handle(request, input.principal, policy, effects);
}

async function handle(
  request: QueueRequest,
  principal: string,
  policy: QueuePolicy,
  effects: QueueCapabilityEffects | null,
): Promise<Uint8Array> {
  try {
    authorizeQueueRequest(request, principal, policy);
  } catch (error) {
    if (request.op === 'retry-capability') {
      return encodeQueueResponse(request, new JsonObject([['denied', 'no-permission']]));
    }
    throw error;
  }
  if (!policy.enabled) {
    return encodeQueueResponse(request, new JsonObject([['unsupported', UNSUPPORTED]]));
  }
  if (request.op === 'retry-capability') {
    return encodeQueueResponse(request, new JsonObject([['retry', JsonNumber.int(1)]]));
  }
  if (effects === null) refuse('queue capability requires runner effects');
  return execute(request, principal, policy, effects);
}

async function execute(
  request: QueueRequest,
  principal: string,
  policy: QueuePolicy,
  effects: QueueCapabilityEffects,
): Promise<Uint8Array> {
  const readOnly = QUEUE_READ_OPS.has(request.op) || request.op === 'inventory';
  const work = async (): Promise<Uint8Array> => {
    // The generation is read before the queue so a concurrent tick is detected.
    const generation = readOnly ? await effects.queueGeneration() : null;
    const loaded = await effects.loadQueue();
    if (!(loaded instanceof JsonObject)) refuse('invalid queue object');
    let queue = readOnly ? loaded : (deepCopy(loaded) as JsonObject);
    const snapshotId = readOnly
      ? receiptJsonDigest({ principal, queue: generation ?? json(queue) })
      : null;
    const finish = async (result: JsonObject): Promise<Uint8Array> => {
      const body =
        readOnly && snapshotId !== null && !result.has('snapshot')
          ? new JsonObject([['snapshot', snapshotId], ...result.entries])
          : result;
      if (generation !== null && !pythonValueEqual(await effects.queueGeneration(), generation)) {
        return encodeQueueResponse(request, busyResult());
      }
      return encodeQueueResponse(request, body);
    };

    if (request.op === 'health') return finish(queueHealthSnapshot(queue, effects.nowMicros()));
    if (request.op === 'inventory') {
      return finish(await inventoryResult(request, queue, principal, effects));
    }

    const binding = request.binding as QueueBinding;
    const requestId = request.requestId;
    const readEntries = (): JsonObject => {
      const existing = queue.get('queue_client_requests');
      return existing === undefined
        ? new JsonObject([])
        : asObjectRequired(existing, 'invalid queue client requests');
    };
    const writeEntry = (value: JsonObject | null, key = requestId): void => {
      if (value === null) return;
      const nextEntries = withObjectKeys(readEntries(), [[key, value]]);
      queue = withObjectKeys(queue, [['queue_client_requests', nextEntries]]);
    };
    let entry = readEntry(readEntries(), requestId, binding, principal);

    // Reconciled reads adopt an existing exact subject; they never enroll or dispatch.
    if (
      (QUEUE_READ_OPS.has(request.op) || request.op === 'ack') &&
      policy.read.includes(principal) &&
      entry === null &&
      policy.reconciledReads.some(
        (grant) =>
          grant.principal === principal &&
          grant.requestId === requestId &&
          pythonValueEqual(grant.binding, binding),
      )
    ) {
      if (binding.kind !== 'merged-current') refuse('reconciled request/source mismatch');
      const subject = mergedSubject(binding);
      const mappings = queue.get('merged_current_requests');
      const queueItems = queue.get('items');
      if (
        !(mappings instanceof JsonObject) ||
        !Array.isArray(queueItems) ||
        queueItems.some((item) => !isJsonRecord(item))
      ) {
        refuse('invalid reconciled queue mappings/items');
      }
      const itemId = `current-${receiptJsonDigest(subject).slice(0, 32)}`;
      const items = queueItems.filter(
        (item) => isJsonRecord(item) && recordGet(item, 'id') === itemId,
      ) as JsonObject[];
      const expectedMapping = new JsonObject([
        ['binding', subject],
        ['item', itemId],
      ]);
      const item = items.length === 1 ? (items[0] as JsonObject) : null;
      if (
        !pythonValueEqual(mappings.get(requestId), expectedMapping) ||
        item === null ||
        !pythonValueEqual(item.get('subject'), subject) ||
        item.get('kind') !== 'merged-current' ||
        !pythonValueEqual(item.get('pr'), subject.get('pr')) ||
        !pythonValueEqual(item.get('merge_commit'), subject.get('merge_sha'))
      ) {
        refuse('reconciled request/source mismatch');
      }
      if (readEntries().entries.length >= policy.maxRequests) {
        refuse('queue request capacity refused');
      }
      await cachedForge(effects, principal, requestId, binding, policy);
      entry = new JsonObject([
        ['binding', json(binding)],
        ['principal', principal],
        ['state', 'ready-current'],
        ['pr', subject.get('pr') as JsonValue],
        ['mergeSha', subject.get('merge_sha') as JsonValue],
        ['createdAt', effects.nowIso()],
      ]);
      writeEntry(entry);
    }

    if (request.op === 'enqueue' && entry === null) {
      const limit = policy.maxRequests;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
        refuse('queue request capacity refused');
      }
      if (readEntries().entries.length >= limit) refuse('queue request capacity refused');
      let created = new JsonObject([
        ['binding', json(binding)],
        ['principal', principal],
        ['state', 'awaiting-pr'],
        ['createdAt', effects.nowIso()],
      ]);
      if (binding.kind === 'merged-current') {
        await forge(effects, binding, binding.pr, binding.mergeSha, policy);
        const enrolled = enrollMergedCurrent(queue, {
          repo: binding.repo,
          pr: binding.pr,
          mergeSha: binding.mergeSha,
          requestId,
          at: effects.nowIso(),
          targetSelector: binding.targetSelector,
        });
        queue = enrolled.queue;
        created = withObjectKeys(created, [
          ['pr', JsonNumber.int(binding.pr)],
          ['mergeSha', binding.mergeSha],
          ['state', 'ready-current'],
        ]);
      }
      entry = created;
      writeEntry(created);
    }
    if (entry === null) refuse('unknown queue request');

    if (request.op === 'retry') {
      const outcome = await retryResult({
        request,
        queue,
        entries: readEntries(),
        entry,
        binding,
        principal,
        policy,
        effects,
      });
      const encoded = await finish(outcome.result);
      await effects.saveQueue(outcome.queue);
      return encoded;
    }

    if (request.op === 'bind') {
      if (binding.kind !== 'deferred-author' || entry.get('state') === 'cancelled') {
        refuse('intent cannot be bound');
      }
      const bound = await bindIntent(request, queue, entry, binding, policy, effects);
      entry = bound.entry;
      queue = bound.queue;
      writeEntry(entry);
    }

    if (request.op === 'cancel') {
      const mappings = queue.get('merged_current_requests');
      if (mappings instanceof JsonObject && mappings.has(requestId)) {
        refuse('enrolled current work cannot be cancelled through deferred intent');
      }
      entry = withObjectKeys(entry, [['state', 'cancelled']]);
      writeEntry(entry);
    }

    let result = clientStatus(queue, requestId, entry);
    const receiptId = recordGet(result, 'receiptId');
    let snapshot: ReceiptSnapshot | null = null;
    let document: JsonObject | null = null;
    if (pyTruthy(receiptId)) {
      const item = receiptStatus(queue, requestId, effects.projectFixed);
      // Bounded status excludes capture/paths/findings; the full document is
      // read only from verified receipt bytes.
      snapshot = await loadSnapshot(effects, String(receiptId));
      document = asObjectRequired(snapshot.document, 'invalid receipt document');
      const source = asObjectOrEmpty(document.get('source'));
      if (
        recordGet(source, 'repo') !== binding.repo ||
        recordGet(source, 'target_selector') !== binding.targetSelector
      ) {
        refuse('receipt source repository/target mismatch');
      }
      const samePr = pythonValueEqual(recordGet(source, 'pr'), entry.get('pr'));
      const sameMerge = pythonValueEqual(recordGet(source, 'merge_sha'), entry.get('mergeSha'));
      if (!samePr || !sameMerge) {
        const equivalent =
          pyTruthy(item.reused_from) &&
          (reusableCurrent(document, item.capture) ||
            reusableNoncountedTerminal(document, item.capture));
        if (!equivalent) refuse('receipt source mismatch without proven equivalent reuse');
      }
      result = withObjectKeys(result, [
        [
          'receiptSource',
          new JsonObject([
            ['kind', 'merged-current'],
            ['repo', requireString(source, 'repo')],
            ['pr', source.get('pr') as JsonValue],
            ['mergeSha', requireString(source, 'merge_sha')],
            ['targetSelector', requireString(source, 'target_selector')],
          ]),
        ],
        [
          'receiptEquivalence',
          json(recordGet(asObjectOrEmpty(document.get('capture')), 'equivalence') ?? null),
        ],
      ]);
      const reviewed = countedTerminal(document);
      const outcome = recordGet(document, 'outcome');
      result = withObjectKeys(result, [
        ['reviewed', reviewed],
        [
          'state',
          reviewed
            ? pyTruthy(item.reused_from)
              ? 'reused'
              : String(outcome)
            : NONCOUNTED_STATES.has(String(outcome))
              ? String(outcome)
              : 'blocked',
        ],
        [
          'fixed',
          effects.projectFixed &&
            remediationFixed(item as unknown as JsonRecordLike, document, String(receiptId)),
        ],
      ]);
      if (recordGet(result, 'fixed') === true) {
        result = withObjectKeys(result, [
          ['remediation', remediationSummary(item as unknown as JsonRecordLike)],
        ]);
      }
      if (recordGet(result, 'state') === 'blocked') {
        result = withObjectKeys(result, [
          [
            'reason',
            fromPlainJson(
              vendorRateLimit(document) ? vendorRateLimitReason() : REASON_UNCLASSIFIED,
            ),
          ],
        ]);
      }
    } else if (recordGet(result, 'state') === 'blocked' && recordGet(result, 'reason') === null) {
      result = withObjectKeys(result, [['reason', fromPlainJson(REASON_NO_RECEIPT)]]);
    }

    const persistedReason = recordGet(entry, 'reason');
    if (persistedReason !== null && persistedReason !== undefined) {
      const persisted = clientStatusProjection(queue, requestId, entry);
      result = withObjectKeys(result, [
        ['state', 'blocked'],
        ['reviewed', false],
        ['fixed', false],
        ['reason', persisted.reason],
      ]);
      result = withoutObjectKey(result, 'remediation');
      if (request.op === 'report' || request.op === 'ack') {
        refuse('source revalidation required before receipt consumption');
      }
    } else if (
      pyTruthy(receiptId) &&
      recordGet(result, 'state') === 'blocked' &&
      document !== null &&
      recordGet(document, 'outcome') === 'blocked-secret-scan'
    ) {
      result = withObjectKeys(result, [['reason', fromPlainJson(REASON_SCAN_BLOCK)]]);
    }

    if (pyTruthy(receiptId) && (persistedReason === null || persistedReason === undefined)) {
      const alias = requestAlias(queue, request, entry, document as JsonObject, String(receiptId));
      if (alias !== null) result = withObjectKeys(result, [['requestAlias', alias]]);
    }

    if (request.op === 'report' || request.op === 'ack') {
      if (!pyTruthy(receiptId) || !pythonValueEqual(request.receiptId, receiptId)) {
        refuse('receipt/request mismatch');
      }
      const verified = snapshot as ReceiptSnapshot;
      const manifest = verified.page(null);
      const delivery = await deliveryProgress(entry, String(receiptId), {
        principal,
        requestId,
        binding,
        effects,
      });
      entry = delivery.entry;
      let progress = delivery.progress;
      if (request.op === 'report') {
        const page = verified.page((request.cursor ?? null) as string | null);
        const index = page.get('index');
        if (page.get('kind') === 'manifest') {
          progress = { manifest: true, next: progress.next };
        } else {
          const pageIndex = Number(jsonIntValue(index as JsonNumber));
          if (!progress.manifest || pageIndex > progress.next) {
            refuse('out-of-order receipt delivery');
          }
          progress = { manifest: progress.manifest, next: Math.max(progress.next, pageIndex + 1) };
        }
        await effects.updateJournal(delivery.journalKey, (previous) => {
          const merged = readProgress(previous);
          return progressObject({
            manifest: progress.manifest || merged.manifest,
            next: Math.max(progress.next, merged.next),
          });
        });
        result = new JsonObject([['page', page]]);
      } else {
        const chunks = Number(jsonIntValue(manifest.get('chunks') as JsonNumber));
        const matches =
          pythonValueEqual(request.sha256, manifest.get('sha256')) &&
          pythonValueEqual(request.chunks, manifest.get('chunks')) &&
          pythonValueEqual(request.bytes, manifest.get('bytes'));
        if (!progress.manifest || progress.next !== chunks || !matches) {
          refuse('complete verified receipt required before acknowledgement');
        }
        entry = withObjectKeys(entry, [['consumed', String(receiptId)]]);
        result = withObjectKeys(result, [['consumed', true]]);
      }
      writeEntry(entry);
    }

    const encoded = await finish(result);
    if (!readOnly) await effects.saveQueue(queue);
    return encoded;
  };

  const result = readOnly ? await effects.withReadSlot(work) : await effects.withQueueLock(work);
  if (result === null) return encodeQueueResponse(request, busyResult());
  return result;
}

// ------------------------------------------------------------------ helpers

function asObjectRequired(value: unknown, message: string): JsonObject {
  if (!(value instanceof JsonObject)) refuse(message);
  return value;
}

function mergedSubject(binding: MergedCurrentBinding): JsonObject {
  return new JsonObject([
    ['repo', binding.repo],
    ['pr', JsonNumber.int(binding.pr)],
    ['merge_sha', binding.mergeSha],
    ['target_selector', binding.targetSelector],
    ['policy', QUEUE_RECEIPT_POLICY],
  ]);
}

function readEntry(
  entries: JsonObject,
  requestId: string,
  binding: QueueBinding,
  principal: string,
): JsonObject | null {
  const existing = entries.get(requestId);
  if (entries.has(requestId) && !isJsonRecord(existing)) {
    refuse('invalid queue client entry');
  }
  if (!isJsonRecord(existing)) return null;
  if (
    !pythonValueEqual(recordGet(existing, 'binding'), binding) ||
    recordGet(existing, 'principal') !== principal
  ) {
    refuse('request binding or principal mismatch');
  }
  return existing as JsonObject;
}

function countedTerminal(document: JsonObject): boolean {
  const classification = document.get('classification');
  const outcome = document.get('outcome');
  return (
    document.get('counted') === true &&
    isJsonRecord(classification) &&
    recordGet(classification, 'counted') === true &&
    recordGet(classification, 'outcome') === 'completed' &&
    (outcome === 'terminal-clean' ||
      outcome === 'terminal-with-findings' ||
      outcome === 'partial-scope')
  );
}

/** `queue_transport._status`: the bounded projection, then nothing more. */
function clientStatus(queue: JsonObject, requestId: string, entry: JsonObject): JsonObject {
  const projection = clientStatusProjection(queue, requestId, entry);
  return new JsonObject([
    ['state', projection.state],
    ['pr', projection.pr],
    ['mergeSha', projection.mergeSha],
    ['itemId', projection.itemId],
    ['receiptId', projection.receiptId],
    ['consumed', projection.consumed],
    ['reviewed', projection.reviewed],
    ['fixed', projection.fixed],
    ['reason', projection.reason],
    ['enqueued', projection.enqueued],
    ['reusedFrom', projection.reusedFrom],
    ['receiptSource', projection.receiptSource],
    ['receiptEquivalence', projection.receiptEquivalence],
  ]);
}

async function loadSnapshot(
  effects: QueueCapabilityEffects,
  receiptId: string,
): Promise<ReceiptSnapshot> {
  const data = await effects.readReceipt(receiptId, MAX_RECEIPT_BYTES);
  return new ReceiptSnapshot(receiptId, data, MAX_RECEIPT_BYTES);
}

/** `queue_transport._forge`: compare every authorization binding to the forge. */
async function forge(
  effects: QueueCapabilityEffects,
  binding: QueueBinding,
  pr: number,
  mergeSha: string | null,
  policy: QueuePolicy,
): Promise<void> {
  const actual = await effects.verifySource(binding.repo, pr);
  if (!(actual instanceof JsonObject)) refuse('forge repository/PR mismatch');
  if (actual.get('repo') !== binding.repo || !pythonValueEqual(actual.get('pr'), pr)) {
    refuse('forge repository/PR mismatch');
  }
  const target = actual.get('target');
  if (typeof target !== 'string' || !policy.branches.includes(target)) {
    refuse('forge target branch denied');
  }
  if (binding.kind === 'deferred-author') {
    if (
      actual.get('producer') !== binding.producer ||
      actual.get('head') !== binding.head ||
      actual.get('target') !== binding.target
    ) {
      refuse('forge producer/head/target mismatch');
    }
  }
  if (mergeSha !== null) {
    if (actual.get('mergeSha') !== mergeSha || actual.get('state') !== 'MERGED') {
      refuse('forge merge mismatch');
    }
  }
}

/** `queue_transport._cached_forge`: cache only successful exact-binding checks. */
async function cachedForge(
  effects: QueueCapabilityEffects,
  principal: string,
  requestId: string,
  binding: QueueBinding,
  policy: QueuePolicy,
): Promise<void> {
  const key = receiptJsonDigest({
    principal,
    requestId,
    binding: json(binding),
    branches: json(policy.branches),
  });
  await effects.withForgeCache(key, async () => {
    if (binding.kind !== 'merged-current') refuse('reconciled read requires a merged binding');
    await forge(effects, binding, binding.pr, binding.mergeSha, policy);
  });
}

function journalKey(
  principal: string,
  requestId: string,
  binding: QueueBinding,
  receiptId: string,
): string {
  return receiptJsonDigest({ principal, requestId, binding: json(binding), receiptId });
}

interface DeliveryProgress {
  readonly manifest: boolean;
  readonly next: number;
}

function progressObject(progress: DeliveryProgress): JsonObject {
  return new JsonObject([
    ['manifest', progress.manifest],
    ['next', JsonNumber.int(progress.next)],
  ]);
}

function readProgress(value: JsonObject | null): DeliveryProgress {
  if (value === null) return { manifest: false, next: 0 };
  const manifest = value.get('manifest');
  const next = value.get('next');
  if (typeof manifest !== 'boolean' || !isJsonInt(next)) refuse('invalid delivery progress');
  return { manifest, next: Number(jsonIntValue(next as JsonNumber)) };
}

/**
 * `entry.setdefault("deliveries", {}).setdefault(receipt_id, ...)`, then the
 * journal wins when it already exists. The caller persists the returned entry.
 */
async function deliveryProgress(
  entry: JsonObject,
  receiptId: string,
  context: {
    principal: string;
    requestId: string;
    binding: QueueBinding;
    effects: QueueCapabilityEffects;
  },
): Promise<{ entry: JsonObject; progress: DeliveryProgress; journalKey: string }> {
  const deliveriesValue = entry.get('deliveries');
  if (deliveriesValue !== undefined && !(deliveriesValue instanceof JsonObject)) {
    refuse('invalid delivery progress');
  }
  const deliveries = asObjectOrEmpty(deliveriesValue);
  const stored = deliveries.get(receiptId);
  if (stored !== undefined && !(stored instanceof JsonObject)) refuse('invalid delivery progress');
  let progress = readProgress(asObject(stored));
  const key = journalKey(context.principal, context.requestId, context.binding, receiptId);
  const journal = await context.effects.readJournal(key);
  if (journal !== null) progress = readProgress(journal);
  const nextEntry = withObjectKeys(entry, [
    ['deliveries', withObjectKeys(deliveries, [[receiptId, progressObject(progress)]])],
  ]);
  return { entry: nextEntry, progress, journalKey: key };
}

/** `queue_transport._request_alias`: identity from locked state and verified bytes. */
function requestAlias(
  queue: JsonObject,
  request: QueueRequest,
  entry: JsonObject,
  document: JsonObject,
  receiptId: string,
): JsonValue | null {
  const mappings = queue.get('merged_current_requests');
  if (!(mappings instanceof JsonObject)) refuse('invalid alias request mappings');
  const alias = mappings.get(request.requestId);
  if (!isJsonRecord(alias) || !exactKeys(alias, ['binding', 'item'])) {
    refuse('missing alias request mapping');
  }
  const aliasRecord = alias as JsonObject;
  const items = queue.get('items');
  if (!Array.isArray(items)) refuse('invalid queue items');
  const matches = items.filter(
    (item) => isJsonRecord(item) && recordGet(item, 'id') === aliasRecord.get('item'),
  ) as JsonObject[];
  if (matches.length !== 1) refuse('alias requires unique item');
  const item = matches[0] as JsonObject;
  if (pyTruthy(item.get('reused_from'))) return null;
  if (item.get('request_id') === request.requestId) return null;
  const subject = aliasRecord.get('binding');
  const subjectObject = subject instanceof JsonObject ? subject : new JsonObject([]);
  const binding = request.binding as QueueBinding;
  const expected = new JsonObject([
    ['repo', binding.repo],
    ['pr', entry.get('pr') as JsonValue],
    ['merge_sha', entry.get('mergeSha') as JsonValue],
    ['target_selector', binding.targetSelector],
    ['policy', QUEUE_RECEIPT_POLICY],
  ]);
  const original = item.get('request_id');
  if (typeof original !== 'string' || original === request.requestId) {
    refuse('invalid alias item/source/original binding');
  }
  if (
    !pythonValueEqual(subject, expected) ||
    !pythonValueEqual(mappings.get(original), alias) ||
    !pythonValueEqual(item.get('subject'), subject) ||
    item.get('kind') !== 'merged-current' ||
    item.get('id') !== `current-${receiptJsonDigest(subject as JsonValue).slice(0, 32)}` ||
    !pythonValueEqual(item.get('pr'), subjectObject.get('pr')) ||
    !pythonValueEqual(item.get('merge_commit'), subjectObject.get('merge_sha')) ||
    document.get('request_id') !== original ||
    document.get('item_id') !== item.get('id') ||
    !pythonValueEqual(document.get('source'), subject) ||
    item.get('receipt_id') !== receiptId
  ) {
    refuse('invalid alias item/source/original binding');
  }
  const retained = asObjectOrEmpty(document.get('capture'));
  const capture = asObjectOrEmpty(item.get('capture'));
  const equivalence = currentEquivalence(capture);
  if (
    !pythonValueEqual(currentEquivalence(retained), equivalence) ||
    !pythonValueEqual(retained.get('equivalence'), equivalence) ||
    !pythonValueEqual(capture.get('equivalence'), equivalence)
  ) {
    refuse('alias capture equivalence mismatch');
  }
  return new JsonObject([
    ['v', JsonNumber.int(1)],
    [
      'reference',
      new JsonObject([
        ['requestId', request.requestId],
        ['binding', json(binding)],
      ]),
    ],
    ['originalRequestId', original],
    ['itemId', item.get('id') as JsonValue],
    [
      'source',
      new JsonObject([
        ['kind', 'merged-current'],
        ['repo', requireString(subjectObject, 'repo')],
        ['pr', subjectObject.get('pr') as JsonValue],
        ['mergeSha', requireString(subjectObject, 'merge_sha')],
        ['targetSelector', requireString(subjectObject, 'target_selector')],
      ]),
    ],
    ['policy', QUEUE_RECEIPT_POLICY],
    ['receiptId', receiptId],
    ['receiptEquivalence', json(equivalence)],
  ]);
}

function exactKeys(record: JsonRecordLike, keys: readonly string[]): boolean {
  const actual =
    record instanceof JsonObject
      ? record.entries.map(([key]) => key)
      : Object.keys(record as Record<string, unknown>);
  if (actual.length !== keys.length) return false;
  const wanted = new Set(keys);
  return actual.every((key) => wanted.has(key));
}

/** `queue_transport._inventory`'s wrapper read, projection and generation checks. */
async function inventoryResult(
  request: QueueRequest,
  queue: JsonObject,
  principal: string,
  effects: QueueCapabilityEffects,
): Promise<JsonObject> {
  const binding = request.binding as QueueInventoryBinding;
  const interval = normalizeInterval(binding.after, binding.before);
  const path = effects.reconcilePath(inventoryWrapperKey(binding));
  const first = parseWrapper(await effects.readReconcileWrapperText(path));
  const rawCheckpoint = asObject(first.get('checkpoint'));
  if (rawCheckpoint === null) refuse('inventory checkpoint unavailable');
  const wrapper = readReconcileWrapper(
    await effects.readReconcileWrapperText(path),
    interval,
    rawCheckpoint.get('page_budget'),
    binding.repo,
  );
  if (!pythonValueEqual(parseWrapper(await effects.readReconcileWrapperText(path)), first)) {
    return busyResult();
  }
  const checkpoint = asObject(wrapper.get('checkpoint'));
  if (checkpoint === null) refuse('inventory checkpoint unavailable');
  const result = await projectInventory({
    queue,
    checkpoint,
    binding,
    principal,
    states: request.states ?? null,
    cursor: (request.cursor ?? null) as string | null,
    limit: request.limit as number,
    projectFixed: effects.projectFixed,
    effects: {
      statSize: (receiptId) => effects.receiptSize(receiptId),
      snapshot: async (receiptId, maxBytes) => {
        const data = await effects.readReceipt(receiptId, maxBytes);
        return new ReceiptSnapshot(receiptId, data, maxBytes);
      },
    },
  });
  if (!pythonValueEqual(parseWrapper(await effects.readReconcileWrapperText(path)), first)) {
    return busyResult();
  }
  return result;
}

function parseWrapper(text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    refuse('invalid reconcile wrapper');
  }
  return asObjectRequired(parsed, 'invalid reconcile wrapper');
}

/** `queue_transport`'s retry branch: transient proof, lineage and owner liveness. */
async function retryResult(context: {
  request: QueueRequest;
  queue: JsonObject;
  entries: JsonObject;
  entry: JsonObject;
  binding: QueueBinding;
  principal: string;
  policy: QueuePolicy;
  effects: QueueCapabilityEffects;
}): Promise<{ result: JsonObject; queue: JsonObject }> {
  const { request, entries, binding, principal, policy, effects } = context;
  let queue = context.queue;
  let entry = context.entry;
  const expected = request.expectedReceiptId as string;
  let result = new JsonObject([
    ['action', 'needs-human'],
    ['accepted', false],
    ['reason', 'not-transient'],
  ]);
  const mappings = queue.get('merged_current_requests');
  const mapping = mappings instanceof JsonObject ? mappings.get(request.requestId) : undefined;
  const items = queue.get('items');
  const mapped =
    Array.isArray(items) && mapping instanceof JsonObject
      ? (items.filter(
          (item) => isJsonRecord(item) && recordGet(item, 'id') === mapping.get('item'),
        ) as JsonObject[])
      : [];
  if (binding.kind === 'deferred-author') {
    return { result: withObjectKeys(result, [['reason', 'author-dispatch']]), queue };
  }
  if (mapped.length !== 1) return { result, queue };
  const item = mapped[0] as JsonObject;
  const attemptsValue = item.get('attempts');
  if (!Array.isArray(attemptsValue)) refuse('invalid attempt history');
  const attempts = attemptsValue;
  const replayed = attempts.some(
    (attempt) =>
      isJsonRecord(attempt) &&
      recordGet(attempt, 'receipt_id') === expected &&
      recordGet(attempt, 'retry_requested') === true,
  );
  if (replayed) {
    return {
      result: new JsonObject([
        ['action', 'already-accepted'],
        ['accepted', false],
        ['reason', 'durable-replay'],
      ]),
      queue,
    };
  }
  const grant = policy.transientRetries.find(
    (candidate) =>
      candidate.principal === principal &&
      candidate.requestId === request.requestId &&
      pythonValueEqual(candidate.binding, binding),
  );
  if (grant === undefined) refuse('transient retry capability denied');
  const retryCount = entry.get('retry_count');
  const used =
    retryCount === undefined ? 0 : Number(jsonIntValue(asInt(retryCount, 'invalid retry count')));
  if (used >= grant.maxRetries) {
    return { result: withObjectKeys(result, [['reason', 'retry-limit']]), queue };
  }
  const consumed =
    pyTruthy(entry.get('consumed')) ||
    pyTruthy(item.get('consumed')) ||
    aliasConsumed(queue, entries, item);
  if (consumed) return { result: withObjectKeys(result, [['reason', 'consumed']]), queue };
  const blocked =
    item.get('receipt_id') === expected &&
    item.get('kind') === 'merged-current' &&
    item.get('state') === 'blocked' &&
    !pyTruthy(entry.get('reason'));
  if (!blocked) return { result, queue };

  const snapshot = await loadSnapshot(effects, expected);
  const document = asObjectRequired(snapshot.document, 'invalid receipt document');
  let run = item.get('run');
  const last = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
  if (!isJsonRecord(last) || recordGet(last, 'receipt_id') !== expected) {
    return { result: withObjectKeys(result, [['reason', 'ambiguous-lineage']]), queue };
  }
  if (!isJsonRecord(run)) {
    const runId = recordGet(last, 'run_id');
    if (typeof runId !== 'string' || !TOKEN.test(runId)) {
      return { result: withObjectKeys(result, [['reason', 'ambiguous-owner']]), queue };
    }
    const pidfile = await effects.readPidfile(effects.runDir(runId));
    run = new JsonObject([
      ['run_id', runId],
      ['pid', json(pidfile === null ? null : (recordGet(pidfile, 'pid') ?? null))],
    ]);
  }
  const transient = retryTransient(document);
  if (!pythonValueEqual(document.get('source'), item.get('subject')) || transient === null) {
    return { result: withObjectKeys(result, [['reason', 'not-transient']]), queue };
  }
  const runId = isJsonRecord(run) ? recordGet(run, 'run_id') : undefined;
  if (typeof runId !== 'string' || !TOKEN.test(runId)) {
    return { result: withObjectKeys(result, [['reason', 'ambiguous-owner']]), queue };
  }
  const runDir = effects.runDir(runId);
  if (!(await effects.hasExit(runDir)) || (await effects.runLiveness(runDir, run)) !== 'harvest') {
    return {
      result: withObjectKeys(result, [['reason', 'live-or-ambiguous-owner']]),
      queue,
    };
  }
  attempts[attempts.length - 1] = withObjectKeys(last, [['retry_requested', true]]);
  entry = withObjectKeys(entry, [['retry_count', JsonNumber.int(used + 1)]]);
  const nextItem = withObjectKeys(withoutObjectKey(item, 'receipt_id'), [
    ['state', 'pending'],
    ['run', null],
  ]);
  const index = (items as JsonValue[]).indexOf(item);
  if (index >= 0) (items as JsonValue[])[index] = nextItem;
  const nextEntries = withObjectKeys(entries, [[request.requestId, entry]]);
  queue = withObjectKeys(queue, [['queue_client_requests', nextEntries]]);
  return {
    result: new JsonObject([
      ['action', 'accepted'],
      ['accepted', true],
      ['reason', transient],
    ]),
    queue,
  };
}

function asInt(value: JsonValue, message: string): JsonNumber {
  if (!isJsonInt(value)) refuse(message);
  return value as JsonNumber;
}

function aliasConsumed(queue: JsonObject, entries: JsonObject, item: JsonObject): boolean {
  const mappings = queue.get('merged_current_requests');
  if (!(mappings instanceof JsonObject)) return false;
  return mappings.entries.some(([aliasId, alias]) => {
    if (!isJsonRecord(alias)) return false;
    if (!pythonValueEqual(recordGet(alias, 'item'), item.get('id'))) return false;
    const aliasEntry = entries.get(aliasId);
    return isJsonRecord(aliasEntry) && pyTruthy(recordGet(aliasEntry, 'consumed'));
  });
}

/** `bind`'s forge revalidation plus enrollment; returns the new entry and queue. */
async function bindIntent(
  request: QueueRequest,
  queue: JsonObject,
  entry: JsonObject,
  binding: DeferredAuthorBinding,
  policy: QueuePolicy,
  effects: QueueCapabilityEffects,
): Promise<{ entry: JsonObject; queue: JsonObject }> {
  const pr = request.pr as number;
  const mergeSha = request.mergeSha ?? null;
  const entryPr = entry.get('pr');
  const storedMerge = entry.get('mergeSha');
  if (entryPr !== undefined && !pythonValueEqual(entryPr, pr)) {
    refuse('conflicting PR/merge binding');
  }
  if (mergeSha !== null && storedMerge !== null && storedMerge !== undefined) {
    if (!pythonValueEqual(storedMerge, mergeSha)) refuse('conflicting PR/merge binding');
  }
  // A lost PR-only response may be replayed after merged recovery; the
  // established merge is revalidated without downgrading durable state.
  await forge(
    effects,
    binding,
    pr,
    mergeSha ?? (typeof storedMerge === 'string' ? storedMerge : null),
    policy,
  );
  let next = withoutObjectKey(entry, 'reason');
  if (storedMerge === null || storedMerge === undefined) {
    next = withObjectKeys(next, [
      ['pr', JsonNumber.int(pr)],
      ['state', 'awaiting-merge'],
    ]);
  }
  let nextQueue = queue;
  if (mergeSha !== null) {
    const enrolled = enrollMergedCurrent(nextQueue, {
      repo: binding.repo,
      pr,
      mergeSha,
      requestId: request.requestId,
      at: effects.nowIso(),
      targetSelector: binding.targetSelector,
    });
    nextQueue = enrolled.queue;
    next = withObjectKeys(next, [
      ['mergeSha', mergeSha],
      ['state', 'ready-current'],
    ]);
  }
  return { entry: next, queue: nextQueue };
}
