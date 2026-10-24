import { describe, expect, it } from 'vitest';
import { partitionReview } from '../../../src/ops/review/internal/reviewPartitions.js';
import {
  isComplete,
  merge,
  openBlocking,
  type FindingsRecord,
} from '../../../src/ops/review/findings.js';

const record = (
  source: 'agent' | 'coderabbit',
  status: 'terminal' | 'blocked',
  findings: FindingsRecord['findings'] = [],
): FindingsRecord => ({
  schemaVersion: 1,
  branch: 'feat/example',
  head: 'abc123',
  sources: [{ kind: source, status }],
  findings,
});

describe('review findings records', () => {
  it('deduplicates by file, line and rule and merges source attribution', () => {
    const one = record('agent', 'terminal', [
      {
        id: 'a',
        source: 'agent',
        file: 'src/a.ts',
        line: 9,
        rule: 'unsafe',
        severity: 'major',
        text: 'unsafe',
        status: 'open',
      },
    ]);
    const two = record('coderabbit', 'terminal', [
      {
        id: 'b',
        source: 'coderabbit',
        file: 'src/a.ts',
        line: 9,
        rule: 'unsafe',
        severity: 'major',
        text: 'unsafe again',
        status: 'open',
      },
    ]);
    const merged = merge([one, two]);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]?.source).toBe('agent,coderabbit');
  });

  it('uses id when any dedup key component is missing', () => {
    const findings = [
      {
        id: 'same',
        source: 'agent',
        file: 'a.ts',
        severity: 'minor',
        text: 'one',
        status: 'open' as const,
      },
    ];
    expect(
      merge([record('agent', 'terminal', findings), record('coderabbit', 'terminal', findings)])
        .findings,
    ).toHaveLength(1);
  });

  it('merges duplicate findings conservatively so closed/minor copies cannot hide open/major', () => {
    const openMajor = record('agent', 'terminal', [
      {
        id: 'a',
        source: 'agent',
        file: 'src/a.ts',
        line: 9,
        rule: 'unsafe',
        severity: 'major',
        text: 'open issue',
        status: 'open',
      },
    ]);
    const rejectedMinor = record('coderabbit', 'terminal', [
      {
        id: 'b',
        source: 'coderabbit',
        file: 'src/a.ts',
        line: 9,
        rule: 'unsafe',
        severity: 'minor',
        text: 'dismissed copy',
        status: 'rejected',
      },
    ]);
    const combined = merge([rejectedMinor, openMajor]);
    expect(combined.findings[0]).toMatchObject({ severity: 'major', status: 'open' });
    expect(openBlocking(combined)).toHaveLength(1);
  });

  it('rejects records for different branch or head', () => {
    expect(() =>
      merge([record('agent', 'terminal'), { ...record('coderabbit', 'terminal'), head: 'other' }]),
    ).toThrow('findings records must describe the same branch and head');
  });

  it('merges duplicate ids conservatively and fills missing finding metadata', () => {
    const previous = record('agent', 'terminal', [
      {
        id: 'shared',
        source: 'agent',
        severity: 'unknown',
        text: 'older evidence',
        status: 'deferred',
      },
    ]);
    const next = record('coderabbit', 'terminal', [
      {
        id: 'shared',
        source: 'coderabbit',
        file: 'src/a.ts',
        rule: 'unsafe',
        severity: 'major',
        text: 'new evidence',
        status: 'rejected',
        reason: 'not applicable',
        evidence: 'reproduced in fixture',
      },
    ]);
    const lineOnly = record('agent', 'terminal', [
      {
        id: 'shared',
        source: 'agent',
        line: 4,
        severity: 'low',
        text: 'location detail',
        status: 'fixed',
      },
    ]);
    const [merged] = merge([previous, next, lineOnly]).findings;
    expect(merged).toMatchObject({
      id: 'shared',
      source: 'agent,coderabbit',
      file: 'src/a.ts',
      line: 4,
      rule: 'unsafe',
      severity: 'major',
      status: 'deferred',
      reason: 'not applicable',
      evidence: 'reproduced in fixture',
    });
  });

  it.each([
    ['open', 'fixed', 'open'],
    ['rejected', 'fixed', 'rejected'],
    ['fixed', 'fixed', 'fixed'],
  ] as const)('keeps the conservative status for %s + %s', (first, second, expected) => {
    const finding = (status: 'open' | 'fixed' | 'rejected') => ({
      id: 'same',
      source: 'agent',
      severity: 'major',
      text: status,
      status,
    });
    const [merged] = merge([
      record('agent', 'terminal', [finding(first)]),
      record('coderabbit', 'terminal', [finding(second)]),
    ]).findings;
    expect(merged?.status).toBe(expected);
  });

  it('rejects an empty merge and recognizes a complete configured source set', () => {
    expect(() => merge([])).toThrow('findings.merge requires at least one record');
    expect(
      isComplete(merge([record('agent', 'terminal'), record('coderabbit', 'terminal')]), [
        'agent',
        'coderabbit',
      ]),
    ).toBe(true);
  });

  it('does not count blocked configured sources and exposes open blocking findings', () => {
    const value = record('coderabbit', 'blocked', [
      { id: 'x', source: 'coderabbit', severity: 'critical', text: 'issue', status: 'open' },
    ]);
    expect(isComplete(value, ['coderabbit', 'agent'])).toBe(false);
    expect(openBlocking(value)).toHaveLength(1);
    expect(isComplete(merge([value, record('agent', 'terminal')]), ['coderabbit', 'agent'])).toBe(
      false,
    );
  });
});

it('deferred major findings remain blocking for every shared readiness consumer', () => {
  const r = record('agent', 'terminal', [
    {
      id: 'deferred',
      source: 'agent',
      severity: 'major',
      text: 'known accepted defect',
      status: 'deferred',
      reason: 'follow-up',
    },
  ]);
  expect(openBlocking(r, ['critical', 'major']).map((finding) => finding.id)).toEqual(['deferred']);
});

it('keeps reviewed scope only when every merged source attests the same immutable comparison', () => {
  const one = {
    ...record('agent', 'terminal'),
    reviewed: { base: 'a'.repeat(40), scope: 'full' as const },
  };
  const two = { ...record('coderabbit', 'terminal'), reviewed: one.reviewed };
  expect(merge([one, two]).reviewed).toEqual(one.reviewed);
  expect(merge([one, record('coderabbit', 'terminal')]).reviewed).toBeUndefined();
  expect(
    merge([one, { ...two, reviewed: { ...one.reviewed, base: 'b'.repeat(40) } }]).reviewed,
  ).toBeUndefined();
  expect(
    merge([one, { ...two, reviewed: { ...one.reviewed, scope: 'uncommitted' } }]).reviewed,
  ).toBeUndefined();
});

it.each(['partial', 'head', 'base', 'scope', 'gap'] as const)(
  'refuses terminal clean proof with %s coverage evidence',
  (mode) => {
    const { coverage } = partitionReview({
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      scope: 'full',
      components: [{ component: 'tracked:a', path: 'a', text: 'diff' }],
    });
    coverage.partitions.forEach((part) => {
      part.complete = true;
    });
    const candidate: FindingsRecord = {
      ...record('agent', 'terminal'),
      head: coverage.head,
      reviewed: { base: coverage.base, scope: 'full' },
      sources: [{ kind: 'agent', status: 'terminal', coverage }],
    };
    expect(isComplete(candidate, ['agent'])).toBe(true);
    if (mode === 'partial') coverage.partitions[0]!.complete = false;
    if (mode === 'head') coverage.head = 'c'.repeat(40);
    if (mode === 'base') coverage.base = 'c'.repeat(40);
    if (mode === 'scope') coverage.scope = 'uncommitted';
    if (mode === 'gap') coverage.partitions[0]!.ranges[0]!.start = 1;
    expect(isComplete(candidate, ['agent'])).toBe(false);
  },
);
