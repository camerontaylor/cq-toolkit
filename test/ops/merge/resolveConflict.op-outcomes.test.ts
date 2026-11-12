// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: 'resolveConflict op' outcome mapping + invocation shape — header group 5 (first half).
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import {
  headRefFor,
  mergeWorktreeBranchFor,
} from '../../../src/adapters/forge-github/mergeEffects.js';
import {
  DEFAULT_RESOLVE_WALL_CLOCK_MS,
  makeResolveConflictOp,
} from '../../../src/ops/merge/resolveConflict.js';
import {
  ZERO_USAGE,
  MODEL_SPEC,
  completed,
  stopped,
  baseInput,
  FakeMergeEffects,
  FakeDriver,
  factoryOf,
  firstInvocation,
  failedError,
  fakeLoadPrompt,
  scanClean,
} from './resolveConflict.helpers.js';

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

describe('resolveConflict op', () => {
  test('acted path: ok value, one prepare/remove pair around the fn, workspace-bound dispatch', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(
      completed({ decision: 'acted', summary: 'merged origin/main and pushed feat/topic' }),
    );
    const factory = factoryOf(driver);
    const op = makeResolveConflictOp({
      effects,
      drivers: factory,
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const result = await op(baseInput());

    expect(result).toEqual({
      status: 'ok',
      value: {
        pr: 44,
        decision: 'acted',
        summary: 'merged origin/main and pushed feat/topic',
        usage: ZERO_USAGE,
      },
    });
    // The exact sequence: fetch + baseline validate (truth first), prepare,
    // the fn (dispatch + the publication gate: the worktree-branch read,
    // the baseline..resolved patch read, and the op's own publication
    // push — #1193), then remove-in-finally — prepare and remove each
    // exactly once, remove after fn. NO session creation: the worktree
    // rides the invocation as its workspace binding.
    expect(effects.calls).toEqual([
      `fetch:${headRefFor(44)}`,
      `validate:${headRefFor(44)}`,
      `prepare:44@${headRefFor(44)}`,
      `validate:${mergeWorktreeBranchFor(44)}`,
      `diff:${String(effects.baselineSha)}..${String(effects.resolutionSha)}`,
      `push:${String(effects.resolutionSha)}:refs/heads/feat/topic@/wt/pr-44`,
      'remove:/wt/pr-44',
    ]);
    expect(driver.invocations).toHaveLength(1);
    const invocation = firstInvocation(driver);
    // The prepared worktree IS the workspace binding; there is NO
    // pre-created session (no sessionRef on the invocation).
    expect(invocation.workspace).toEqual({ path: '/wt/pr-44' });
    expect('sessionRef' in invocation).toBe(false);
    // The decision schema rides the invocation (ADR-0002 §2.3) under its
    // stable contract name.
    expect(invocation.outputSchema).toBeDefined();
    expect(invocation.outputSchema?.name).toBe('merge.resolveConflict/v1');
    expect(typeof invocation.outputSchema?.schema).toBe('object');
    // The prompt carried the rendered vars and the acted contract.
    expect(invocation.prompt).toContain('feat/topic');
    expect(invocation.prompt).toContain('origin/main');
    expect(invocation.prompt).toContain('/wt/pr-44');
    expect(invocation.prompt).toContain('{"decision":"acted|escalate","summary":"…"}');
    // Tool surface: the write-capable allowlist, exactly.
    expect(invocation.toolPolicy).toEqual({ allow: ['read', 'edit', 'bash'], mode: 'allowlist' });
    // THE SANDBOX TRAP (module doc): level 'none' is the ONLY correct
    // request — a workspace-write sandbox would block the network the
    // base FETCH needs (the worker no longer pushes; #1193), and the
    // frozen SandboxPolicy has no network field to request it with. There
    // is no OS-level confinement on this seam: the workspace binding is
    // driver-owned cwd/confinement data, and the bounds that remain are
    // the allowlist above, the prompt's constraints, and the wall-clock
    // budget.
    expect(invocation.sandboxPolicy).toEqual({ level: 'none' });
    // Default wall clock (UC row 44's 20 minutes).
    expect(DEFAULT_RESOLVE_WALL_CLOCK_MS).toBe(1_200_000);
    expect(invocation.budget).toEqual({ wallClockMs: DEFAULT_RESOLVE_WALL_CLOCK_MS });
    // The factory echoed the request spec, so the invocation carries it.
    expect(invocation.modelSpec).toEqual(MODEL_SPEC);
  });

  test('an input wallClockMs override reaches the invocation budget', async () => {
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    await op({ ...baseInput(), wallClockMs: 60_000 });

    expect(firstInvocation(driver).budget).toEqual({ wallClockMs: 60_000 });
  });

  test('conflictFiles render as a bulleted list; absence renders (not enumerated)', async () => {
    const withFiles = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const opWith = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(withFiles),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });
    await opWith({ ...baseInput(), conflictFiles: ['src/a.ts', 'src/b.ts'] });
    expect(firstInvocation(withFiles).prompt).toContain('- src/a.ts\n- src/b.ts');

    const without = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const opWithout = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(without),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });
    await opWithout(baseInput());
    expect(firstInvocation(without).prompt).toContain('(not enumerated)');
  });

  test('escalate path: needs-human with the summary as reason (alias normalized)', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(
      completed({ decision: 'escalated', summary: 'semantics cannot be reconciled' }),
    );
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'needs-human',
      reason: 'semantics cannot be reconciled',
    });
    // The escalation short-circuits BEFORE the acted verification: the
    // only validateRef is the step-b baseline capture — no extra call.
    const validateCalls = effects.calls.filter((call) => call.startsWith('validate:'));
    expect(validateCalls).toEqual([`validate:${headRefFor(44)}`]);
  });

  test('escalate without a summary gets the default reason', async () => {
    const driver = new FakeDriver(completed({ decision: 'escalate' }));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'needs-human',
      reason: 'conflict agent escalated; no summary given',
    });
  });

  test('prose output is a contract violation: failed, never ok, never needs-human', async () => {
    const driver = new FakeDriver(completed('I resolved everything fine'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('decision contract');
  });

  test('silent output (no structuredOutput) fails closed too', async () => {
    const driver = new FakeDriver({ ...stopped('complete'), model: MODEL_SPEC.model });
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('decision contract');
  });

  test('stopReason aborted → indeterminate (partial work may exist)', async () => {
    const driver = new FakeDriver(stopped('aborted'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'indeterminate',
      detail: 'conflict agent aborted before completing; partial work may exist in the worktree',
    });
  });

  test('stopReason budget → budget-exhausted', async () => {
    const driver = new FakeDriver(stopped('budget'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    await expect(op(baseInput())).resolves.toEqual({ status: 'budget-exhausted' });
  });

  test('stopReason error → failed, with the denials hint and errorClass=<x> named in the text', async () => {
    // §2.9: EVERY error verdict → 'failed'; the structured class is named
    // in the text for humans (a served-model mismatch arrives exactly this
    // way from the factory's wrapper — the one intended status change).
    const driver = new FakeDriver({
      ...stopped('error', [{ tool: 'run', reason: 'denied by policy' }]),
      error: 'requested glm-5.3, served glm-4-7',
      errorClass: 'served-model-mismatch',
    });
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('conflict agent failed');
    expect(failedError(result)).toContain('1 tool use(s) denied (see the session record');
    expect(failedError(result)).toContain('errorClass=served-model-mismatch');
    expect(failedError(result)).toContain('requested glm-5.3, served glm-4-7');

    // A classless error verdict (a v1 record) maps the same way, minus the
    // class text.
    const classlessOp = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(new FakeDriver(stopped('error'))),
      loadPrompt: fakeLoadPrompt,
    });
    const classless = await classlessOp(baseInput());
    expect(classless.status).toBe('failed');
    expect(failedError(classless)).not.toContain('errorClass=');
  });
});
