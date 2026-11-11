import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerCanonicalText,
  ledgerEvent,
} from '../../../src/policy/crq/ledger.js';
import {
  PUBLICATION_BATCH_BYTES,
  PUBLICATION_BATCH_RECORDS,
  PUBLICATION_RECORD_BYTES,
  PublicationPlanError,
  planPublication,
} from '../../../src/policy/crq/publication.js';
import {
  arrayAt,
  at,
  batchEvidence,
  expectedBatchEvidence,
  idsAt,
  loadPublisherVectors,
  recordEventType,
  recordId,
  requireObject,
  stringAt,
  type PublisherVectorCase,
} from './publisherVectors.js';

const AT = '2026-10-30T00:00:00Z';
const ARTIFACT = {
  sha256: 'c'.repeat(64),
  location: '/fixtures/artifacts/' + 'c'.repeat(64),
};

const SINGLE_ATTEMPT_SUCCESS = new Set([
  'idle-outbox',
  'initial-remote-acks',
  'single-enrollment',
  'enrollment-batch-merge',
  'import-batch-merge',
  'import-batch-limit',
  'kind-boundary-separates-batches',
  'finding-event-causal-order',
]);

const PLANNING_REFUSAL = new Set([
  'finding-event-missing-review',
  'record-over-limit-utf8',
  'invalid-fetch',
]);

const MALFORMED_RETAINED = new Set([
  'malformed-first-retained-job',
  'malformed-middle-retained-job',
  'malformed-last-retained-job',
]);

const vectors = loadPublisherVectors();
const publishCases = vectors.filter((entry) => entry.family === 'publish');

function plan(caseEntry: PublisherVectorCase) {
  // `Outbox.pending()` lists retained ids in lexicographic filename order; the
  // vector input records the spool order, which is not the planning order.
  const pending = [...arrayAt(caseEntry.input, 'pending')].sort((left, right) => {
    const leftId = recordId(left);
    const rightId = recordId(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  return planPublication({
    ledgerValues: arrayAt(caseEntry.input, 'ledger'),
    pending,
  });
}

function expectedValue(caseEntry: PublisherVectorCase): JsonObject {
  return requireObject(caseEntry.expect.get('value'), 'expected value');
}

function importRecord(index: number, reason = 'bulk'): JsonObject {
  const payload = parseJsonValue(
    JSON.stringify({
      source: {
        repo: 'camerontaylor/cq-toolkit',
        producer: 'fixture',
        type: 'author-cli',
        id: `bulk-${String(index)}`,
        authenticated: false,
      },
      source_digest: ARTIFACT.sha256,
      result: 'unverified',
      reason,
      review_id: null,
      duplicate_id: null,
      artifacts: [ARTIFACT],
    }),
  );
  return ledgerEvent('import-result', `import:bulk-${String(index)}`, AT, payload);
}

describe('publication plan against the Python oracle', () => {
  for (const caseEntry of publishCases) {
    if (!SINGLE_ATTEMPT_SUCCESS.has(caseEntry.name)) continue;
    test(`${caseEntry.name}: acks and batches match the oracle`, () => {
      const planned = plan(caseEntry);
      const ledgerIds = new Set(arrayAt(caseEntry.input, 'ledger').map(recordId));
      const expectedInitialAcks = idsAt(expectedValue(caseEntry), 'acks').filter((id) =>
        ledgerIds.has(id),
      );
      expect(planned.acks.map((value) => requireObject(value, 'ack').get('id'))).toEqual(
        expectedInitialAcks,
      );
      expect(batchEvidence(planned.batches.map((batch) => batch.values))).toEqual(
        expectedBatchEvidence(expectedValue(caseEntry)),
      );
      for (const batch of planned.batches) {
        const bytes = batch.values.reduce(
          (total, value) => total + ledgerCanonicalBytes(value).byteLength,
          0,
        );
        expect(batch.bytes).toBe(bytes);
      }
    });
  }

  for (const caseEntry of publishCases) {
    if (!PLANNING_REFUSAL.has(caseEntry.name)) continue;
    test(`${caseEntry.name}: planning refuses with the oracle message`, () => {
      const message = stringAt(caseEntry.expect, 'message');
      expect(() => plan(caseEntry)).toThrow(LedgerIntegrityError);
      expect(() => plan(caseEntry)).toThrow(message);
    });
  }

  test('causal order overrides the pending id order', () => {
    const caseEntry = publishCases.find((entry) => entry.name === 'finding-event-causal-order');
    if (caseEntry === undefined) throw new Error('missing causal-order vector');
    const pending = arrayAt(caseEntry.input, 'pending');
    expect(recordEventType(at(pending, 0))).toBe('finding-event');
    expect(recordEventType(at(pending, 1))).toBe('review');
    const planned = plan(caseEntry);
    expect(recordEventType(at(at(planned.batches, 0).values, 0))).toBe('review');
    expect(recordEventType(at(at(planned.batches, 1).values, 0))).toBe('finding-event');
  });

  test('a refused plan carries the acknowledgements Python already wrote', () => {
    const ackCase = publishCases.find((entry) => entry.name === 'initial-remote-acks');
    const oversizeCase = publishCases.find((entry) => entry.name === 'record-over-limit-utf8');
    if (ackCase === undefined || oversizeCase === undefined) {
      throw new Error('missing partial-ack vectors');
    }
    const ack = at(arrayAt(ackCase.input, 'ledger'), 0);
    const oversize = at(arrayAt(oversizeCase.input, 'pending'), 0);
    let caught: unknown;
    try {
      planPublication({ ledgerValues: [ack], pending: [ack, oversize] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PublicationPlanError);
    if (!(caught instanceof PublicationPlanError)) throw new Error('expected a plan refusal');
    expect(caught.acks.map(recordId)).toEqual([recordId(ack)]);
    expect(caught.message).toBe('ledger record exceeds validation bound');
  });

  for (const caseEntry of publishCases) {
    if (!MALFORMED_RETAINED.has(caseEntry.name)) continue;
    test(`${caseEntry.name}: refuses at the malformed record after only its prefix`, () => {
      const pending = [...arrayAt(caseEntry.input, 'direct')].sort((left, right) => {
        const leftId = recordId(left);
        const rightId = recordId(right);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
      let caught: unknown;
      try {
        planPublication({
          ledgerValues: arrayAt(caseEntry.input, 'ledger'),
          pending,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PublicationPlanError);
      if (!(caught instanceof PublicationPlanError)) {
        throw new Error('expected a malformed-retained refusal');
      }
      expect(caught.pythonError).toBe('KeyError');
      expect(caught.message).toBe("'reason'");
      expect(caught.acks.map(recordId)).toEqual(idsAt(expectedValue(caseEntry), 'acks'));
      const malformed = pending.find(
        (value) =>
          requireObject(value, 'job').get('payload') instanceof JsonObject &&
          !requireObject(requireObject(value, 'job').get('payload'), 'payload').has('reason'),
      );
      if (malformed === undefined) throw new Error('missing malformed retained record');
      expect(caught.acks.map(recordId)).not.toContain(recordId(malformed));
    });
  }

  test('the 1 MiB bound counts canonical UTF-8 bytes, not UTF-16 units', () => {
    const caseEntry = publishCases.find((entry) => entry.name === 'record-over-limit-utf8');
    if (caseEntry === undefined) throw new Error('missing oversized vector');
    const record = at(arrayAt(caseEntry.input, 'pending'), 0);
    expect(ledgerCanonicalBytes(record).byteLength).toBeGreaterThan(PUBLICATION_RECORD_BYTES);
    // The same record is below the bound in JavaScript's UTF-16 units, so a
    // string-length port would wrongly accept it.
    expect(ledgerCanonicalText(record).length).toBeLessThan(PUBLICATION_RECORD_BYTES);
    expect(() => planPublication({ ledgerValues: [], pending: [record] })).toThrow(
      'ledger record exceeds validation bound',
    );
  });

  test('the 4 MiB batch bound splits on canonical byte length', () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      importRecord(index, 'a'.repeat(900_000)),
    );
    const planned = planPublication({ ledgerValues: [], pending: records });
    expect(planned.batches.map((batch) => batch.values.length)).toEqual([4, 1]);
    expect(at(planned.batches, 0).bytes).toBeLessThanOrEqual(PUBLICATION_BATCH_BYTES);
    expect(
      at(planned.batches, 0).bytes + ledgerCanonicalBytes(at(records, 4)).byteLength,
    ).toBeGreaterThan(PUBLICATION_BATCH_BYTES);
  });

  test('the 64-record batch bound starts a second batch', () => {
    const records = Array.from({ length: PUBLICATION_BATCH_RECORDS + 1 }, (_, index) =>
      importRecord(index),
    );
    const planned = planPublication({ ledgerValues: [], pending: records });
    expect(planned.batches.map((batch) => batch.values.length)).toEqual([
      PUBLICATION_BATCH_RECORDS,
      1,
    ]);
  });

  test('a record exactly at the 1 MiB bound is accepted', () => {
    // Build a record whose canonical bytes are exactly 1 MiB by growing an
    // otherwise independent import until its canonical length matches.
    let record = importRecord(0, 'a'.repeat(1000));
    let bytes = ledgerCanonicalBytes(record).byteLength;
    while (bytes < PUBLICATION_RECORD_BYTES) {
      record = importRecord(0, 'a'.repeat(1000 + (PUBLICATION_RECORD_BYTES - bytes)));
      const next = ledgerCanonicalBytes(record).byteLength;
      if (next === bytes) throw new Error('canonical length did not grow');
      bytes = next;
    }
    if (bytes !== PUBLICATION_RECORD_BYTES) {
      // The canonical length moves in steps of one byte per character, so the
      // exact bound is reachable; fail loudly if that ever changes.
      throw new Error(`could not build an exact ${String(PUBLICATION_RECORD_BYTES)}-byte record`);
    }
    const planned = planPublication({ ledgerValues: [], pending: [record] });
    expect(planned.batches).toHaveLength(1);
    expect(at(planned.batches, 0).bytes).toBe(PUBLICATION_RECORD_BYTES);
  });
});
