// `review_record.import_record` against hostile retained records: the duplicate scan
// raises KeyError/TypeError exactly where Python does (vectors from
// apps/crq-python/import_record_duplicate_vectors.py).
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { importRecord, type SubmittedRecord } from '../../../src/policy/crq/reviewRecord.js';

interface Vector {
  readonly name: string;
  readonly existing: unknown[];
  readonly expect: { action?: string; events?: number; error?: string };
}

const document = JSON.parse(
  await readFile(
    new URL(
      '../../../apps/crq-python/fixtures/crq-import-record-duplicate/cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  submitted: { producer: string; id: string; report: string; submitter: string; at: string };
  cases: Vector[];
};

const submitted: SubmittedRecord = {
  producer: document.submitted.producer,
  id: document.submitted.id,
  reportBytes: new TextEncoder().encode(document.submitted.report),
  repo: null,
  head: null,
  base: null,
  headTree: null,
  target: null,
  reviewer: null,
  authenticatedSubmitter: document.submitted.submitter,
  verdict: null,
  claimedScope: null,
  independence: null,
  supersedes: null,
  forgeEvidence: null,
};

function load(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
  if (!(parsed instanceof JsonObject)) throw new Error('not an object');
  return parsed;
}

describe('importRecord duplicate scan matches the Python oracle', () => {
  for (const vector of document.cases) {
    test(vector.name, () => {
      const existing = vector.existing.map(load);
      const run = () => importRecord(submitted, document.submitted.at, existing);
      if (vector.expect.error !== undefined) {
        expect(run).toThrow(expect.objectContaining({ name: vector.expect.error }));
        return;
      }
      const result = run();
      expect(result.action).toBe(vector.expect.action);
      expect(result.events).toHaveLength(vector.expect.events ?? 0);
    });
  }
});
