// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: parseMergeConflictDecision — header group 3.
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import {
  MergeConflictContractError,
  parseMergeConflictDecision,
} from '../../../src/ops/merge/resolveConflict.js';

// ---------------------------------------------------------------------------
// parseMergeConflictDecision
// ---------------------------------------------------------------------------

describe('parseMergeConflictDecision', () => {
  test('accepts the object form', () => {
    expect(parseMergeConflictDecision({ decision: 'acted', summary: 'merged base' })).toEqual({
      decision: 'acted',
      summary: 'merged base',
    });
  });

  test('summary defaults to empty when absent', () => {
    expect(parseMergeConflictDecision({ decision: 'acted' })).toEqual({
      decision: 'acted',
      summary: '',
    });
  });

  test("normalizes the 'escalated' alias to 'escalate'", () => {
    expect(parseMergeConflictDecision({ decision: 'escalated', summary: 'needs a human' })).toEqual(
      {
        decision: 'escalate',
        summary: 'needs a human',
      },
    );
  });

  test('tolerates unknown extra keys at the object level', () => {
    expect(parseMergeConflictDecision({ decision: 'acted', summary: 's', notes: 'extra' })).toEqual(
      { decision: 'acted', summary: 's' },
    );
  });

  test('accepts a JSON decision line embedded in narration prose', () => {
    const raw = [
      'I merged origin/main into the worktree and fixed src/a.ts.',
      'Checks are green.',
      '{"decision":"acted","summary":"pushed feat/topic"}',
      'Done.',
    ].join('\n');
    expect(parseMergeConflictDecision(raw)).toEqual({
      decision: 'acted',
      summary: 'pushed feat/topic',
    });
  });

  test('the LAST valid decision line wins (the final word)', () => {
    const raw = [
      '{"decision":"acted","summary":"first attempt"}',
      'wait — the push was refused',
      '{"decision":"escalated","summary":"push refused by the forge"}',
    ].join('\n');
    expect(parseMergeConflictDecision(raw)).toEqual({
      decision: 'escalate',
      summary: 'push refused by the forge',
    });
  });

  test('rejects pure prose', () => {
    expect(() => parseMergeConflictDecision('I resolved everything fine')).toThrow(
      MergeConflictContractError,
    );
  });

  test('rejects a JSON line with an unknown decision word', () => {
    expect(() => parseMergeConflictDecision('{"decision":"unclear","summary":"x"}')).toThrow(
      MergeConflictContractError,
    );
  });

  test('rejects a decision line with a non-string summary', () => {
    expect(() => parseMergeConflictDecision('{"decision":"acted","summary":5}')).toThrow(
      MergeConflictContractError,
    );
  });

  test('rejects an empty string', () => {
    expect(() => parseMergeConflictDecision('')).toThrow(MergeConflictContractError);
  });

  test('rejects number, null, and array input', () => {
    for (const raw of [7, null, ['{"decision":"acted"}']]) {
      expect(() => parseMergeConflictDecision(raw)).toThrow(MergeConflictContractError);
    }
  });

  test('the error message states the contract and bounds the quoted prefix at 200 chars', () => {
    const long = `prose prose prose ${'x'.repeat(300)} TAIL-MARKER`;
    try {
      parseMergeConflictDecision(long);
      expect.unreachable('the parser must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MergeConflictContractError);
      const message = err instanceof Error ? err.message : '';
      expect(message).toContain('{"decision":"acted|escalate","summary":"…"}');
      // The ≤200-char prefix is quoted; the tail beyond it is not.
      expect(message).toContain('x'.repeat(50));
      expect(message).not.toContain('TAIL-MARKER');
    }
  });
});
