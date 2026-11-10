// review.fixFinding — fixed bounds, measured on the EXACT prepared request
// and refused before dispatch (never truncated).
//
// Pinned here:
//   1. item.body: 8000 UTF-16 units accepted, 8001 refused (failed /
//      evidence) with the driver never called. review.fixItem still
//      TRUNCATES at the same bound.
//   2. instructions: 1..2000 UTF-16 units and no NUL; the bounds count
//      UTF-16 code units (a non-BMP char is 2).
//   3. the whole envelope JSON.stringify({ normalizedInput, invocation })
//      is 32768 UTF-16 units accepted and 32769 refused, with the driver
//      never called.
//   4. the envelope is the JSON serialization: escaping and surrogate pairs
//      are measured, not raw string length.
import { describe, expect, test } from 'vitest';
import {
  MAX_FIX_FINDING_INSTRUCTIONS_CHARS,
  MAX_SERIALIZED_DISPATCH_CHARS,
} from '../../../src/ops/review/fixFinding.js';
import { MAX_ITEM_BODY_CHARS, makeFixReviewItem } from '../../../src/ops/review/fixReviewItem.js';
import { baseInput, completeWorker, scriptedFactory, UNCHANGED } from './fixReviewItem.helpers.js';
import {
  BINDING,
  findingInput,
  measureDispatch,
  reportOf,
  roomyHarness,
  scriptedFindingOp,
} from './fixFinding.helpers.js';

const itemWithBody = (length: number) => ({
  id: 'T1',
  path: 'src/a.ts',
  line: 42,
  body: 'a'.repeat(length),
  comments: [],
});

describe('review.fixFinding item-body bound', () => {
  test(`a body of exactly ${MAX_ITEM_BODY_CHARS} UTF-16 units is accepted`, async () => {
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(findingInput({ item: itemWithBody(MAX_ITEM_BODY_CHARS) }));
    expect(result.status).toBe('ok');
    expect(invocations).toHaveLength(1);
  });

  test(`a body of ${MAX_ITEM_BODY_CHARS + 1} units is REFUSED before dispatch`, async () => {
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(findingInput({ item: itemWithBody(MAX_ITEM_BODY_CHARS + 1) }));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain(`item body is ${MAX_ITEM_BODY_CHARS + 1} UTF-16 units`);
      expect(result.error).toContain('refusing before dispatch');
    }
    expect(reportOf(result)).toEqual({ failureClass: 'evidence' });
    expect(invocations).toHaveLength(0);
  });

  test('review.fixItem still TRUNCATES the same body instead of refusing it', async () => {
    // The shared seam keeps the historical behavior for the old op; the
    // new bound is fixFinding-only.
    const scripted = scriptedFactory([completeWorker(UNCHANGED)]);
    const fixItem = makeFixReviewItem({ drivers: scripted.drivers });
    const value = await fixItem({
      ...baseInput(),
      item: itemWithBody(MAX_ITEM_BODY_CHARS + 1),
    });
    expect(value.status).toBe('ok');
    if (value.status === 'ok') {
      expect(value.value.truncated).toBe(true);
    }
  });
});

describe('review.fixFinding instruction bounds', () => {
  test('1 UTF-16 unit is accepted', async () => {
    const { op } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    expect((await op(findingInput({ instructions: 'x' }))).status).toBe('ok');
  });

  test('an empty string is REFUSED before dispatch', async () => {
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(findingInput({ instructions: '' }));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('1..2000');
    expect(reportOf(result)).toEqual({ failureClass: 'evidence' });
    expect(invocations).toHaveLength(0);
  });

  test(`${MAX_FIX_FINDING_INSTRUCTIONS_CHARS} UTF-16 units is accepted`, async () => {
    const { op } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(
      findingInput({ instructions: 'a'.repeat(MAX_FIX_FINDING_INSTRUCTIONS_CHARS) }),
    );
    expect(result.status).toBe('ok');
  });

  test(`${MAX_FIX_FINDING_INSTRUCTIONS_CHARS + 1} UTF-16 units is REFUSED before dispatch`, async () => {
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(
      findingInput({ instructions: 'a'.repeat(MAX_FIX_FINDING_INSTRUCTIONS_CHARS + 1) }),
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('over the fixed');
    expect(reportOf(result)).toEqual({ failureClass: 'evidence' });
    expect(invocations).toHaveLength(0);
  });

  test('NUL is REFUSED before dispatch', async () => {
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(findingInput({ instructions: 'scan\u0000this' }));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('NUL');
    expect(reportOf(result)).toEqual({ failureClass: 'evidence' });
    expect(invocations).toHaveLength(0);
  });

  test('the bound counts UTF-16 code units: 1000 non-BMP chars (2000 units) pass, 1001 (2002) refuse', async () => {
    const accepted = await scriptedFindingOp([completeWorker(UNCHANGED)]).op(
      findingInput({ instructions: '😀'.repeat(1_000) }),
    );
    expect('😀'.length).toBe(2);
    expect(accepted.status).toBe('ok');

    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const refused = await op(findingInput({ instructions: '😀'.repeat(1_001) }));
    expect(refused.status).toBe('failed');
    if (refused.status === 'failed') expect(refused.error).toContain('2002 UTF-16 units');
    expect(invocations).toHaveLength(0);
  });
});

/** Build an input whose measured envelope is exactly the 32768 boundary. */
const exactBoundaryInput = () => {
  const harness = roomyHarness();
  const base = measureDispatch(findingInput({ harness, promptOverride: 'base' }));
  const deficit = MAX_SERIALIZED_DISPATCH_CHARS - base;
  const asciiPad = Math.floor(deficit / 2);
  const remainder = deficit - asciiPad * 2;
  const input = findingInput({
    harness,
    promptOverride: `base${'a'.repeat(asciiPad)}`,
    binding: remainder === 0 ? { ...BINDING } : { ...BINDING, job: `${BINDING.job}x` },
  });
  return { input, measured: measureDispatch(input) };
};

describe('review.fixFinding whole-request bound', () => {
  test(`exactly ${MAX_SERIALIZED_DISPATCH_CHARS} UTF-16 units dispatches`, async () => {
    const exact = exactBoundaryInput();
    expect(exact.measured).toBe(MAX_SERIALIZED_DISPATCH_CHARS);
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(exact.input);
    expect(result.status).toBe('ok');
    expect(invocations).toHaveLength(1);
  });

  test(`${MAX_SERIALIZED_DISPATCH_CHARS + 1} UTF-16 units is REFUSED with the driver never called`, async () => {
    const exact = exactBoundaryInput();
    const over = {
      ...exact.input,
      binding: { ...exact.input.binding, job: `${exact.input.binding.job}x` },
    };
    expect(measureDispatch(over)).toBe(MAX_SERIALIZED_DISPATCH_CHARS + 1);
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(over);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain(`${MAX_SERIALIZED_DISPATCH_CHARS + 1} UTF-16 units`);
      expect(result.error).toContain('refusing before dispatch');
    }
    expect(reportOf(result)).toEqual({ failureClass: 'evidence' });
    expect(invocations).toHaveLength(0);
  });

  test('the envelope measures the JSON serialization: escaping and surrogate pairs count', () => {
    const harness = roomyHarness();
    const base = measureDispatch(findingInput({ harness, promptOverride: 'base' }));
    const newline = measureDispatch(findingInput({ harness, promptOverride: 'base\n' }));
    const quote = measureDispatch(findingInput({ harness, promptOverride: 'base"' }));
    const emoji = measureDispatch(findingInput({ harness, promptOverride: 'base😀' }));

    // A newline is one raw char, but JSON escapes it to \n (two chars) in
    // BOTH the input and the invocation prompt.
    expect('base\n'.length - 'base'.length).toBe(1);
    expect(newline - base).toBe(4);
    // A double quote is escaped to \" in both copies.
    expect(quote - base).toBe(4);
    // A non-BMP char is two UTF-16 units in both copies.
    expect('😀'.length).toBe(2);
    expect(emoji - base).toBe(4);
  });
});
