// review.fixFinding — every well-formed contract disposition is `ok`.
//
// Pinned here:
//   1. `fixed` and `unchanged_with_reason`-with-evidence are outcomes.
//   2. `needs_human`, `no_outcome`, and `unchanged_with_reason` without
//      evidence are `ok` no-outcome rows that retain the stated disposition,
//      evidence and `evidenceMissing` as TYPED fields.
//   3. The legacy v1 no-change form is `ok` with `disposition: null`.
//   4. Binding is echoed verbatim; the worker session id rides the value
//      (review.fixItem keeps dropping it).
//   5. A `{kind: 'finding'}` item is normalized by the shared
//      normalizeReviewFixInput, not re-mapped.
import { describe, expect, test } from 'vitest';
import { makeFixReviewItem } from '../../../src/ops/review/fixReviewItem.js';
import { makeFixFinding } from '../../../src/ops/review/fixFinding.js';
import {
  baseInput,
  completeWorker,
  expectOk,
  NO_CHANGE,
  scriptedFactory,
  UNCHANGED,
} from './fixReviewItem.helpers.js';
import {
  BINDING,
  expectOk as expectFindingOk,
  findingInput,
  scriptedFindingOp,
} from './fixFinding.helpers.js';

const FIXED = {
  disposition: 'fixed',
  summary: 'Guarded the abort.',
  commits: ['ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'],
  evidence: [],
};

describe('review.fixFinding typed dispositions', () => {
  test('fixed → ok outcome with commits, evidence, binding, usage and session', async () => {
    const usage = { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 };
    const denials = [{ tool: 'bash', reason: 'denied by policy' }];
    const { op } = scriptedFindingOp([
      completeWorker(FIXED, { usage, denials, costUSD: 0.07, sessionId: 'store-1' }),
    ]);
    const value = expectFindingOk(await op(findingInput()));
    expect(value).toEqual({
      kind: 'outcome',
      disposition: 'fixed',
      evidenceMissing: false,
      summary: 'Guarded the abort.',
      commits: FIXED.commits,
      evidence: [],
      binding: BINDING,
      denials,
      usage,
      costUSD: 0.07,
      sessionId: 'store-1',
    });
    expect(value).not.toHaveProperty('truncated');
    expect(value).not.toHaveProperty('summaryTruncated');
  });

  test('unchanged_with_reason with evidence → ok outcome', async () => {
    const { op } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const value = expectFindingOk(await op(findingInput()));
    expect(value.kind).toBe('outcome');
    expect(value.disposition).toBe('unchanged_with_reason');
    expect(value.evidenceMissing).toBe(false);
    expect(value.evidence).toEqual([{ path: 'src/a.ts', line: 3 }]);
  });

  test('needs_human → ok no-outcome, retaining the stated disposition', async () => {
    const contract = {
      disposition: 'needs_human',
      summary: 'An owner must choose between the two guards.',
      commits: [],
      evidence: [],
    };
    const { op } = scriptedFindingOp([completeWorker(contract)]);
    const value = expectFindingOk(await op(findingInput()));
    expect(value).toEqual({
      kind: 'no-outcome',
      disposition: 'needs_human',
      evidenceMissing: false,
      summary: contract.summary,
      commits: [],
      evidence: [],
      binding: BINDING,
      denials: [],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
  });

  test('no_outcome → ok no-outcome', async () => {
    const contract = {
      disposition: 'no_outcome',
      summary: 'The worker could not finish.',
      commits: [],
      evidence: [],
    };
    const { op } = scriptedFindingOp([completeWorker(contract)]);
    const value = expectFindingOk(await op(findingInput()));
    expect(value.kind).toBe('no-outcome');
    expect(value.disposition).toBe('no_outcome');
    expect(value.evidenceMissing).toBe(false);
  });

  test('unchanged_with_reason without evidence → ok no-outcome with evidenceMissing', async () => {
    const contract = {
      disposition: 'unchanged_with_reason',
      summary: 'No change is needed.',
      commits: [],
      evidence: [],
    };
    const { op } = scriptedFindingOp([completeWorker(contract)]);
    const value = expectFindingOk(await op(findingInput()));
    expect(value.kind).toBe('no-outcome');
    expect(value.disposition).toBe('unchanged_with_reason');
    expect(value.evidenceMissing).toBe(true);
  });

  test('legacy v1 no-change → ok no-outcome with a null disposition', async () => {
    const { op } = scriptedFindingOp([
      completeWorker({ changed: false, summary: NO_CHANGE, commits: [] }),
    ]);
    const value = expectFindingOk(await op(findingInput()));
    expect(value.kind).toBe('no-outcome');
    expect(value.disposition).toBeNull();
    expect(value.summary).toBe(NO_CHANGE);
  });

  test('a summary over the head-cap reports summaryTruncated without context truncation', async () => {
    const { op } = scriptedFindingOp([
      completeWorker({ ...UNCHANGED, summary: 'Already satisfied. '.repeat(100) }),
    ]);
    const value = expectFindingOk(await op(findingInput()));
    expect(value.summary).toHaveLength(1_000);
    expect(value.summaryTruncated).toBe(true);
    expect(value.truncated).toBeUndefined();
  });

  test('a {kind: finding} item is normalized by the shared mapper and reaches the prompt', async () => {
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const input = findingInput({
      item: {
        kind: 'finding',
        finding: {
          id: 'F1',
          source: 'agent',
          severity: 'minor',
          text: 'The retry loop swallows the abort signal.',
          status: 'open',
          file: 'src/a.ts',
          line: 9,
        },
      },
    });
    const value = expectFindingOk(await op(input));
    expect(value.binding).toEqual(BINDING);
    expect(invocations[0]?.prompt).toContain('The retry loop swallows the abort signal.');
    expect(invocations[0]?.prompt).toContain('Location: src/a.ts:9');
  });

  test('review.fixItem still drops the worker sessionId while review.fixFinding returns it', async () => {
    const { drivers } = scriptedFactory([
      completeWorker(UNCHANGED, { sessionId: 'store-1' }),
      completeWorker(UNCHANGED, { sessionId: 'store-1' }),
    ]);
    const fixItem = makeFixReviewItem({ drivers });
    const fixFinding = makeFixFinding({ drivers });
    const itemValue = expectOk(await fixItem(baseInput()));
    expect(itemValue).not.toHaveProperty('sessionId');
    const findingValue = expectFindingOk(await fixFinding(findingInput()));
    expect(findingValue.sessionId).toBe('store-1');
  });
});
