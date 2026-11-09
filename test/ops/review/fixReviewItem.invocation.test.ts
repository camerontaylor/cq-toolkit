// Split provenance: test/ops/review/fixReviewItem.test.ts was split into the
// fixReviewItem.*.test.ts siblings in this directory; the shared fixtures live
// in fixReviewItem.helpers.ts and the original suite header sits there.
import { describe, expect, test } from 'vitest';
import type { OpInvocation } from '../../../src/driver/types.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import {
  baseInput,
  completeWorker,
  expectOk,
  harnessWith,
  scriptedOp,
  UNCHANGED,
} from './fixReviewItem.helpers.js';

// ---------------------------------------------------------------------------
// 1. Happy path + invocation shape
// ---------------------------------------------------------------------------

describe('fixReviewItem happy path', () => {
  test('complete + valid structured output → ok triple; the invocation carries the conservative defaults', async () => {
    const { op, invocations } = scriptedOp([
      completeWorker({
        disposition: 'fixed',
        summary: 'Guarded the abort.',
        commits: ['ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'],
        evidence: [],
      }),
    ]);
    const value = expectOk(await op(baseInput({ budget: { maxTokens: 12_345 } })));
    expect(value).toEqual({
      disposition: 'fixed',
      changed: true,
      summary: 'Guarded the abort.',
      commits: ['ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'],
      evidence: [],
      denials: [],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    expect('truncated' in value).toBe(false);
    expect(invocations).toHaveLength(1);
    const invocation = invocations[0] as OpInvocation;
    expect(invocation.toolPolicy).toEqual({
      mode: 'allowlist',
      allow: ['read', 'edit', 'write'],
    });
    expect(invocation.sandboxPolicy).toEqual({ level: 'workspace-write' });
    expect(invocation.modelSpec).toEqual({ model: 'test-model', provider: 'test-provider' });
    expect(invocation.budget).toEqual({ maxTokens: 12_345 });
  });

  test('the worktree rides the invocation as its workspace binding; the contract rides as outputSchema; no sessionRef', async () => {
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    await op(baseInput());
    const invocation = invocations[0] as OpInvocation;
    // ADR-0002 §2.4: the PR worktree IS the workspace — no pre-created
    // session record, so no sessionRef ever rides the invocation.
    expect(invocation.workspace).toEqual({ path: '/tmp/cq-fix-review/pr-7' });
    expect('sessionRef' in invocation).toBe(false);
    // ADR-0002 §2.3: the fix contract is the invocation's outputSchema.
    expect(invocation.outputSchema?.name).toBe('review.fixItem/v2');
    expect(invocation.outputSchema?.schema).toBeTruthy();
  });

  test('I6 review fixer sends no session handle', async () => {
    // DOCTRINE I6: the review fixer is a fresh isolated invocation — no
    // caller session context may ride it (merge precedent:
    // resolveConflict.op-outcomes.test.ts).
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    await op(baseInput());
    expect(invocations).toHaveLength(1);
    expect('sessionRef' in (invocations[0] as OpInvocation)).toBe(false);
  });

  test("invocation.modelSpec is the FACTORY-RESOLVED spec (the deprecated 'ai-sdk' alias never reaches the invocation)", async () => {
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    await op(baseInput({ driver: { model: 'm', provider: 'ai-sdk' } }));
    expect(invocations[0]?.modelSpec).toEqual({ model: 'm', provider: 'zai' });
  });

  test('budget omitted → the invocation carries the empty budget', async () => {
    const { op, invocations } = scriptedOp([completeWorker(UNCHANGED)]);
    const value = expectOk(await op(baseInput()));
    expect(value.changed).toBe(false);
    expect(invocations[0]?.budget).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 1b. The DriverRequest the op resolves (ADR-0002 §2.5)
// ---------------------------------------------------------------------------

describe('fixReviewItem factory request', () => {
  test("role 'fixer', the input's ModelSpec, one resolve per call", async () => {
    const { op, requests } = scriptedOp([completeWorker(UNCHANGED), completeWorker(UNCHANGED)]);
    const input = baseInput();
    await op(input);
    await op(baseInput());
    expect(requests).toHaveLength(2);
    expect(requests[0]?.role).toBe('fixer');
    expect(requests[0]?.modelSpec).toEqual(input.driver);
  });

  test('harness passthrough: the input harness rides the request; absent → defaultHarnessConfig', async () => {
    const { op, requests } = scriptedOp([completeWorker(UNCHANGED), completeWorker(UNCHANGED)]);
    const custom = harnessWith((h) => {
      h.tools.bash.commandPatterns = ['git add'];
    });
    await op(baseInput({ harness: custom }));
    await op(baseInput());
    expect(requests[0]?.harness).toEqual(custom);
    expect(requests[1]?.harness).toEqual(defaultHarnessConfig);
  });

  test.each([
    ['retainSessions absent', undefined, undefined],
    ['retainSessions true', true, 'keep'],
    ['retainSessions false', false, 'reap-on-settle'],
  ])('%s → sessionRetention %s', async (_name, retainSessions, expected) => {
    const { op, requests } = scriptedOp([completeWorker(UNCHANGED)], retainSessions);
    await op(baseInput());
    expect(requests[0]?.sessionRetention).toBe(expected);
  });
});
