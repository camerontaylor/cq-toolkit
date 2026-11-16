/**
 * Queue-v1 forced-command wire contract (`queue_transport` decode/authorize).
 *
 * Operator-controlled environment identifies the caller and policy. Request
 * text selects only one exact allowlisted operation; every authority-bearing
 * field (principal, repository, target, branches, grants) comes from the
 * validated policy, never from caller JSON. Frames are bounded, JSON duplicate
 * keys are refused, and every operation has an exact field set, so a caller
 * cannot smuggle an unvalidated field past the handler.
 *
 * This module is pure: it parses, validates, authorizes and encodes. Queue and
 * receipt access belong to `src/ops/crq/queueCapability.ts`.
 */
import { JsonNumber, JsonObject, parseJsonValue, type JsonValue } from './jsonValue.js';
import { compareCodePoints, receiptJsonText } from './pythonJson.js';
import { branchPathFault } from '../../shared/refname.js';
import { QUEUE_SELECTORS, QueueRefused, refuseQueue, type QueueSelector } from './queueReceipt.js';
import {
  isJsonRecord,
  pythonValueEqual,
  recordGet,
  recordHas,
  type JsonRecordLike,
} from './queueDoc.js';
import { normalizeInterval } from './reconcileCheckpoint.js';

/** `queue_transport.MAX_BYTES`: one request or response frame, including the newline. */
export const QUEUE_WIRE_BYTES = 8192;
/** Operations served without the scheduler lock. */
export const QUEUE_READ_OPS = new Set(['status', 'report', 'health']);
/** Operations that mutate durable queue state. */
export const QUEUE_WRITE_OPS = new Set([
  'enqueue',
  'bind',
  'cancel',
  'ack',
  'retry',
  'retry-capability',
]);
/** `policy.transient_retries[].maxRetries` default. */
export const DEFAULT_MAX_RETRIES = 3;
/** `policy.max_requests` default and cap. */
export const DEFAULT_MAX_REQUESTS = 10000;
export const MAX_REQUESTS_CAP = 100000;

/** The one extra field set each operation may carry (`queue_transport.decode`). */
const EXTRA_FIELDS = new Map<string, readonly string[]>([
  ['retry', ['expectedReceiptId']],
  ['bind', ['pr', 'mergeSha']],
  ['report', ['receiptId', 'cursor']],
  ['ack', ['receiptId', 'sha256', 'chunks', 'bytes']],
]);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const INVENTORY_STATES = new Set([
  'pending',
  'reviewed',
  'reused',
  'no-current-code',
  'partial-scope',
  'unsupported',
  'consumed',
  'fixed',
  'blocked',
  'missing',
]);

export interface DeferredAuthorBinding {
  readonly kind: 'deferred-author';
  readonly repo: string;
  readonly producer: string;
  readonly head: string;
  readonly target: string;
  readonly targetSelector: QueueSelector;
}
export interface MergedCurrentBinding {
  readonly kind: 'merged-current';
  readonly repo: string;
  readonly pr: number;
  readonly mergeSha: string;
  readonly targetSelector: QueueSelector;
}
export type QueueBinding = DeferredAuthorBinding | MergedCurrentBinding;

export interface QueueHealthBinding {
  readonly repo: string;
  readonly targetSelector: QueueSelector;
}
export interface QueueInventoryBinding extends QueueHealthBinding {
  readonly after: string;
  readonly before: string;
}

export type QueueOperation =
  | 'status'
  | 'report'
  | 'health'
  | 'inventory'
  | 'enqueue'
  | 'bind'
  | 'cancel'
  | 'ack'
  | 'retry'
  | 'retry-capability';

export interface QueueRequest {
  readonly op: QueueOperation;
  readonly requestId: string;
  readonly binding: QueueBinding | QueueHealthBinding | QueueInventoryBinding;
  readonly pr?: number;
  readonly mergeSha?: string | null;
  readonly expectedReceiptId?: string;
  readonly receiptId?: unknown;
  readonly cursor?: unknown;
  readonly sha256?: unknown;
  readonly chunks?: unknown;
  readonly bytes?: unknown;
  readonly limit?: number;
  readonly states?: readonly string[] | null;
}

export interface TransientRetryGrant {
  readonly principal: string;
  readonly requestId: string;
  readonly binding: QueueBinding;
  readonly maxRetries: number;
}
export interface ReconciledReadGrant {
  readonly principal: string;
  readonly requestId: string;
  readonly binding: MergedCurrentBinding;
}
export interface InventoryReadGrant {
  readonly principal: string;
  readonly binding: QueueInventoryBinding;
}
export interface HealthReadGrant {
  readonly principal: string;
  readonly binding: QueueHealthBinding;
}

export interface QueuePolicy {
  readonly enabled: boolean;
  readonly repo: string;
  readonly repos: readonly string[];
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly targets: readonly string[];
  readonly branches: readonly string[];
  readonly transientRetries: readonly TransientRetryGrant[];
  readonly reconciledReads: readonly ReconciledReadGrant[];
  readonly inventoryReads: readonly InventoryReadGrant[];
  readonly healthReads: readonly HealthReadGrant[];
  readonly maxRequests: number;
}

function asObject(value: unknown): JsonObject | null {
  return value instanceof JsonObject ? value : null;
}

function exactFields(object: JsonRecordLike, fields: readonly string[]): boolean {
  const keys =
    object instanceof JsonObject
      ? object.entries.map(([key]) => key)
      : Object.keys(object as Record<string, unknown>);
  if (keys.length !== fields.length) return false;
  const wanted = new Set(fields);
  return keys.every((key) => wanted.has(key));
}

function tokenValue(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

function intValue(value: unknown): number {
  if (value instanceof JsonNumber && value.kind === 'int') {
    const asNumber = Number(value.integer as bigint);
    if (Number.isSafeInteger(asNumber)) return asNumber;
  }
  refuseQueue('invalid integer');
}

function isInt(value: unknown): boolean {
  return value instanceof JsonNumber && value.kind === 'int';
}

function listOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) refuseQueue('invalid queue policy allowlist');
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      refuseQueue('invalid queue policy allowlist');
    }
    return entry;
  });
}

function selectorOf(value: unknown): QueueSelector {
  if (typeof value !== 'string' || !(QUEUE_SELECTORS as readonly string[]).includes(value)) {
    refuseQueue('invalid repository or target selector');
  }
  return value as QueueSelector;
}

/** `queue_transport.binding`: an exact immutable request binding. */
export function decodeBinding(value: unknown): QueueBinding {
  if (!isJsonRecord(value)) refuseQueue('invalid binding');
  const kind = recordGet(value, 'kind');
  const fields =
    kind === 'deferred-author'
      ? ['kind', 'repo', 'producer', 'head', 'target', 'targetSelector']
      : ['kind', 'repo', 'pr', 'mergeSha', 'targetSelector'];
  if ((kind !== 'deferred-author' && kind !== 'merged-current') || !exactFields(value, fields)) {
    refuseQueue('invalid binding fields');
  }
  const repo = recordGet(value, 'repo');
  if (typeof repo !== 'string' || !REPO.test(repo)) {
    refuseQueue('invalid repository or target selector');
  }
  const targetSelector = selectorOf(recordGet(value, 'targetSelector'));
  if (kind === 'deferred-author') {
    const producer = recordGet(value, 'producer');
    const head = recordGet(value, 'head');
    const target = recordGet(value, 'target');
    if (
      !tokenValue(producer) ||
      typeof head !== 'string' ||
      !SHA.test(head) ||
      typeof target !== 'string' ||
      branchPathFault(target) !== null
    ) {
      refuseQueue('invalid producer/head/target');
    }
    return { kind, repo, producer, head, target, targetSelector };
  }
  const pr = recordGet(value, 'pr');
  const mergeSha = recordGet(value, 'mergeSha');
  if (!isInt(pr) || intValue(pr) <= 0 || typeof mergeSha !== 'string' || !SHA.test(mergeSha)) {
    refuseQueue('invalid merged source');
  }
  return { kind, repo, pr: intValue(pr), mergeSha, targetSelector };
}

/** `queue_transport._health_binding`: a repo/selector pair and nothing else. */
export function decodeHealthBinding(value: unknown): QueueHealthBinding {
  if (
    !isJsonRecord(value) ||
    !exactFields(value, ['repo', 'targetSelector']) ||
    typeof recordGet(value, 'repo') !== 'string' ||
    !REPO.test(recordGet(value, 'repo') as string)
  ) {
    refuseQueue('invalid health binding');
  }
  return {
    repo: recordGet(value, 'repo') as string,
    targetSelector: selectorOf(recordGet(value, 'targetSelector')),
  };
}

/** `queue_transport._inventory_binding`: a frozen `(after, before]` interval. */
export function decodeInventoryBinding(value: unknown): QueueInventoryBinding {
  if (
    !isJsonRecord(value) ||
    !exactFields(value, ['repo', 'targetSelector', 'after', 'before']) ||
    typeof recordGet(value, 'repo') !== 'string' ||
    !REPO.test(recordGet(value, 'repo') as string)
  ) {
    refuseQueue('invalid inventory binding');
  }
  const repo = recordGet(value, 'repo') as string;
  const targetSelector = selectorOf(recordGet(value, 'targetSelector'));
  const interval = normalizeInterval(recordGet(value, 'after'), recordGet(value, 'before'));
  return { repo, targetSelector, after: interval.after, before: interval.before };
}

/**
 * `queue_transport.validate_policy`: operator policy is typed configuration,
 * never truthy activation or substring ACLs.
 */
export function validateQueuePolicy(value: unknown): QueuePolicy {
  if (!isJsonRecord(value) || Array.isArray(value)) refuseQueue('invalid queue policy object');
  const policy = value;
  const enabled = recordGet(policy, 'enabled');
  if (recordHas(policy, 'enabled') && typeof enabled !== 'boolean') {
    refuseQueue('invalid queue policy enabled boolean');
  }
  const repo = recordGet(policy, 'repo');
  if (typeof repo !== 'string' || !REPO.test(repo)) {
    refuseQueue('invalid queue policy repository');
  }
  const repos = recordHas(policy, 'repos') ? listOfStrings(recordGet(policy, 'repos')) : [];
  if (repos.some((entry) => !REPO.test(entry))) refuseQueue('invalid queue policy repositories');
  const read = recordHas(policy, 'read') ? listOfStrings(recordGet(policy, 'read')) : [];
  const write = recordHas(policy, 'write') ? listOfStrings(recordGet(policy, 'write')) : [];
  const targets = recordHas(policy, 'targets') ? listOfStrings(recordGet(policy, 'targets')) : [];
  const branches = recordHas(policy, 'branches')
    ? listOfStrings(recordGet(policy, 'branches'))
    : [];
  for (const target of targets) {
    if (!(QUEUE_SELECTORS as readonly string[]).includes(target)) {
      refuseQueue('invalid queue policy target');
    }
  }
  const transientRetries = decodeTransientRetries(recordGet(policy, 'transient_retries'), repo);
  const reconciledReads = decodeReconciledReads(recordGet(policy, 'reconciled_reads'), repo);
  const inventoryReads = decodeInventoryReads(recordGet(policy, 'inventory_reads'), repo);
  const healthReads = decodeHealthReads(recordGet(policy, 'health_reads'), repo);
  const limit = recordHas(policy, 'max_requests') ? recordGet(policy, 'max_requests') : undefined;
  if (limit !== undefined && !isInt(limit)) refuseQueue('invalid queue policy capacity');
  const maxRequests = limit === undefined ? DEFAULT_MAX_REQUESTS : intValue(limit);
  if (maxRequests < 1 || maxRequests > MAX_REQUESTS_CAP) {
    refuseQueue('invalid queue policy capacity');
  }
  return {
    enabled: enabled === true,
    repo,
    repos,
    read,
    write,
    targets,
    branches,
    transientRetries,
    reconciledReads,
    inventoryReads,
    healthReads,
    maxRequests,
  };
}

function decodeTransientRetries(value: unknown, repo: string): TransientRetryGrant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuseQueue('invalid transient retry grants');
  return value.map((grant) => {
    if (
      !isJsonRecord(grant) ||
      !['principal', 'requestId', 'binding'].every((key) => recordHas(grant, key)) ||
      entryKeys(grant).some(
        (key) => !['principal', 'requestId', 'binding', 'maxRetries'].includes(key),
      )
    ) {
      refuseQueue('invalid transient retry grant');
    }
    const principal = recordGet(grant, 'principal');
    const requestId = recordGet(grant, 'requestId');
    const maxRetriesValue = recordHas(grant, 'maxRetries')
      ? recordGet(grant, 'maxRetries')
      : undefined;
    const maxRetries =
      maxRetriesValue === undefined ? DEFAULT_MAX_RETRIES : intValue(maxRetriesValue);
    if (
      (maxRetriesValue !== undefined && !isInt(maxRetriesValue)) ||
      maxRetries < 1 ||
      maxRetries > 100 ||
      typeof principal !== 'string' ||
      principal.length === 0 ||
      !tokenValue(requestId)
    ) {
      refuseQueue('invalid transient retry grant');
    }
    const binding = decodeBinding(recordGet(grant, 'binding'));
    if (binding.repo !== repo) refuseQueue('invalid transient retry grant');
    return { principal, requestId, binding, maxRetries };
  });
}

function decodeReconciledReads(value: unknown, repo: string): ReconciledReadGrant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuseQueue('invalid reconciled read grants');
  const granted = new Set<string>();
  return value.map((grant) => {
    if (
      !isJsonRecord(grant) ||
      !exactFields(grant, ['principal', 'requestId', 'binding']) ||
      typeof recordGet(grant, 'principal') !== 'string' ||
      (recordGet(grant, 'principal') as string).length === 0 ||
      !tokenValue(recordGet(grant, 'requestId'))
    ) {
      refuseQueue('invalid reconciled read grant');
    }
    const requestId = recordGet(grant, 'requestId') as string;
    if (granted.has(requestId)) refuseQueue('duplicate reconciled read request id');
    granted.add(requestId);
    const binding = decodeBinding(recordGet(grant, 'binding'));
    if (binding.kind !== 'merged-current' || binding.repo !== repo) {
      refuseQueue('invalid reconciled read binding');
    }
    return { principal: recordGet(grant, 'principal') as string, requestId, binding };
  });
}

function decodeInventoryReads(value: unknown, repo: string): InventoryReadGrant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuseQueue('invalid inventory grants');
  return value.map((grant) => {
    if (
      !isJsonRecord(grant) ||
      !exactFields(grant, ['principal', 'binding']) ||
      typeof recordGet(grant, 'principal') !== 'string' ||
      (recordGet(grant, 'principal') as string).length === 0
    ) {
      refuseQueue('invalid inventory grant');
    }
    const binding = decodeInventoryBinding(recordGet(grant, 'binding'));
    if (binding.repo !== repo) refuseQueue('inventory repository denied');
    return { principal: recordGet(grant, 'principal') as string, binding };
  });
}

function decodeHealthReads(value: unknown, repo: string): HealthReadGrant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuseQueue('invalid health grants');
  return value.map((grant) => {
    if (
      !isJsonRecord(grant) ||
      !exactFields(grant, ['principal', 'binding']) ||
      typeof recordGet(grant, 'principal') !== 'string' ||
      (recordGet(grant, 'principal') as string).length === 0
    ) {
      refuseQueue('invalid health grant');
    }
    const binding = decodeHealthBinding(recordGet(grant, 'binding'));
    if (binding.repo !== repo) refuseQueue('invalid health grant');
    return { principal: recordGet(grant, 'principal') as string, binding };
  });
}

/** The keys of a lossless or plain object. */
function entryKeys(value: JsonRecordLike): string[] {
  return value instanceof JsonObject
    ? value.entries.map(([key]) => key)
    : Object.keys(value as Record<string, unknown>);
}

/**
 * `queue_transport.decode`: one bounded, strictly validated version-1 request.
 */
export function decodeQueueRequest(raw: Uint8Array): QueueRequest {
  if (raw.length > QUEUE_WIRE_BYTES) refuseQueue('queue request exceeds bound');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    refuseQueue('invalid queue request encoding');
  }
  let parsed: JsonValue;
  try {
    // Python's `object_pairs_hook` refuses duplicate keys.
    parsed = parseJsonValue(text, { duplicates: 'error' });
  } catch (error) {
    if (error instanceof RangeError) refuseQueue('queue request nesting exceeds bound');
    refuseQueue('invalid queue request');
  }
  const request = asObject(parsed);
  if (request === null) refuseQueue('unsupported queue protocol');
  const version = request.get('v');
  if (!isInt(version) || intValue(version) !== 1) refuseQueue('unsupported queue protocol');
  const op = request.get('op');
  if (typeof op !== 'string') refuseQueue('invalid queue operation/fields');
  if (op === 'health') {
    if (
      !exactFields(request, ['v', 'op', 'requestId', 'binding']) ||
      !tokenValue(request.get('requestId'))
    ) {
      refuseQueue('invalid health fields');
    }
    return {
      op,
      requestId: request.get('requestId') as string,
      binding: decodeHealthBinding(request.get('binding')),
    };
  }
  if (op === 'inventory') {
    if (!exactFields(request, ['v', 'op', 'requestId', 'binding', 'cursor', 'limit', 'states'])) {
      refuseQueue('invalid inventory fields');
    }
    const binding = decodeInventoryBinding(request.get('binding'));
    const requestId = request.get('requestId');
    const limit = request.get('limit');
    const cursor = request.get('cursor');
    const states = request.get('states');
    if (
      !tokenValue(requestId) ||
      !isInt(limit) ||
      intValue(limit) < 1 ||
      intValue(limit) > 10 ||
      (cursor !== null && typeof cursor !== 'string') ||
      (states !== null &&
        (!Array.isArray(states) ||
          states.some((state) => typeof state !== 'string' || !INVENTORY_STATES.has(state))))
    ) {
      refuseQueue('invalid inventory pagination/filter');
    }
    return {
      op,
      requestId,
      binding,
      cursor: cursor as string | null,
      limit: intValue(limit),
      states: states === null ? null : [...new Set(states as string[])].sort(compareCodePoints),
    };
  }
  const extra = EXTRA_FIELDS.get(op) ?? [];
  if (
    (!QUEUE_READ_OPS.has(op) && !QUEUE_WRITE_OPS.has(op)) ||
    !exactFields(request, ['v', 'op', 'requestId', 'binding', ...extra])
  ) {
    refuseQueue('invalid queue operation/fields');
  }
  const requestId = request.get('requestId');
  if (!tokenValue(requestId)) refuseQueue('invalid request id');
  const binding = decodeBinding(request.get('binding'));
  if (op === 'bind') {
    const pr = request.get('pr');
    const mergeSha = request.get('mergeSha');
    if (
      !isInt(pr) ||
      intValue(pr) <= 0 ||
      (mergeSha !== null && (typeof mergeSha !== 'string' || !SHA.test(mergeSha)))
    ) {
      refuseQueue('invalid PR binding');
    }
    return { op, requestId, binding, pr: intValue(pr), mergeSha: mergeSha as string | null };
  }
  if (op === 'retry') {
    const expected = request.get('expectedReceiptId');
    if (typeof expected !== 'string' || !DIGEST.test(expected)) {
      refuseQueue('retry requires expected receipt');
    }
    return { op, requestId, binding, expectedReceiptId: expected };
  }
  if (op === 'report') {
    return {
      op,
      requestId,
      binding,
      receiptId: request.get('receiptId'),
      cursor: request.get('cursor'),
    };
  }
  if (op === 'ack') {
    return {
      op,
      requestId,
      binding,
      receiptId: request.get('receiptId'),
      sha256: request.get('sha256'),
      chunks: request.get('chunks'),
      bytes: request.get('bytes'),
    };
  }
  return { op: op as QueueOperation, requestId, binding };
}

/**
 * `queue_transport.authorize`: principal/repository/target/selector binding from
 * operator policy, with per-operation grants.
 */
export function authorizeQueueRequest(
  request: QueueRequest,
  principal: string,
  policy: QueuePolicy,
): void {
  const op = request.op;
  const binding = request.binding as {
    repo?: unknown;
    targetSelector?: unknown;
    kind?: unknown;
    target?: unknown;
  };
  const allowed = QUEUE_WRITE_OPS.has(op) ? policy.write : policy.read;
  if (
    !allowed.includes(principal) ||
    binding.repo !== policy.repo ||
    !policy.targets.includes(binding.targetSelector as string)
  ) {
    refuseQueue('queue capability denied');
  }
  if (
    op === 'health' &&
    !policy.healthReads.some(
      (grant) => grant.principal === principal && pythonValueEqual(grant.binding, request.binding),
    )
  ) {
    refuseQueue('health capability denied');
  }
  if (
    (op === 'retry' || op === 'retry-capability') &&
    !policy.transientRetries.some(
      (grant) =>
        grant.principal === principal &&
        grant.requestId === request.requestId &&
        pythonValueEqual(grant.binding, request.binding),
    )
  ) {
    refuseQueue('transient retry capability denied');
  }
  if (
    op === 'inventory' &&
    !policy.inventoryReads.some(
      (grant) => grant.principal === principal && pythonValueEqual(grant.binding, request.binding),
    )
  ) {
    refuseQueue('inventory capability denied');
  }
  if (
    op !== 'inventory' &&
    op !== 'health' &&
    binding.kind === 'deferred-author' &&
    !policy.branches.includes(binding.target as string)
  ) {
    refuseQueue('target branch denied');
  }
}

/** `queue_transport._encode`: receipt-canonical response bytes plus a newline. */
export function encodeQueueResponse(request: QueueRequest, result: unknown): Uint8Array {
  const text = `${receiptJsonText({
    v: 1,
    requestId: request.requestId,
    binding: request.binding,
    result: result as JsonValue,
  })}\n`;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > QUEUE_WIRE_BYTES) refuseQueue('queue response exceeds wire bound');
  return bytes;
}

/** Re-exported so callers catch one refusal type across the wire layer. */
export { QueueRefused };
export type { JsonRecordLike };
