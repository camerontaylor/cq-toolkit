import { describe, expect, it } from 'vitest';
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

  it('rejects records for different branch or head', () => {
    expect(() =>
      merge([record('agent', 'terminal'), { ...record('coderabbit', 'terminal'), head: 'other' }]),
    ).toThrow('findings records must describe the same branch and head');
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
