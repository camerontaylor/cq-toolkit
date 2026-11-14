import { describe, expect, test } from 'vitest';
import { JsonObject, toPlainJson, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  BackfillReportError,
  baseline,
  findingTriage,
  summary,
  type BackfillReportRepo,
  type TriageRow,
} from '../../../src/policy/crq/backfillReport.js';
import { ledgerJsonDigest } from '../../../src/policy/crq/pythonJson.js';
import { loadFamily, textAt, valueAt } from './backfillFixtures.js';

const REPORT = loadFamily('backfill-report');

/**
 * The vector's deterministic repository stub, bound as the report's seam.
 *
 * A group-P summary case carries the Git answers it expects (`tree` keyed by
 * commit, then per-`(old, new, path)` lineage, proven deletion and carry), so the
 * port's seam is exercised with the oracle's own facts instead of a mock.
 */
function stubRepo(spec: unknown): BackfillReportRepo {
  const document = spec === undefined || spec === null ? new JsonObject([]) : (spec as JsonObject);
  const rows = (key: string): JsonObject[] => {
    const value = document.get(key);
    return Array.isArray(value)
      ? value.filter((row): row is JsonObject => row instanceof JsonObject)
      : [];
  };
  const keyOf = (row: JsonObject): string =>
    [row.get('old'), row.get('new'), row.get('path')].map((part) => String(part)).join('\u0000');
  const trees = new Map(
    rows('tree').map((row) => [String(row.get('old')), String(row.get('result'))]),
  );
  const treesRoot = document.get('tree');
  if (treesRoot instanceof JsonObject) {
    for (const [commit, tree] of treesRoot.entries) trees.set(commit, String(tree));
  }
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const lineages = new Map(rows('lineage').map((row) => [keyOf(row), text(row.get('result'))]));
  const deleted = new Map(
    rows('proven_deleted').map((row) => [keyOf(row), row.get('result') === true]),
  );
  // `repo.carry(lines)` answers with the *new* line numbers the requested old
  // lines survived at, so the stub filters the recorded pairs by their old line.
  const carries = new Map(
    rows('carry').map((row) => {
      const pairs: Array<readonly [number, number]> = [];
      const mapped = toPlainJson(row.get('mapped') as JsonValue);
      if (Array.isArray(mapped)) {
        for (const pair of mapped) {
          if (Array.isArray(pair) && pair.length === 2) {
            const oldLine: unknown = pair[0];
            const newLine: unknown = pair[1];
            if (typeof oldLine === 'number' && typeof newLine === 'number') {
              pairs.push([oldLine, newLine]);
            }
          }
        }
      }
      return [keyOf(row), { name: text(row.get('result')), pairs }] as const;
    }),
  );
  return {
    tree: async (commit) => {
      const value = trees.get(commit);
      if (value === undefined) throw new Error(`no tree for ${commit}`);
      return value;
    },
    lineage: async (old, next, path) => lineages.get([old, next, path].join('\u0000')) ?? null,
    provenDeleted: async (old, next, path) =>
      deleted.get([old, next, path].join('\u0000')) ?? false,
    carry: async (old, next, path, lines) => {
      const entry = carries.get([old, next, path].join('\u0000'));
      const surviving = new Set<number>();
      for (const [oldLine, newLine] of entry?.pairs ?? []) {
        if (lines.has(oldLine)) surviving.add(newLine);
      }
      return { name: entry?.name ?? null, mapped: surviving };
    },
  };
}

describe.each(REPORT.filter((vector) => vector.source === 'backfill_report.baseline'))(
  'group-p backfill-report/$name',
  (vector) => {
    test('backfill_report.baseline matches the Python oracle', () => {
      const input = vector.input;
      expect(
        baseline({
          ranked: valueAt(input, 'ranked'),
          tree: textAt(input, 'tree'),
          policyDigest: textAt(input, 'policy_digest'),
          ledgerHead: textAt(input, 'ledger_head'),
          at: textAt(input, 'at'),
        }),
      ).toEqual(toPlainJson(valueAt(vector.expect, 'value') as JsonValue));
    });
  },
);

describe.each(REPORT.filter((vector) => vector.source === 'backfill_report.summary'))(
  'group-p backfill-report/$name',
  (vector) => {
    test('backfill_report.summary matches the Python oracle', async () => {
      const input = vector.input;
      const original = input.has('original') ? input.get('original') : undefined;
      await expect(
        summary({
          ranked: valueAt(input, 'ranked'),
          queue: valueAt(input, 'queue'),
          original: original ?? undefined,
          repo: stubRepo(input.get('repo')),
        }),
      ).resolves.toEqual(toPlainJson(valueAt(vector.expect, 'value') as JsonValue));
    });
  },
);

test('a baseline with a foreign digest is refused, not reported', async () => {
  const vector = REPORT.find(
    (entry) =>
      entry.source === 'backfill_report.summary' &&
      entry.input.get('original') instanceof JsonObject,
  );
  if (vector === undefined) throw new Error('report vectors are empty');
  const original = vector.input.get('original');
  if (!(original instanceof JsonObject)) throw new Error('fixture has no baseline');
  const forged = new JsonObject(
    original.entries.map(([key, value]) => [key, key === 'target' ? 'f'.repeat(40) : value]),
  );
  await expect(
    summary({
      ranked: valueAt(vector.input, 'ranked'),
      queue: valueAt(vector.input, 'queue'),
      original: forged,
      repo: stubRepo(vector.input.get('repo')),
    }),
  ).rejects.toThrow('baseline hash mismatch');
});

function triageRow(file: string, value: Record<string, unknown>): TriageRow {
  return { file, value };
}

test('finding triage counts statuses and routes only the typed failure classes', () => {
  const finding = { id: 'f1', title: 'thread', severity: 'major', path: 'src/a.py' };
  const rows: TriageRow[] = [
    triageRow('a.json', {
      status: 'needs-human',
      canonical_id: 'c1',
      target: 't1',
      finding,
      failure_class: 'owner-decision',
    }),
    triageRow('b.json', {
      status: 'needs-human',
      canonical_id: 'c2',
      target: 't2',
      finding: { ...finding, id: 'f2' },
      failure_class: 'evidence',
      context_error: { kind: 'stale' },
    }),
    triageRow('c.json', {
      status: 'needs-human',
      canonical_id: 'c3',
      target: 't3',
      finding: { ...finding, id: 'f3' },
      failure_class: 'legacy-string',
    }),
    triageRow('d.json', {
      status: 'dismissed',
      canonical_id: 'c4',
      target: 't4',
      finding: { ...finding, id: 'f4' },
    }),
  ];
  const result = findingTriage(rows) as {
    counts: Record<string, number>;
    owner_decisions_count: number;
    operator_attention_count: number;
    unknown_failure_class_count: number;
    unknown_failure_class_note: string;
    context_failures_count: number;
    needs_human_count?: number;
  };
  expect(result.counts).toEqual({ dismissed: 1, 'needs-human': 3 });
  expect(result.owner_decisions_count).toBe(1);
  expect(result.operator_attention_count).toBe(2);
  expect(result.unknown_failure_class_count).toBe(1);
  expect(result.unknown_failure_class_note).toContain('operator attention');
  expect(result.context_failures_count).toBe(1);
  // Strict mode never publishes a partial count.
  expect(result.needs_human_count).toBeUndefined();
});

test('finding triage refuses a malformed row instead of counting it', () => {
  expect(() =>
    findingTriage([triageRow('bad.json', { status: 'needs-human', canonical_id: 'c1' })]),
  ).toThrow(BackfillReportError);
  expect(() =>
    findingTriage([
      triageRow('empty.json', {
        status: 'needs-human',
        canonical_id: '',
        target: 't',
        finding: { id: 'f', title: 't', severity: 's' },
      }),
    ]),
  ).toThrow('invalid finding row');
});

test('an empty triage directory reports empty counts, never a stale backlog', () => {
  expect(findingTriage([])).toEqual({ counts: {}, needs_human: [] });
});

test('a baseline row keeps its digest over every row field', () => {
  const ranked = {
    manifest_id: 'a'.repeat(64),
    target: '1'.repeat(40),
    candidates: [{ tier: 'T1' }],
    paths: [
      {
        path: 'src/a.py',
        blob: 'b'.repeat(40),
        tier: 'T1',
        lines: 4,
        uncovered: [[1, 2]],
        disposition: 'included',
        reason: 'tracked regular UTF8 text',
      },
    ],
  };
  const value = baseline({
    ranked,
    tree: '2'.repeat(40),
    policyDigest: 'd'.repeat(64),
    ledgerHead: 'e'.repeat(40),
    at: '2026-11-09T00:00:00Z',
  });
  const { id, ...withoutId } = value;
  expect(id).toBe(ledgerJsonDigest(withoutId));
  expect(value['bounded_partitions']).toBe(1);
});
