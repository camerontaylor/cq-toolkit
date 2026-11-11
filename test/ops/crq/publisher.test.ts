import { describe, expect, test } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerEvent,
} from '../../../src/policy/crq/ledger.js';
import {
  Outbox,
  type ArtifactVerifier,
  type OutboxFiles,
} from '../../../src/ops/review/internal/crq/outbox.js';
import {
  PublicationPushError,
  publish,
  type PublicationEffects,
  type PublicationRemote,
  type PublicationSnapshot,
} from '../../../src/ops/review/internal/crq/publisher.js';
import { PublicationPlanError } from '../../../src/policy/crq/publication.js';
import {
  arrayAt,
  artifactSha,
  at,
  batchEvidence,
  expectedBatchEvidence,
  idsAt,
  loadPublisherVectors,
  numberAt,
  recordEventType,
  recordId,
  requireObject,
  stringAt,
  type PublisherVectorCase,
  type RecordEvidence,
} from '../../policy/crq/publisherVectors.js';

interface PublishInput {
  readonly ledger: JsonValue[];
  readonly pending: JsonValue[];
  readonly direct: JsonValue[];
  readonly acked: string[];
  readonly failures: number;
  readonly acceptThenFail: boolean;
  readonly concurrent: JsonValue[];
  readonly dropOnFetch: string[];
  readonly refusedArtifacts: string[];
}

interface Actual {
  readonly fetchCalls: number;
  readonly pushCalls: number;
  readonly batches: RecordEvidence[][];
  readonly acks: string[];
  readonly pending: string[];
}

class MemoryFiles implements OutboxFiles {
  readonly pending = new Map<string, Uint8Array>();
  readonly ack = new Map<string, Uint8Array>();
  readonly ackOrder: string[] = [];
  lockCalls = 0;

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.lockCalls++;
    return fn();
  }

  async listPending(): Promise<readonly string[]> {
    return [...this.pending.keys()].sort();
  }

  async readPending(id: string): Promise<Uint8Array | null> {
    return this.pending.get(id) ?? null;
  }

  async writePending(id: string, bytes: Uint8Array): Promise<void> {
    this.pending.set(id, bytes);
  }

  async hasAck(id: string): Promise<boolean> {
    return this.ack.has(id);
  }

  async writeAck(id: string, bytes: Uint8Array): Promise<void> {
    this.ack.set(id, bytes);
    this.ackOrder.push(id);
  }
}

class MemoryArtifacts implements ArtifactVerifier {
  readonly refused = new Set<string>();
  readonly calls: string[] = [];

  async verify(reference: JsonValue): Promise<void> {
    const sha = artifactSha(reference);
    this.calls.push(sha);
    if (this.refused.has(sha)) {
      throw new LedgerIntegrityError('missing or corrupt retained artifact');
    }
  }
}

function readOrder(left: JsonValue, right: JsonValue): number {
  const leftReview = recordEventType(left) === 'review' ? 0 : 1;
  const rightReview = recordEventType(right) === 'review' ? 0 : 1;
  if (leftReview !== rightReview) return leftReview - rightReview;
  const leftId = recordId(left);
  const rightId = recordId(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

class MemoryRemote implements PublicationRemote {
  readonly values: JsonValue[];
  head: string;
  fetchCalls = 0;
  pushCalls = 0;
  readonly batches: JsonValue[][] = [];
  private dropNext = new Set<string>();
  private headCounter = 1;
  private readonly options: {
    failures: number;
    acceptThenFail: boolean;
    concurrent: JsonValue[];
    dropOnFetch: string[];
  };

  constructor(values: readonly JsonValue[], options: PublishInput) {
    this.values = [...values];
    this.head = values.length === 0 ? '0'.repeat(40) : '1'.repeat(40);
    this.options = {
      failures: options.failures,
      acceptThenFail: options.acceptThenFail,
      concurrent: [...options.concurrent],
      dropOnFetch: [...options.dropOnFetch],
    };
  }

  async fetch(): Promise<PublicationSnapshot> {
    this.fetchCalls++;
    let values = [...this.values];
    if (this.dropNext.size > 0) {
      values = values.filter((value) => !this.dropNext.has(recordId(value)));
      this.dropNext = new Set();
    }
    return { head: this.head, values };
  }

  async publish(batch: readonly JsonValue[], baseHead: string): Promise<{ commit: string }> {
    this.pushCalls++;
    if (baseHead !== this.head) throw new PublicationPushError('non-fast-forward');
    if (this.options.concurrent.length > 0) {
      this.values.push(...this.options.concurrent);
      this.options.concurrent = [];
      this.head = this.nextHead();
      throw new PublicationPushError('concurrent remote append');
    }
    if (this.options.acceptThenFail) {
      this.options.acceptThenFail = false;
      this.apply(batch);
      throw new PublicationPushError('push timed out after the remote accepted it');
    }
    if (this.options.failures > 0) {
      this.options.failures--;
      throw new PublicationPushError('push refused');
    }
    this.apply(batch);
    return { commit: this.head };
  }

  private apply(batch: readonly JsonValue[]): void {
    const sorted = [...batch].sort(readOrder);
    this.values.push(...sorted);
    this.batches.push(sorted);
    this.head = this.nextHead();
    if (this.options.dropOnFetch.length > 0) {
      this.dropNext = new Set(this.options.dropOnFetch);
    }
  }

  private nextHead(): string {
    this.headCounter++;
    return String(this.headCounter).padStart(40, '0');
  }
}

class Effects implements PublicationEffects {
  lockCalls = 0;
  creditableCalls = 0;
  active = false;

  constructor(
    private readonly artifacts: MemoryArtifacts,
    private readonly creditableFailure?: string,
  ) {}

  async verifyArtifact(reference: JsonValue): Promise<void> {
    await this.artifacts.verify(reference);
  }

  async verifyCreditableReview(_value: JsonValue): Promise<void> {
    this.creditableCalls++;
    if (this.creditableFailure !== undefined) {
      throw new LedgerIntegrityError(this.creditableFailure);
    }
  }

  async withPublisherLock<T>(fn: () => Promise<T>): Promise<T> {
    this.lockCalls++;
    this.active = true;
    try {
      return await fn();
    } finally {
      this.active = false;
    }
  }
}

function inputOf(caseEntry: PublisherVectorCase): PublishInput {
  return {
    ledger: arrayAt(caseEntry.input, 'ledger'),
    pending: arrayAt(caseEntry.input, 'pending'),
    direct: arrayAt(caseEntry.input, 'direct'),
    acked: idsAt(caseEntry.input, 'acked'),
    failures: numberAt(caseEntry.input, 'failures'),
    acceptThenFail: caseEntry.input.get('accept_then_fail') === true,
    concurrent: arrayAt(caseEntry.input, 'concurrent'),
    dropOnFetch: idsAt(caseEntry.input, 'drop_on_fetch'),
    refusedArtifacts: idsAt(caseEntry.input, 'refused_artifacts'),
  };
}

function expectedValue(caseEntry: PublisherVectorCase): JsonObject {
  return requireObject(caseEntry.expect.get('value'), 'expected value');
}

function seedAck(files: MemoryFiles, id: string): void {
  files.ack.set(id, ledgerCanonicalBytes(parseJsonValue(JSON.stringify({ id }))));
}

function observables(remote: MemoryRemote, files: MemoryFiles, pending: string[]): Actual {
  return {
    fetchCalls: remote.fetchCalls,
    pushCalls: remote.pushCalls,
    batches: batchEvidence(remote.batches),
    acks: [...files.ackOrder],
    pending: [...pending].sort(),
  };
}

function expectMatchesOracle(actual: Actual, caseEntry: PublisherVectorCase): void {
  const expected = expectedValue(caseEntry);
  expect(actual.fetchCalls).toBe(numberAt(expected, 'fetch_calls'));
  expect(actual.pushCalls).toBe(numberAt(expected, 'push_calls'));
  expect(actual.batches).toEqual(expectedBatchEvidence(expected));
  expect(actual.acks).toEqual(idsAt(expected, 'acks'));
  expect(actual.pending).toEqual(idsAt(expected, 'pending'));
}

function creditableReview(vector: PublisherVectorCase): JsonValue {
  const review = arrayAt(vector.input, 'pending').find(
    (value) => recordEventType(value) === 'review',
  );
  if (review === undefined) throw new Error('missing review record');
  const payload = requireObject(review, 'review').get('payload');
  const plain = toPlainJson(requireObject(payload, 'review payload')) as Record<string, unknown>;
  plain.outcome = 'completed';
  return ledgerEvent(
    'review',
    stringAt(requireObject(review, 'review'), 'source_key'),
    stringAt(requireObject(review, 'review'), 'occurred_at'),
    parseJsonValue(JSON.stringify(plain)),
  );
}

const vectors = loadPublisherVectors();
const publishCases = vectors.filter((entry) => entry.family === 'publish');

describe('publisher replay against the Python oracle', () => {
  for (const caseEntry of publishCases) {
    test(`${caseEntry.name}: effects match the oracle`, async () => {
      const input = inputOf(caseEntry);
      const files = new MemoryFiles();
      const artifacts = new MemoryArtifacts();
      const outbox = new Outbox(files, artifacts);
      for (const value of input.pending) await outbox.spool(value);
      for (const value of input.direct) {
        files.pending.set(recordId(value), ledgerCanonicalBytes(value));
      }
      for (const id of input.acked) seedAck(files, id);
      // The oracle spools before it swaps in the refusing artifact store, so
      // the refusal is a publication effect, never a setup failure.
      artifacts.refused.clear();
      for (const id of input.refusedArtifacts) artifacts.refused.add(id);
      const remote = new MemoryRemote(input.ledger, input);
      const effects = new Effects(artifacts);

      let error: unknown;
      try {
        await publish(remote, outbox, effects);
      } catch (caught) {
        error = caught;
      }
      const pending = (await outbox.pending()).map(recordId);
      expectMatchesOracle(observables(remote, files, pending), caseEntry);
      expect(effects.lockCalls).toBe(1);
      expect(files.lockCalls).toBe(expectedLockCount(caseEntry));
      if (caseEntry.expect.get('ok') === true) {
        expect(error).toBeUndefined();
      } else {
        expect(error).toBeInstanceOf(LedgerIntegrityError);
        const ledgerError = error as LedgerIntegrityError;
        expect(ledgerError.pythonError).toBe(stringAt(caseEntry.expect, 'error'));
        expect(ledgerError.message).toBe(stringAt(caseEntry.expect, 'message'));
      }
    });
  }
});

test('a malformed retained job writes only the acknowledgements before it', async () => {
  const caseEntry = publishCases.find((entry) => entry.name === 'malformed-middle-retained-job');
  if (caseEntry === undefined) throw new Error('missing malformed retained-job vector');
  const input = inputOf(caseEntry);
  const files = new MemoryFiles();
  const artifacts = new MemoryArtifacts();
  const outbox = new Outbox(files, artifacts);
  for (const value of input.direct) {
    files.pending.set(recordId(value), ledgerCanonicalBytes(value));
  }
  const remote = new MemoryRemote(input.ledger, input);
  const effects = new Effects(artifacts);

  let error: unknown;
  try {
    await publish(remote, outbox, effects);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PublicationPlanError);
  if (!(error instanceof PublicationPlanError)) throw new Error('expected a plan refusal');
  expect(error.pythonError).toBe('KeyError');
  expect(error.message).toBe("'reason'");
  const expected = expectedValue(caseEntry);
  expect(error.acks.map(recordId)).toEqual(idsAt(expected, 'acks'));
  expect(files.ackOrder).toEqual(idsAt(expected, 'acks'));
  expect(files.ack.size).toBe(idsAt(expected, 'acks').length);
  expect((await outbox.pending()).map(recordId)).toEqual(idsAt(expected, 'pending'));
  expect(remote.pushCalls).toBe(0);
  expect(remote.batches).toEqual([]);
});

test('a list-valued import result is classified before batch validation refuses', async () => {
  const caseEntry = publishCases.find(
    (entry) => entry.name === 'malformed-import-result-list-middle',
  );
  if (caseEntry === undefined) throw new Error('missing malformed import-result vector');
  const input = inputOf(caseEntry);
  const files = new MemoryFiles();
  const artifacts = new MemoryArtifacts();
  const outbox = new Outbox(files, artifacts);
  for (const value of input.direct) {
    files.pending.set(recordId(value), ledgerCanonicalBytes(value));
  }
  const remote = new MemoryRemote(input.ledger, input);
  const effects = new Effects(artifacts);

  let error: unknown;
  try {
    await publish(remote, outbox, effects);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(LedgerIntegrityError);
  const ledgerError = error as LedgerIntegrityError;
  expect(ledgerError.pythonError).toBe('IntegrityError');
  expect(ledgerError.message).toBe('event does not match one schema variant');
  const expected = expectedValue(caseEntry);
  expect(files.ackOrder).toEqual(idsAt(expected, 'acks'));
  expect(files.ack.size).toBe(idsAt(expected, 'acks').length);
  expect((await outbox.pending()).map(recordId)).toEqual(idsAt(expected, 'pending'));
  expect(remote.pushCalls).toBe(0);
  expect(remote.batches).toEqual([]);
});

function expectedLockCount(caseEntry: PublisherVectorCase): number {
  // One lock per successful spool; direct seeds and acks take no outbox lock.
  return arrayAt(caseEntry.input, 'pending').length;
}

describe('publication driver seams', () => {
  test('the publisher lock wraps the whole attempt loop', async () => {
    const calls: string[] = [];
    const effects: PublicationEffects = {
      verifyArtifact: async () => {},
      verifyCreditableReview: async () => {},
      withPublisherLock: async (fn) => {
        calls.push('enter');
        const result = await fn();
        calls.push('exit');
        return result;
      },
    };
    const remote: PublicationRemote = {
      fetch: async () => {
        calls.push('fetch');
        return { head: '0'.repeat(40), values: [] };
      },
      publish: async () => ({ commit: 'unused' }),
    };
    const files = new MemoryFiles();
    await publish(remote, new Outbox(files, new MemoryArtifacts()), effects);
    expect(calls).toEqual(['enter', 'fetch', 'exit']);
  });

  test('a required creditable verification refusal stops before any push', async () => {
    const caseEntry = publishCases.find((entry) => entry.name === 'finding-event-causal-order');
    if (caseEntry === undefined) throw new Error('missing causal-order vector');
    const review = creditableReview(caseEntry);
    const files = new MemoryFiles();
    const artifacts = new MemoryArtifacts();
    const outbox = new Outbox(files, artifacts);
    await outbox.spool(review);
    const remote = new MemoryRemote([], {
      ledger: [],
      pending: [],
      direct: [],
      acked: [],
      failures: 0,
      acceptThenFail: false,
      concurrent: [],
      dropOnFetch: [],
      refusedArtifacts: [],
    });
    const effects = new Effects(artifacts, 'creditable verification failed');
    await expect(publish(remote, outbox, effects)).rejects.toThrow(
      'creditable verification failed',
    );
    expect(remote.pushCalls).toBe(0);
    expect(await outbox.pending()).toHaveLength(1);
    expect(effects.creditableCalls).toBe(1);
  });

  test('a required creditable verification success publishes the review', async () => {
    const caseEntry = publishCases.find((entry) => entry.name === 'finding-event-causal-order');
    if (caseEntry === undefined) throw new Error('missing causal-order vector');
    const review = creditableReview(caseEntry);
    const files = new MemoryFiles();
    const artifacts = new MemoryArtifacts();
    const outbox = new Outbox(files, artifacts);
    await outbox.spool(review);
    const remote = new MemoryRemote([], {
      ledger: [],
      pending: [],
      direct: [],
      acked: [],
      failures: 0,
      acceptThenFail: false,
      concurrent: [],
      dropOnFetch: [],
      refusedArtifacts: [],
    });
    const effects = new Effects(artifacts);
    await publish(remote, outbox, effects);
    expect(remote.pushCalls).toBe(1);
    expect(await outbox.pending()).toHaveLength(0);
    expect(effects.creditableCalls).toBe(1);
  });

  test('a non-push publish error is not retried', async () => {
    const files = new MemoryFiles();
    const caseEntry = publishCases.find((entry) => entry.name === 'single-enrollment');
    if (caseEntry === undefined) throw new Error('missing single-enrollment vector');
    const record = at(arrayAt(caseEntry.input, 'pending'), 0);
    const outbox = new Outbox(files, new MemoryArtifacts());
    await outbox.spool(record);
    let calls = 0;
    const remote: PublicationRemote = {
      fetch: async () => ({ head: '0'.repeat(40), values: [] }),
      publish: async () => {
        calls++;
        throw new Error('local defect');
      },
    };
    await expect(publish(remote, outbox, new Effects(new MemoryArtifacts()))).rejects.toThrow(
      'local defect',
    );
    expect(calls).toBe(1);
    expect(await outbox.pending()).toHaveLength(1);
  });
});
