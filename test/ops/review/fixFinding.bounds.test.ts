// review.fixFinding — fixed bounds, measured on the EXACT prepared request
// and refused before dispatch (never truncated).
//
// Pinned here:
//   1. item.body: 8000 UTF-16 units accepted, 8001 refused (failed /
//      evidence) with the driver never called. review.fixItem still
//      TRUNCATES at the same bound.
//   2. prior comments: review.fixFinding dispatches them WHOLE (a comment
//      over MAX_COMMENT_CHARS keeps its decisive tail), and review.fixItem
//      still head-caps the same comment. A fixFinding request that grows too
//      large is refused by the whole-request bound, not clipped.
//   3. instructions: 1..2000 UTF-16 units and no NUL; the bounds count
//      UTF-16 code units (a non-BMP char is 2).
//   4. the whole envelope JSON.stringify({ normalizedInput, invocation })
//      is 32768 UTF-16 units accepted and 32769 refused, with the driver
//      never called. The oracle serializes the ACTUAL invocation captured
//      from the scripted driver and the op-normalized input, never the
//      production measurement helper.
//   5. the envelope is the JSON serialization: escaping and surrogate pairs
//      are measured, not raw string length, and the captured invocation
//      carries its metadata (outputSchema, modelSpec, toolPolicy, workspace,
//      budget).
import { describe, expect, test } from 'vitest';
import type { OpInvocation } from '../../../src/driver/types.js';
import {
  MAX_FIX_FINDING_INSTRUCTIONS_CHARS,
  MAX_SERIALIZED_DISPATCH_CHARS,
} from '../../../src/ops/review/fixFinding.js';
import type { FixFindingInput } from '../../../src/ops/review/fixFinding.js';
import {
  MAX_COMMENT_CHARS,
  MAX_ITEM_BODY_CHARS,
  makeFixReviewItem,
  normalizeReviewFixInput,
} from '../../../src/ops/review/fixReviewItem.js';
import { baseInput, completeWorker, scriptedFactory, UNCHANGED } from './fixReviewItem.helpers.js';
import {
  BINDING,
  findingInput,
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

const itemWithComments = (comments: ReturnType<typeof baseInput>['item']['comments']) => ({
  ...baseInput().item,
  comments,
});

/**
 * Independent whole-request oracle: JSON.stringify over the op-normalized
 * input and the ACTUAL invocation the scripted driver received. It
 * deliberately does not call serializedDispatchChars or prepareFixWorker, so
 * a production measurement bug cannot move the oracle with it.
 */
const envelopeOf = (input: FixFindingInput, invocation: OpInvocation): number =>
  JSON.stringify({ normalizedInput: normalizeReviewFixInput(input), invocation }).length;

/** Run the op, require ok, and capture the actual invocation it dispatched. */
const capture = async (input: FixFindingInput) => {
  const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
  const result = await op(input);
  if (result.status !== 'ok') {
    throw new Error(`expected status 'ok', got '${result.status}'`);
  }
  const invocation = invocations[0];
  if (invocation === undefined) {
    throw new Error('the scripted driver received no invocation');
  }
  return { input, invocation, chars: envelopeOf(input, invocation) };
};

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

describe('review.fixFinding prior-comment preservation', () => {
  const tail = 'DECISIVE_TAIL_MARKER';
  const longComment = `${'x'.repeat(MAX_COMMENT_CHARS)} ${tail}`;

  test(`a ${MAX_COMMENT_CHARS}+ comment is dispatched whole with no truncated flag`, async () => {
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(
      findingInput({
        item: itemWithComments([
          { authorLogin: 'reviewer', body: longComment, createdAt: '2026-09-15T10:00:00Z' },
        ]),
      }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.truncated).toBeUndefined();
    }
    const prompt = invocations[0]?.prompt ?? '';
    expect(prompt).toContain(longComment);
    expect(prompt).toContain(tail);
  });

  test('review.fixItem still head-caps the same comment and reports truncated', async () => {
    const scripted = scriptedFactory([completeWorker(UNCHANGED)]);
    const fixItem = makeFixReviewItem({ drivers: scripted.drivers });
    const result = await fixItem({
      ...baseInput(),
      item: itemWithComments([
        { authorLogin: 'reviewer', body: longComment, createdAt: '2026-09-15T10:00:00Z' },
      ]),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.truncated).toBe(true);
    }
    const prompt = scripted.invocations[0]?.prompt ?? '';
    expect(prompt).toContain('x'.repeat(MAX_COMMENT_CHARS));
    expect(prompt).not.toContain(tail);
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

/** Full-length instructions: 1000 non-BMP scalars = 2000 UTF-16 units. */
const FULL_INSTRUCTIONS = '😀'.repeat(MAX_FIX_FINDING_INSTRUCTIONS_CHARS / 2);

/** Build an input whose INDEPENDENTLY measured envelope is exactly 32768. */
const exactBoundary = async () => {
  const harness = roomyHarness();
  const baseline = await capture(
    findingInput({ harness, instructions: FULL_INSTRUCTIONS, promptOverride: 'base' }),
  );
  const deficit = MAX_SERIALIZED_DISPATCH_CHARS - baseline.chars;
  expect(deficit).toBeGreaterThan(0);
  const asciiPad = Math.floor(deficit / 2);
  const remainder = deficit - asciiPad * 2;
  const exactInput = findingInput({
    harness,
    instructions: FULL_INSTRUCTIONS,
    promptOverride: `base${'a'.repeat(asciiPad)}`,
    binding: remainder === 0 ? { ...BINDING } : { ...BINDING, job: `${BINDING.job}x` },
  });
  const exact = await capture(exactInput);
  expect(exact.chars).toBe(MAX_SERIALIZED_DISPATCH_CHARS);
  return exact;
};

describe('review.fixFinding whole-request bound', () => {
  test(`exactly ${MAX_SERIALIZED_DISPATCH_CHARS} UTF-16 units dispatches with its metadata`, async () => {
    const exact = await exactBoundary();
    expect(exact.invocation.prompt).toContain(FULL_INSTRUCTIONS);
    expect(exact.invocation.outputSchema?.name).toBe('review.fixItem/v2');
    const schema = exact.invocation.outputSchema?.schema;
    expect(schema?.type).toBe('object');
    const properties = schema?.properties as Record<string, unknown> | undefined;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(['disposition', 'summary', 'commits', 'evidence']),
    );
    const serialized = JSON.stringify(exact.invocation);
    expect(serialized).toContain('"outputSchema"');
    expect(serialized).toContain('"review.fixItem/v2"');
    expect(exact.invocation.modelSpec).toEqual(exact.input.driver);
    expect(exact.invocation.toolPolicy.mode).toBe('allowlist');
    expect(exact.invocation.sandboxPolicy.level).toBe('workspace-write');
    expect(exact.invocation.workspace?.path).toBe(exact.input.worktree.path);
    expect(exact.invocation.budget).toEqual({});
  });

  test(`${MAX_SERIALIZED_DISPATCH_CHARS + 1} UTF-16 units is REFUSED with the driver never called`, async () => {
    const exact = await exactBoundary();
    const overInput: FixFindingInput = {
      ...exact.input,
      // Input-only field: the prepared invocation is unchanged, so the
      // independent over-bound measurement is exactly one unit larger.
      binding: { ...exact.input.binding, job: `${exact.input.binding.job}x` },
    };
    expect(envelopeOf(overInput, exact.invocation)).toBe(MAX_SERIALIZED_DISPATCH_CHARS + 1);
    const { op, invocations } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(overInput);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain(`${MAX_SERIALIZED_DISPATCH_CHARS + 1} UTF-16 units`);
      expect(result.error).toContain('refusing before dispatch');
    }
    expect(reportOf(result)).toEqual({ failureClass: 'evidence' });
    expect(invocations).toHaveLength(0);
  });

  test('the envelope measures the JSON serialization: escaping and surrogate pairs count', async () => {
    const harness = roomyHarness();
    const base = await capture(findingInput({ harness, promptOverride: 'base' }));
    const newline = await capture(findingInput({ harness, promptOverride: 'base\n' }));
    const quote = await capture(findingInput({ harness, promptOverride: 'base"' }));
    const emoji = await capture(findingInput({ harness, promptOverride: 'base😀' }));

    // A newline is one raw char, but JSON escapes it to \n (two chars) in
    // BOTH the input and the invocation prompt.
    expect('base\n'.length - 'base'.length).toBe(1);
    expect(newline.chars - base.chars).toBe(4);
    // A double quote is escaped to \" in both copies.
    expect(quote.chars - base.chars).toBe(4);
    // A non-BMP char is two UTF-16 units in both copies.
    expect('😀'.length).toBe(2);
    expect(emoji.chars - base.chars).toBe(4);
  });
});
