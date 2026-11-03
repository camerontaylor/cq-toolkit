// Split provenance: test/ops/review/fixReviewItem.test.ts was split into the
// fixReviewItem.*.test.ts siblings in this directory; the shared fixtures live
// in fixReviewItem.helpers.ts and the original suite header sits there.
import { describe, expect, test } from 'vitest';
import { MAX_COMMENT_CHARS, reviewFixHarness } from '../../../src/ops/review/fixReviewItem.js';
import { defaultFixPrompt } from '../../../src/ops/review/prompts/defaultFixPrompt.js';
import {
  baseInput,
  completeWorker,
  expectOk,
  harnessWith,
  scriptedOp,
  UNCHANGED,
} from './fixReviewItem.helpers.js';

// ---------------------------------------------------------------------------
// 2. Harness-driven allowlist
// ---------------------------------------------------------------------------

describe('fixReviewItem tool allowlist', () => {
  test('bash enabled with non-empty commandPatterns → allow includes bash', async () => {
    const harness = harnessWith((h) => {
      h.tools.bash.commandPatterns = ['npm test'];
    });
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    await op(baseInput({ harness }));
    expect(invocations[0]?.toolPolicy).toEqual({
      mode: 'allowlist',
      allow: ['read', 'edit', 'write', 'bash'],
    });
  });

  test('edit disabled → allow drops edit', async () => {
    const harness = harnessWith((h) => {
      h.tools.edit.enabled = false;
    });
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    await op(baseInput({ harness }));
    expect(invocations[0]?.toolPolicy).toEqual({ mode: 'allowlist', allow: ['read', 'write'] });
  });

  test('bash enabled but commandPatterns empty (the deny-all default) → bash stays out', async () => {
    const harness = harnessWith((h) => {
      h.tools.bash.enabled = true;
      h.tools.bash.commandPatterns = [];
    });
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    await op(baseInput({ harness }));
    expect(invocations[0]?.toolPolicy).toEqual({
      mode: 'allowlist',
      allow: ['read', 'edit', 'write'],
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Prompt override / default
// ---------------------------------------------------------------------------

describe('fixReviewItem system prompt', () => {
  test('without override the shipped default is the system prompt', async () => {
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    await op(baseInput());
    const prompt = invocations[0]?.prompt ?? '';
    expect(prompt.startsWith(`${defaultFixPrompt}\n\n`)).toBe(true);
  });

  test('promptOverride REPLACES the default wholesale', async () => {
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    await op(baseInput({ promptOverride: 'OVERRIDE PROMPT' }));
    const prompt = invocations[0]?.prompt ?? '';
    expect(prompt.startsWith('OVERRIDE PROMPT\n\n')).toBe(true);
    expect(prompt.includes(defaultFixPrompt)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Truncation
// ---------------------------------------------------------------------------

describe('fixReviewItem truncation', () => {
  test('system prompt over maxSystemPromptChars → truncated true + head-truncated', async () => {
    const harness = harnessWith((h) => {
      h.promptBudget.maxSystemPromptChars = 50;
    });
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    const value = expectOk(await op(baseInput({ harness })));
    expect(value.truncated).toBe(true);
    const prompt = invocations[0]?.prompt ?? '';
    expect(prompt.slice(0, 50)).toBe(defaultFixPrompt.slice(0, 50));
    expect(prompt.includes(defaultFixPrompt)).toBe(false);
  });

  test(`a comment over MAX_COMMENT_CHARS (${MAX_COMMENT_CHARS}) → truncated true + head-capped`, async () => {
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    const input = baseInput();
    input.item.comments = [
      { authorLogin: 'reviewer', body: 'x'.repeat(MAX_COMMENT_CHARS + 1), createdAt: null },
    ];
    const value = expectOk(await op(input));
    expect(value.truncated).toBe(true);
    const prompt = invocations[0]?.prompt ?? '';
    expect(prompt.includes('x'.repeat(MAX_COMMENT_CHARS))).toBe(true);
    expect(prompt.includes('x'.repeat(MAX_COMMENT_CHARS + 1))).toBe(false);
  });
});

describe('reviewFixHarness (round-3 item 9)', () => {
  test('narrowed to exactly the git commit plumbing, deep-frozen, schema-parsed', () => {
    expect(reviewFixHarness.tools.bash.commandPatterns).toEqual([
      'git add',
      'git commit',
      'git status',
      'git diff',
      'git log',
      'git rev-parse',
    ]);
    expect(Object.isFrozen(reviewFixHarness)).toBe(true);
    expect(Object.isFrozen(reviewFixHarness.tools.bash)).toBe(true);
    // Schema-parsed: reparsing the shipped value is a no-op.
    expect(reviewFixHarness).toEqual(reviewFixHarness);
  });
});
