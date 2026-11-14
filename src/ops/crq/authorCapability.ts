/**
 * author-v1 forced-command state machine (`author_transport`).
 *
 * The operator supplies the review policy path, the fallback reviewer and the
 * one approved target through the environment. The frame only names an
 * immutable binding and an operation; this module never starts a reviewer,
 * never touches the publication spool, and persists a fallback decision before
 * answering it. A version-2 frame installs and pins its snapshot before the
 * enrollment becomes durable, inside the same `tick.lock` hold.
 */
import { JsonNumber, JsonObject } from '../../policy/crq/jsonValue.js';
import { parseJsonValue } from '../../policy/crq/jsonValue.js';
import { receiptJsonText } from '../../policy/crq/pythonJson.js';
import {
  AuthorRefused,
  bindingOf,
  bindingsEqual,
  decodeAuthorRequest,
  type AuthorBinding,
} from '../../policy/crq/authorWire.js';
import {
  assertLeaseReplacement,
  enrollAuthor,
  fallbackDecision,
  findAuthorRequest,
  leaseDecision,
  newLease,
  readLease,
} from '../../policy/crq/authorAdmission.js';
import { ValueError } from '../../policy/crq/reviewAdmission.js';

/** Serve one author-v1 frame and return the canonical response bytes. */
export interface AuthorCapabilityEffects {
  /** `crq.iso()` for the lease and decision timestamps. */
  readonly nowIso: () => string;
  readonly loadQueue: () => Promise<JsonObject>;
  readonly saveQueue: (queue: JsonObject) => Promise<void>;
  /** Hold `tick.lock` without waiting; `null` means busy. */
  readonly withQueueLock: <T>(work: () => Promise<T>) => Promise<T | null>;
  readonly readPolicy: (path: string) => Promise<JsonObject>;
  readonly installSnapshot: (binding: AuthorBinding, snapshot: JsonObject) => Promise<void>;
  readonly audit: (kind: string, data: JsonObject) => Promise<void>;
  /** `crq.write_status` after a durable enrollment. */
  readonly writeStatus: () => Promise<void>;
}

export interface AuthorCapabilityInput {
  readonly raw: Uint8Array;
  readonly policyPath: string;
  readonly reviewer: string;
  readonly approvedTarget: string;
}

export async function runAuthorCapability(
  input: AuthorCapabilityInput,
  effects: AuthorCapabilityEffects,
): Promise<Uint8Array> {
  const request = decodeAuthorRequest(input.raw);
  if (input.policyPath.length === 0 || input.reviewer.length === 0) {
    throw new AuthorRefused('operator review policy and fallback reviewer required');
  }
  if (input.approvedTarget.length === 0 || request.binding.target !== input.approvedTarget) {
    throw new AuthorRefused('operator-approved author target required');
  }
  const policy = await effects.readPolicy(input.policyPath);
  const at = effects.nowIso();
  const result = await effects.withQueueLock(async () => {
    let queue = await effects.loadQueue();
    if (request.v === 2) {
      const entry = requestEntry(queue, request.binding.requestId);
      if (entry !== null && !sameBinding(entry, request.binding)) {
        throw new AuthorRefused('conflicting snapshot request binding');
      }
      const lease = newLease(policy, input.reviewer, at);
      const preview = enrollAuthor(queue, {
        binding: request.binding,
        at,
        lease: null,
      });
      if (!preview.created) {
        if (readLease(preview.item) === null) {
          throw new AuthorRefused("cannot replace an existing request's lease policy");
        }
        assertLeaseReplacement(preview.item, lease);
      }
      if (request.snapshot === null) throw new AuthorRefused('invalid snapshot frame');
      await effects.installSnapshot(request.binding, request.snapshot);
    }
    if (request.op === 'enroll') {
      const lease = newLease(policy, input.reviewer, at);
      const enrolled = enrollAuthor(queue, {
        binding: request.binding,
        at,
        lease,
      });
      if (!enrolled.created) assertLeaseReplacement(enrolled.item, lease);
      queue = enrolled.queue;
      if (enrolled.created) {
        const binding = new JsonObject([
          ['base', request.binding.base],
          ['head', request.binding.head],
          ['target', request.binding.target],
          ['cycle', JsonNumber.int(request.binding.cycle)],
        ]);
        await effects.audit(
          'author_enrolled',
          new JsonObject([
            ['item', enrolled.item.get('id') ?? null],
            ['request', request.binding.requestId],
            ['base', binding.get('base') ?? null],
            ['head', binding.get('head') ?? null],
            ['target', binding.get('target') ?? null],
            ['cycle', binding.get('cycle') ?? null],
          ]),
        );
      }
      await effects.saveQueue(queue);
      await effects.writeStatus();
    }
    queue = await effects.loadQueue();
    const entry = requestEntry(queue, request.binding.requestId);
    if (entry === null || !sameBinding(entry, request.binding)) {
      throw new AuthorRefused('unknown or mismatched request binding');
    }
    if (request.op === 'fallback') {
      const decided = fallbackDecision(queue, request.binding.requestId, effects.nowIso());
      await effects.saveQueue(decided.queue);
      return decided.result;
    }
    return leaseDecision(findAuthorRequest(queue, request.binding.requestId));
  });
  if (result === null) throw new AuthorRefused('queue lock busy; no permission');
  return Buffer.from(`${receiptJsonText(result)}\n`, 'utf8');
}

function requestEntry(queue: JsonObject, requestId: string): JsonObject | null {
  const requests = queue.get('author_requests');
  if (!(requests instanceof JsonObject)) return null;
  const entry = requests.get(requestId);
  return entry instanceof JsonObject ? entry : null;
}

function sameBinding(entry: JsonObject, binding: AuthorBinding): boolean {
  return bindingsEqual(
    bindingOf(entry),
    bindingOf(
      new JsonObject([
        ['base', binding.base],
        ['head', binding.head],
        ['target', binding.target],
        ['cycle', JsonNumber.int(binding.cycle)],
      ]),
    ),
  );
}

/** Read and parse the operator's review policy, refusing a non-object. */
export async function parseAuthorPolicy(path: string): Promise<JsonObject> {
  const { readFile } = await import('node:fs/promises');
  const parsed = parseJsonValue(await readFile(path, 'utf8'), { duplicates: 'error' });
  if (!(parsed instanceof JsonObject)) throw new ValueError('review policy must be an object');
  return parsed;
}
