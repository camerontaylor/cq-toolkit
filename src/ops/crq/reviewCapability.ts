/**
 * review-v1 forced-command state machine (`review_transport`).
 *
 * The operator supplies the principal and policy through the environment; the
 * frame only selects an allowlisted operation and one immutable request. Reads
 * run without the scheduler lock, writes take `tick.lock` and persist before
 * the response. Every refusal is either the one typed wire error (invalid
 * input, snapshot refusal, unavailable result) or the opaque forced-command
 * refusal the entrypoint emits.
 */
import { fromPlainJson, pythonValueEqual } from '../../policy/crq/queueDoc.js';
import { JsonNumber, JsonObject } from '../../policy/crq/jsonValue.js';
import { parseJsonValue, toPlainJson } from '../../policy/crq/jsonValue.js';
import { receiptJsonText, sha256Hex } from '../../policy/crq/pythonJson.js';
import { validateQueuePolicy, type QueuePolicy } from '../../policy/crq/queueWire.js';
import {
  ValueError,
  admit,
  cancelRequest,
  itemFields,
  keyDigest,
  readRequest,
  replaceItem,
  replaceRequest,
  reviewStatus,
} from '../../policy/crq/reviewAdmission.js';
import {
  historyCue,
  historyQuery,
  projectHistory,
  degradedHistory,
  type GitFn,
} from '../../policy/crq/reviewHistory.js';
import {
  notifyDestination,
  notifyValidation,
  updateNotify,
  withdrawNotify,
} from '../../policy/crq/reviewNotify.js';
import { reviewResultChunk, REVIEW_CHUNK_BYTES } from '../../policy/crq/reviewReceipt.js';
import {
  MAX_REPORT_BYTES,
  RecordRefused,
  eventExceedsPublisherBound,
  importRecord,
  quarantineEvent,
  quarantineSourceKey,
  type SubmittedRecord,
} from '../../policy/crq/reviewRecord.js';
import { LedgerIntegrityError, ledgerDigestOf, ledgerValidate } from '../../policy/crq/ledger.js';
import { AuthorRefused } from '../../policy/crq/authorWire.js';
import {
  HistorySchema,
  ReceiptSchema,
  RecordResponseSchema,
  ResponseSchema,
  WireSchema,
} from '../review/internal/reviewOperation.js';

export const REVIEW_MAX_BYTES = 6 * 1024 * 1024;
export const REVIEW_MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
export const REVIEW_CHUNK_LIMIT = REVIEW_CHUNK_BYTES;
export const REVIEW_MAX_ORIGINAL_CONTENT = 3 * 1024 * 1024;
export const REVIEW_MAX_OBJECTS = 4096;

const OPERATIONS = [
  'capabilities',
  'submit',
  'status',
  'result',
  'cancel',
  'notify-update',
  'review-history',
  'record',
] as const;
const FEATURES = [
  'original-commit-snapshot-v1',
  'chunked-result-v1',
  'repeat-generations-v1',
  'review-history-v1',
  'review-record-v1',
] as const;
const READ_ONLY = new Set(['capabilities', 'status', 'result', 'review-history']);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

/** One runner effect set for the review capability. */
export interface ReviewCapabilityEffects {
  /** `crq.REPO`. */
  readonly runnerRepo: string;
  /** The validated runner config (`CONFIG`), including `notify` and profiles. */
  readonly config: JsonObject;
  /** `crq.iso()`. */
  readonly nowIso: () => string;
  readonly loadQueue: () => Promise<JsonObject>;
  readonly saveQueue: (queue: JsonObject) => Promise<void>;
  /** Run `work` under `tick.lock`, waiting at most `waitMs`; `null` means busy. */
  readonly withQueueLock: <T>(work: () => Promise<T>, waitMs: number) => Promise<T | null>;
  /** Read one receipt's bytes; a missing file is an ENOENT error. */
  readonly readReceipt: (receiptId: string) => Promise<Uint8Array>;
  /** True when `repo` has a configured clone this runner may serve. */
  readonly isConfiguredRepo: (repo: string) => boolean;
  /** True when the commit object is present in the repository's clone. */
  readonly hasCommit: (repo: string, commit: string) => Promise<boolean>;
  /** Fetch the repository's clone when a required object is absent. */
  readonly fetchRepo: (repo: string) => Promise<void>;
  /** Install a version-2 snapshot into the repository clone, bound to the commit. */
  readonly installSnapshot: (
    repo: string,
    snapshot: JsonObject,
    binding: { readonly base: string; readonly head: string },
  ) => Promise<void>;
  /** Resolve all hashed facts from installed immutable objects. */
  readonly resolveIdentity: (
    repo: string,
    inputs: JsonObject,
    profile: JsonObject,
  ) => Promise<JsonObject>;
  /** A Git adapter for the repository clone; throws `GitUnavailable`. */
  readonly historyGit: (repo: string) => GitFn;
  /** Retained record events for import idempotency, newest-compatible order. */
  readonly retainedRecords: () => Promise<JsonObject[]>;
  /** The durable rollout settings, or `null` when no rollout is configured. */
  readonly rolloutSettings: () => Promise<JsonObject | null>;
  /** Put report bytes into the configured artifact store; returns its reference. */
  readonly putReport: (bytes: Uint8Array) => Promise<JsonObject>;
  /** Validate and spool one event into the same outbox the publisher drains. */
  readonly spoolEvent: (event: JsonObject) => Promise<void>;
  /** Ask the publisher to drain the spool on its next pass. */
  readonly requestPublication: () => Promise<void>;
  /** Append one `events.jsonl` audit line. */
  readonly audit: (kind: string, data: JsonObject) => Promise<void>;
}

export interface ReviewCapabilityInput {
  readonly raw: Uint8Array;
  readonly principal: string;
  readonly policy: unknown;
}

/** Serve one review-v1 frame and return the canonical response bytes. */
export async function runReviewCapability(
  input: ReviewCapabilityInput,
  effects: ReviewCapabilityEffects,
): Promise<Uint8Array> {
  let request: JsonObject;
  try {
    request = decodeReviewRequest(input.raw);
  } catch (error) {
    return errorResponse(error);
  }
  const policy = validateQueuePolicy(input.policy);
  if (!policy.write.includes(input.principal)) throw new ValueError('review principal denied');
  const op = request.get('op');
  if (typeof op !== 'string') throw new ValueError('unsupported operation');
  if (op === 'capabilities') return encode(capabilities());
  if (policy.enabled !== true) {
    return encode(
      new JsonObject([
        ['v', JsonNumber.int(1)],
        ['action', 'observed'],
        ['state', 'unsupported'],
        ['reason', 'review-disabled'],
      ]),
    );
  }
  if (op === 'record') {
    const early = await recordPolicyRefusal(request, policy, effects);
    if (early !== null) return encode(early);
  }
  if (READ_ONLY.has(op)) {
    return handle(request, input.principal, policy, effects);
  }
  let result: Uint8Array | null;
  try {
    result = await effects.withQueueLock(
      () => handle(request, input.principal, policy, effects),
      2000,
    );
  } catch (error) {
    // The supervised worker cannot prove whether the write committed; the
    // request id lets the caller retry and recover its durable receipt.
    if (isTypedWriteError(error)) throw error;
    return encode(
      errorDocument(
        'unavailable',
        'review worker outcome unavailable; retry the same request id',
        true,
      ),
    );
  }
  if (result === null) {
    return encode(errorDocument('busy', 'review queue lock busy; retry the same request id', true));
  }
  return result;
}

function capabilities(): JsonObject {
  return new JsonObject([
    ['v', JsonNumber.int(1)],
    ['command', 'review-v1'],
    ['operations', [...OPERATIONS]],
    ['features', [...FEATURES]],
    [
      'limits',
      new JsonObject([
        ['max_request_bytes', JsonNumber.int(REVIEW_MAX_BYTES)],
        ['max_snapshot_bytes', JsonNumber.int(REVIEW_MAX_SNAPSHOT_BYTES)],
        ['max_content_bytes', JsonNumber.int(REVIEW_MAX_ORIGINAL_CONTENT)],
        ['max_objects', JsonNumber.int(REVIEW_MAX_OBJECTS)],
        ['chunk_bytes', JsonNumber.int(REVIEW_CHUNK_BYTES)],
      ]),
    ],
  ]);
}

/** `review_transport.decode`; duplicate keys and missing newline refuse. */
export function decodeReviewRequest(raw: Uint8Array): JsonObject {
  if (raw.length > REVIEW_MAX_BYTES) {
    throw new ValueError('review request exceeds 6 MiB; reduce the commit range');
  }
  if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) {
    throw new ValueError('invalid JSON request');
  }
  let parsed: unknown;
  try {
    parsed = parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(raw), {
      duplicates: 'error',
    });
  } catch {
    throw new ValueError('invalid JSON request');
  }
  if (!(parsed instanceof JsonObject)) throw new ValueError('invalid JSON request');
  const plain = toPlainJson(parsed);
  const validated = WireSchema.safeParse(plain);
  if (!validated.success) throw new ValueError('invalid review request');
  const request = fromPlainJson(parsed);
  if (!(request instanceof JsonObject)) throw new ValueError('invalid review request');
  const snapshot = request.get('snapshot');
  if (
    snapshot instanceof JsonObject &&
    receiptJsonText(snapshot).length > REVIEW_MAX_SNAPSHOT_BYTES
  ) {
    throw new ValueError(
      'snapshot exceeds 5 MiB; reduce the commit range or use reachable objects',
    );
  }
  return request;
}

async function handle(
  request: JsonObject,
  principal: string,
  policy: QueuePolicy,
  effects: ReviewCapabilityEffects,
): Promise<Uint8Array> {
  const op = request.get('op');
  if (typeof op !== 'string') throw new ValueError('unsupported operation');
  let queue = await effects.loadQueue();
  let result: JsonObject;
  switch (op) {
    case 'record':
      return encode(
        ResultValidator.record((await recordImport(queue, request, principal, effects)).result),
      );
    case 'submit': {
      const submitted = await submit(queue, request, principal, policy, effects);
      queue = submitted.queue;
      return encode(validateResult('response', submitted.result));
    }
    case 'notify-update':
      result = await notifyUpdate(queue, request, principal, effects);
      return encode(validateResult('response', result));
    case 'cancel': {
      const cancelled = cancelRequest(queue, stringRequired(request, 'request_id'), withdrawNotify);
      await effects.saveQueue(cancelled.queue);
      return encode(validateResult('response', cancelled.result));
    }
    case 'review-history':
      result = await reviewHistory(queue, request, effects);
      return encode(ResultValidator.history(result));
    default:
      result = await statusOrResult(queue, request, effects);
      return encode(ResultValidator.response(result));
  }
}

async function submit(
  queue: JsonObject,
  request: JsonObject,
  principal: string,
  policy: QueuePolicy,
  effects: ReviewCapabilityEffects,
): Promise<{ readonly queue: JsonObject; readonly result: JsonObject }> {
  const requestId = stringRequired(request, 'request_id');
  const inputs = objectRequired(request, 'inputs');
  const repeat = request.get('repeat') === true;
  const repo = stringRequired(inputs, 'repo');
  const target = stringRequired(inputs, 'target');
  const allowed = [policy.repo, ...policy.repos];
  if (!allowed.includes(repo) || !effects.isConfiguredRepo(repo)) {
    return {
      queue,
      result: new JsonObject([
        ['v', JsonNumber.int(1)],
        ['action', 'observed'],
        ['state', 'unsupported'],
        ['reason', 'unsupported-repo'],
      ]),
    };
  }
  if (!policy.branches.includes(target)) throw new ValueError('target branch denied');
  const key = keyDigest(inputs, repeat);
  const replay = replayRequest(queue, requestId, key);
  if (replay !== null) {
    const history = await historyProjection(
      queue,
      effects,
      historyDefaults(historyQuery(queue, readRequest(queue, requestId)!)),
    );
    return { queue, result: withField(replay, 'history', historyCue(history)) };
  }

  const snapshot = objectOrNull(request.get('snapshot'));
  const needed =
    snapshot === null
      ? [stringRequired(inputs, 'base_commit'), stringRequired(inputs, 'head_commit')]
      : [stringRequired(inputs, 'base_commit')];
  for (const commit of needed) {
    if (!(await effects.hasCommit(repo, commit))) {
      await effects.fetchRepo(repo);
      break;
    }
  }
  if (snapshot !== null) {
    if (snapshot.get('tree') !== inputs.get('head_tree')) {
      throw new ValueError('snapshot tree mismatch');
    }
    await effects.installSnapshot(repo, snapshot, {
      base: stringRequired(inputs, 'base_commit'),
      head: stringRequired(inputs, 'head_commit'),
    });
  }
  const stored = reviewProfile(effects.config, stringRequired(inputs, 'base_commit'));
  const facts = await effects.resolveIdentity(repo, inputs, stored);
  const repeatHistory = await historyProjection(queue, effects, {
    repo,
    target,
    headCommit: nullableString(inputs, 'head_commit'),
    headTree: nullableString(inputs, 'head_tree'),
    task: nullableString(request, 'task'),
    branch: nullableString(request, 'branch'),
    predecessor: nullableString(request, 'predecessor'),
    observed: objectOrNull(request.get('observed')),
    limit: 20,
    cursor: 0,
    excludeItem: null,
  });
  const acceptedNotify = request.has('notify')
    ? notifyDestination(request.get('notify'), effects.config)
    : null;
  const verifiedReceipts = await retainedReceiptIds(queue, effects);
  const admitted = admit(queue, {
    requestId,
    inputs,
    resolved: facts,
    profile: stored,
    at: effects.nowIso(),
    repeat,
    ancestryRepeat: repeatHistory.get('repeat') === true,
    ...(nullableString(request, 'supersedes') === null
      ? {}
      : { supersedes: nullableString(request, 'supersedes') as string }),
    ...(acceptedNotify === null ? {} : { notify: acceptedNotify }),
    verifyReceipt: (item) => verifiedReceipts.has(itemFields(item).receiptId ?? ''),
  });
  queue = admitted.queue;
  let result = admitted.result;
  const binding = readRequest(queue, requestId);
  if (binding === null) throw new ValueError('unknown review request');
  const itemId = stringRequired(binding, 'item');
  let nextBinding = withField(binding, 'principal', principal);
  for (const field of ['task', 'branch', 'predecessor', 'observed'] as const) {
    if (request.has(field))
      nextBinding = withField(nextBinding, field, request.get(field) as never);
  }
  if (result.get('action') === 'created') {
    const item = findItem(queue, itemId);
    if (item !== null) {
      let nextItem = item;
      for (const field of ['task', 'branch'] as const) {
        if (request.has(field)) nextItem = withField(nextItem, field, request.get(field) as never);
      }
      if (nextItem !== item) queue = replaceItem(queue, nextItem);
    }
  }
  if (request.has('notify')) {
    const item = findItem(queue, itemId);
    const observers = item === null ? [] : arrayOf(item.get('observers'));
    nextBinding = withField(
      nextBinding,
      'notify_status',
      notifyValidation(request.get('notify'), effects.config, observers.includes(requestId)),
    );
  }
  queue = replaceRequest(queue, requestId, nextBinding);
  // Project only after the supplied task/branch/predecessor/observed context
  // is on the binding, so a status poll and this response agree.
  const excluded = await historyProjection(
    queue,
    effects,
    historyDefaults(historyQuery(queue, nextBinding)),
  );
  const notifyStatus = nextBinding.get('notify_status');
  if (notifyStatus !== undefined) result = withField(result, 'notify', notifyStatus);
  await effects.saveQueue(queue);
  if (result.get('action') === 'created' && !repeat && hasCycleItems(queue)) {
    const reused = await probeReusedReceipt(queue, itemId, effects);
    if (reused !== null) {
      queue = reused.queue;
      await effects.saveQueue(queue);
      result = withField(reviewStatus(queue, requestId), 'action', 'reused');
    }
  }
  result = withField(result, 'history', historyCue(excluded));
  return { queue, result };
}

async function statusOrResult(
  queue: JsonObject,
  request: JsonObject,
  effects: ReviewCapabilityEffects,
): Promise<JsonObject> {
  const requestId = stringRequired(request, 'request_id');
  let result = reviewStatus(queue, requestId);
  if (request.get('op') === 'result' && typeof result.get('receipt_id') === 'string') {
    const receiptId = result.get('receipt_id') as string;
    const data = await effects.readReceipt(receiptId);
    const indexValue = request.get('index');
    const index =
      indexValue instanceof JsonNumber && indexValue.kind === 'int' && indexValue.integer !== null
        ? Number(indexValue.integer)
        : 0;
    return reviewResultChunk(receiptId, data, index);
  }
  if (request.get('op') === 'status') {
    const binding = readRequest(queue, requestId);
    if (binding === null) throw new ValueError('unknown review request');
    const history = await historyProjection(
      queue,
      effects,
      historyDefaults(historyQuery(queue, binding)),
    );
    result = withField(result, 'history', historyCue(history));
  }
  return result;
}

async function notifyUpdate(
  queue: JsonObject,
  request: JsonObject,
  principal: string,
  effects: ReviewCapabilityEffects,
): Promise<JsonObject> {
  const requestId = stringRequired(request, 'request_id');
  const binding = readRequest(queue, requestId);
  if (binding === null || binding.get('principal') !== principal) {
    throw new ValueError('notification request owner denied');
  }
  const notify = request.get('notify');
  queue = updateNotify(
    queue,
    requestId,
    notify instanceof JsonObject ? notify : null,
    effects.config,
  );
  await effects.saveQueue(queue);
  return reviewStatus(queue, requestId);
}

async function reviewHistory(
  queue: JsonObject,
  request: JsonObject,
  effects: ReviewCapabilityEffects,
): Promise<JsonObject> {
  let query: Parameters<typeof projectHistory>[1];
  if (request.has('request_id')) {
    const binding = readRequest(queue, stringRequired(request, 'request_id'));
    if (binding === null) throw new ValueError('unknown review request');
    query = { ...historyQuery(queue, binding), ...limitAndCursor(request), git: NO_GIT };
  } else {
    const repo = stringRequired(request, 'repo');
    const target = stringRequired(request, 'target');
    query = {
      repo,
      target,
      headCommit: nullableString(request, 'head_commit'),
      headTree: nullableString(request, 'head_tree'),
      task: nullableString(request, 'task'),
      branch: nullableString(request, 'branch'),
      predecessor: nullableString(request, 'predecessor'),
      observed: objectOrNull(request.get('observed')),
      excludeItem: null,
      ...limitAndCursor(request),
      git: NO_GIT,
    };
  }
  return historyProjection(queue, effects, query);
}

function limitAndCursor(request: JsonObject): { readonly limit: number; readonly cursor: number } {
  const limitValue = request.get('limit');
  const cursorValue = request.get('cursor');
  if (
    !(limitValue instanceof JsonNumber) ||
    limitValue.kind !== 'int' ||
    limitValue.integer === null
  ) {
    throw new ValueError('history limit must be an integer from 1 to 50');
  }
  if (
    !(cursorValue instanceof JsonNumber) ||
    cursorValue.kind !== 'int' ||
    cursorValue.integer === null
  ) {
    throw new ValueError('history cursor must be a non-negative integer');
  }
  return { limit: Number(limitValue.integer), cursor: Number(cursorValue.integer) };
}

const NO_GIT: GitFn = () => {
  throw new Error('git adapter not bound');
};

type HistoryQuery = Omit<Parameters<typeof projectHistory>[1], 'git'> & {
  readonly git?: GitFn;
};

function historyDefaults(query: ReturnType<typeof historyQuery>): HistoryQuery {
  return { ...query, limit: 20, cursor: 0 };
}

async function historyProjection(
  queue: JsonObject,
  effects: ReviewCapabilityEffects,
  query: HistoryQuery,
): Promise<JsonObject> {
  try {
    const git =
      query.repo === effects.runnerRepo || effects.isConfiguredRepo(query.repo)
        ? effects.historyGit(query.repo)
        : NO_GIT;
    return await projectHistory(queue, { ...query, git });
  } catch (error) {
    const reason =
      error instanceof Error && error.message.length > 0 ? error.message : String(error);
    return degradedHistory(reason);
  }
}

function replayRequest(queue: JsonObject, requestId: string, key: string): JsonObject | null {
  const old = readRequest(queue, requestId);
  if (old === null) return null;
  if (old.get('key_digest') !== key) throw new ValueError('request id has different inputs');
  return reviewStatus(queue, requestId);
}

/** Disk bytes, not queue metadata, authorize completed-result reuse. */
async function retainedReceiptIds(
  queue: JsonObject,
  effects: ReviewCapabilityEffects,
): Promise<ReadonlySet<string>> {
  const verified = new Set<string>();
  for (const entry of arrayOf(queue.get('items'))) {
    const item = entry instanceof JsonObject ? entry : null;
    if (item === null || item.get('kind') !== 'local-review') continue;
    const receiptId = itemFields(item).receiptId;
    if (receiptId === null || verified.has(receiptId)) continue;
    try {
      const data = await effects.readReceipt(receiptId);
      const parsed = parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(data), {
        duplicates: 'error',
      });
      if (!(parsed instanceof JsonObject)) continue;
      if (!ReceiptSchema.safeParse(toPlainJson(parsed)).success) continue;
      const document = fromPlainJson(parsed) as JsonObject;
      if (document.get('identity') !== item.get('identity')) continue;
      if (!sameJson(document.get('identity_inputs'), item.get('identity_inputs'))) continue;
      if (document.get('scope_adequate') !== true) continue;
      if (document.get('outcome') !== 'clean' && document.get('outcome') !== 'findings') continue;
      verified.add(receiptId);
    } catch {
      // Missing or unreadable receipt: not reused.
    }
  }
  return verified;
}

/** The narrow reuse probe: an equivalent completed cycle with a retained receipt. */
async function probeReusedReceipt(
  queue: JsonObject,
  itemId: string,
  effects: ReviewCapabilityEffects,
): Promise<{ readonly queue: JsonObject } | null> {
  const item = findItem(queue, itemId);
  if (item === null || item.get('kind') !== 'local-review') return null;
  const wanted = objectOrNull(item.get('identity_inputs'));
  if (wanted === null) return null;
  for (const entry of arrayOf(queue.get('items'))) {
    const candidate = entry instanceof JsonObject ? entry : null;
    if (candidate === null) continue;
    if (candidate.get('kind') !== 'open' && candidate.get('kind') !== 'delta') continue;
    const cycles = arrayOf(candidate.get('cycles'));
    for (let index = cycles.length - 1; index >= 0; index -= 1) {
      const cycle = cycles[index];
      if (!(cycle instanceof JsonObject)) continue;
      const receiptId = cycle.get('receipt_id');
      if (typeof receiptId !== 'string') continue;
      const configDigest = cycle.get('config_digest');
      if (typeof configDigest !== 'string' || configDigest !== wanted.get('config_digest'))
        continue;
      const profile = cycle.get('profile');
      if (!(profile instanceof JsonObject)) continue;
      // Stored cycles retain the complete execution profile (including
      // flags); only adapter and revision are identity-bearing.
      if (!sameJson(identityProfile(profile), identityProfile(wanted.get('profile')))) continue;
      if (cycle.get('base') !== wanted.get('base_commit')) continue;
      if (cycle.get('head') !== wanted.get('head_commit')) continue;
      try {
        const data = await effects.readReceipt(receiptId);
        const parsed = parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(data), {
          duplicates: 'error',
        });
        if (!(parsed instanceof JsonObject)) continue;
        const receipt = ReceiptSchema.safeParse(toPlainJson(parsed));
        if (!receipt.success) continue;
        const document = fromPlainJson(parsed) as JsonObject;
        if (document.get('identity') !== item.get('identity')) continue;
        if (!sameJson(document.get('identity_inputs'), wanted)) continue;
        if (document.get('scope_adequate') !== true) continue;
        const outcome = document.get('outcome');
        if (outcome !== 'clean' && outcome !== 'findings') continue;
        const completed = withFields(item, [
          ['state', 'done'],
          ['outcome', outcome],
          ['scope_adequate', true],
          ['receipt_id', receiptId],
          ['completed_at', effects.nowIso()],
          ['identity', document.get('identity') ?? item.get('identity')],
        ]);
        return { queue: replaceItem(queue, completed) };
      } catch {
        continue;
      }
    }
  }
  return null;
}

function identityProfile(value: unknown): JsonObject | null {
  const profile = objectOrNull(value);
  if (profile === null) return null;
  const adapter = profile.get('adapter');
  const revision = profile.get('revision');
  if (typeof adapter !== 'string' || typeof revision !== 'string') return null;
  return new JsonObject([
    ['adapter', adapter],
    ['revision', revision],
  ]);
}

function hasCycleItems(queue: JsonObject): boolean {
  return arrayOf(queue.get('items')).some((entry) => {
    const item = entry instanceof JsonObject ? entry : null;
    if (item === null) return false;
    const kind = item.get('kind');
    return (kind === 'open' || kind === 'delta') && arrayOf(item.get('cycles')).length > 0;
  });
}

async function recordPolicyRefusal(
  request: JsonObject,
  policy: QueuePolicy,
  effects: ReviewCapabilityEffects,
): Promise<JsonObject | null> {
  const effectiveRepo = nullableString(request, 'repo') ?? effects.runnerRepo;
  const allowed = [policy.repo, ...policy.repos];
  if (allowed.some((candidate) => candidate.toLowerCase() === effectiveRepo.toLowerCase()))
    return null;
  return new JsonObject([
    ['v', JsonNumber.int(1)],
    ['op', 'record'],
    ['action', 'refused'],
    ['record_digest', null],
    ['duplicate_of', null],
    ['supersedes', request.get('supersedes') ?? null],
    ['reason', 'unsupported-repo'],
  ]);
}

async function recordImport(
  queue: JsonObject,
  request: JsonObject,
  principal: string,
  effects: ReviewCapabilityEffects,
): Promise<{ readonly queue: JsonObject; readonly result: JsonObject }> {
  const report = objectRequired(request, 'report');
  const data = stringRequired(report, 'data');
  const reportBytes = Buffer.from(data, 'utf8');
  let submitted: SubmittedRecord = {
    producer: stringRequired(request, 'producer'),
    id: stringRequired(request, 'source_id'),
    reportBytes,
    repo: nullableString(request, 'repo'),
    head: nullableString(request, 'head_commit'),
    base: nullableString(request, 'base_commit'),
    headTree: nullableString(request, 'head_tree'),
    target: nullableString(request, 'target'),
    reviewer: nullableString(request, 'reviewer'),
    authenticatedSubmitter: principal,
    verdict: nullableString(request, 'verdict'),
    claimedScope: request.get('claimed_scope') ?? null,
    independence: nullableString(request, 'independence'),
    supersedes: nullableString(request, 'supersedes'),
    forgeEvidence: nullableString(request, 'forge_evidence'),
  };
  if (submitted.reportBytes.length > MAX_REPORT_BYTES) {
    throw new ValueError('report exceeds 256 KiB import bound');
  }
  // The ledger pins the canonical repository spelling.
  if (submitted.repo !== null) {
    const allowed = [effects.runnerRepo, ...repositorySpellings(effects)];
    const canonical = allowed.find(
      (candidate) => candidate.toLowerCase() === (submitted.repo as string).toLowerCase(),
    );
    if (canonical === undefined) {
      return {
        queue,
        result: new JsonObject([
          ['v', JsonNumber.int(1)],
          ['op', 'record'],
          ['action', 'refused'],
          ['record_digest', null],
          ['duplicate_of', null],
          ['supersedes', submitted.supersedes],
          ['reason', 'unsupported-repo'],
        ]),
      };
    }
    submitted = { ...submitted, repo: canonical };
  }
  const retained = await effects.retainedRecords();
  let imported: { readonly events: readonly JsonObject[]; readonly action: string };
  try {
    imported = importRecord(submitted, effects.nowIso(), retained);
  } catch (error) {
    if (error instanceof LedgerIntegrityError || error instanceof RecordRefused) {
      throw new ValueError(error.message);
    }
    throw error;
  }
  const kind = imported.action.split(':', 1)[0] ?? '';
  const detail = imported.action.slice(kind.length + 1);
  let result = new JsonObject([
    ['v', JsonNumber.int(1)],
    ['op', 'record'],
    ['action', kind === 'record' ? 'recorded' : kind],
    ['record_digest', null],
    ['duplicate_of', null],
    ['supersedes', submitted.supersedes],
    ['publication', 'disabled'],
  ]);
  let retainedEventId: string | null = null;
  if (imported.events.length > 0) {
    const settings = await effects.rolloutSettings();
    const retainedRef = await effects.putReport(submitted.reportBytes);
    const seen = [...retained];
    for (const original of imported.events) {
      const payload = objectOrNull(original.get('payload')) ?? new JsonObject([]);
      let event = withField(
        original,
        'payload',
        withField(payload, 'artifacts', [
          new JsonObject([
            ['sha256', retainedRef.get('sha256') ?? null],
            ['location', retainedRef.get('location') ?? null],
            ['kind', 'report'],
          ]),
        ]),
      );
      event = withField(
        event,
        'id',
        ledgerDigestOf(new JsonObject(event.entries.filter(([key]) => key !== 'id'))),
      );
      ledgerValidate(event);
      if (eventExceedsPublisherBound(event)) {
        const quarantined = await oversizeQuarantine(
          submitted,
          retainedRef,
          seen,
          result,
          settings !== null,
          effects,
        );
        return { queue, result: quarantined };
      }
      if (event.get('event_type') === 'review') {
        retainedEventId = typeof event.get('id') === 'string' ? (event.get('id') as string) : null;
        seen.push(event);
      }
      await effects.spoolEvent(event);
    }
    if (settings !== null) {
      result = withField(result, 'publication', 'spooled');
      await effects.requestPublication();
    }
  }
  if (kind === 'record') result = withField(result, 'record_digest', retainedEventId ?? detail);
  else if (kind === 'duplicate') result = withField(result, 'duplicate_of', detail);
  else if (kind === 'quarantined' || kind === 'refused') {
    result = withField(result, 'reason', detail.slice(0, 500));
  }
  return { queue, result };
}

function repositorySpellings(effects: ReviewCapabilityEffects): string[] {
  const repos = effects.config.get('repos');
  if (!Array.isArray(repos)) return [];
  return repos
    .map((entry) => (entry instanceof JsonObject ? entry.get('repo') : null))
    .filter((value): value is string => typeof value === 'string');
}

async function oversizeQuarantine(
  submitted: SubmittedRecord,
  retainedRef: JsonObject,
  retained: readonly JsonObject[],
  result: JsonObject,
  configured: boolean,
  effects: ReviewCapabilityEffects,
): Promise<JsonObject> {
  const reason = 'serialized event exceeds the 1 MiB publisher bound';
  const digest = sha256Hex(submitted.reportBytes);
  const key = quarantineSourceKey(reason, digest);
  const previous = retained.find(
    (value) => value.get('event_type') === 'import-result' && value.get('source_key') === key,
  );
  let next = withFields(result, [
    ['action', 'quarantined'],
    ['reason', reason],
  ]);
  if (previous !== undefined) {
    if (configured) next = withField(next, 'publication', 'spooled');
    return next;
  }
  const quarantined = quarantineEvent(reason, digest, submitted, effects.nowIso());
  if (quarantined === null) {
    return withFields(result, [
      ['action', 'refused'],
      ['reason', reason],
    ]);
  }
  const payload = objectOrNull(quarantined.get('payload')) ?? new JsonObject([]);
  let event = withField(
    quarantined,
    'payload',
    withField(payload, 'artifacts', [
      new JsonObject([
        ['sha256', retainedRef.get('sha256') ?? null],
        ['location', retainedRef.get('location') ?? null],
        ['kind', 'report'],
      ]),
    ]),
  );
  event = withField(
    event,
    'id',
    ledgerDigestOf(new JsonObject(event.entries.filter(([key]) => key !== 'id'))),
  );
  ledgerValidate(event);
  await effects.spoolEvent(event);
  next = withField(
    next,
    'publication',
    configured ? 'spooled' : (next.get('publication') ?? 'disabled'),
  );
  return next;
}

function validateResult(kind: 'response' | 'history', result: JsonObject): JsonObject {
  return kind === 'history' ? ResultValidator.history(result) : ResultValidator.response(result);
}

const ResultValidator = {
  response(result: JsonObject): JsonObject {
    const parsed = ResponseSchema.safeParse(toPlainJson(result));
    if (!parsed.success) throw new ValueError('review response shape invalid');
    return result;
  },
  history(result: JsonObject): JsonObject {
    const parsed = HistorySchema.safeParse(toPlainJson(result));
    if (!parsed.success) throw new ValueError('review history shape invalid');
    return result;
  },
  record(result: JsonObject): JsonObject {
    const parsed = RecordResponseSchema.safeParse(toPlainJson(result));
    if (!parsed.success) throw new ValueError('review record shape invalid');
    return result;
  },
};

/** `review_transport.error`: one typed wire refusal. */
export function errorDocument(code: string, message: string, retryable: boolean): JsonObject {
  return new JsonObject([
    ['v', JsonNumber.int(1)],
    [
      'error',
      new JsonObject([
        ['code', code],
        ['message', message],
        ['retryable', retryable],
      ]),
    ],
  ]);
}

/** `review_transport.safe_handle`: map typed failures to the wire vocabulary. */
export function safeHandle(error: unknown): Uint8Array {
  if (error instanceof AuthorRefused) {
    return encode(
      errorDocument(
        'snapshot-refused',
        `${error.message}; check required objects and snapshot limits`,
        false,
      ),
    );
  }
  if (error instanceof ValueError)
    return encode(errorDocument('invalid-input', error.message, false));
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    return encode(
      errorDocument(
        'result-unavailable',
        'retained result unavailable; submit an explicit repeat',
        false,
      ),
    );
  }
  throw error;
}

function isTypedWriteError(error: unknown): boolean {
  return (
    error instanceof ValueError ||
    error instanceof AuthorRefused ||
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function errorResponse(error: unknown): Uint8Array {
  if (error instanceof ValueError)
    return encode(errorDocument('invalid-input', error.message, false));
  if (error instanceof AuthorRefused) {
    return encode(
      errorDocument(
        'snapshot-refused',
        `${error.message}; check required objects and snapshot limits`,
        false,
      ),
    );
  }
  throw error;
}

/** Canonical response bytes (`review_receipt.canonical`). */
export function encode(value: JsonObject): Uint8Array {
  return Buffer.from(receiptJsonText(value), 'utf8');
}

function reviewProfile(config: JsonObject, base: string): JsonObject {
  const section = objectOrNull(config.get('local_review_profile')) ?? new JsonObject([]);
  const revision = section.get('revision');
  const flags = section.get('flags');
  return new JsonObject([
    ['adapter', 'coderabbit-cli'],
    ['revision', typeof revision === 'string' ? revision : 'committed-full-diff-v1'],
    [
      'flags',
      [
        ...(Array.isArray(flags) ? flags : ['--agent', '--deep', '--committed']),
        '--base-commit',
        base,
      ],
    ],
  ]);
}

function findItem(queue: JsonObject, itemId: string): JsonObject | null {
  for (const entry of arrayOf(queue.get('items'))) {
    const item = entry instanceof JsonObject ? entry : null;
    if (item !== null && item.get('id') === itemId) return item;
  }
  return null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectOrNull(value: unknown): JsonObject | null {
  return value instanceof JsonObject ? value : null;
}

function objectRequired(object: JsonObject, key: string): JsonObject {
  const value = object.get(key);
  if (!(value instanceof JsonObject)) throw new ValueError(`invalid ${key}`);
  return value;
}

function stringRequired(object: JsonObject, key: string): string {
  const value = object.get(key);
  if (typeof value !== 'string' || value.length === 0) throw new ValueError(`invalid ${key}`);
  if (key === 'request_id' && !REQUEST_ID.test(value)) throw new ValueError('invalid request id');
  return value;
}

function nullableString(object: JsonObject, key: string): string | null {
  const value = object.get(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function withField(object: JsonObject, key: string, value: never | unknown): JsonObject {
  return new JsonObject(
    object.has(key)
      ? object.entries.map(
          ([name, entry]) => [name, name === key ? (value as never) : entry] as const,
        )
      : [...object.entries, [key, value as never] as const],
  );
}

function withFields(
  object: JsonObject,
  updates: ReadonlyArray<readonly [string, unknown]>,
): JsonObject {
  const map = new Map(updates);
  const entries = object.entries.map(
    ([key, value]) => [key, map.has(key) ? (map.get(key) as never) : value] as const,
  );
  for (const [key, value] of updates) {
    if (!object.has(key)) entries.push([key, value as never] as const);
  }
  return new JsonObject(entries);
}

function sameJson(left: unknown, right: unknown): boolean {
  return pythonValueEqual(left, right);
}
