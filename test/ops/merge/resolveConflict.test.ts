// F4 slice 1 — tests for the conflict agent
// (src/ops/merge/resolveConflict.ts + prompts/conflict.default.md, ws-f
// scope item 4; UC §3 row 44).
//
// Pinned here, group by group:
//   1. THE SEAM (the repo's FIRST driver-consuming op): the whole flow runs
//      through fakes — a recording MergeEffects, a recording Driver, a fake
//      session creator, a fake prompt loader — ZERO real processes,
//      networks, or filesystems. The exact effect-call sequence is pinned:
//      fetch → prepare → session (inside fn) → remove-in-finally.
//   2. THE DECISION CONTRACT (parseMergeConflictDecision): the object form;
//      the 'escalated' alias normalized; unknown extra keys tolerated; a
//      JSON line embedded in narration; last-valid-line-wins; and the
//      fail-closed rejections — pure prose, an unknown decision word, a
//      non-string summary, empty string, number/null/array — each a
//      MergeConflictContractError whose message states the contract and
//      bounds the quoted prefix at 200 chars.
//   3. renderConflictPrompt: every placeholder replaced globally; unknown
//      placeholders left alone; unused vars ignored.
//   4. THE OP FLOW (module doc a–h): ok/needs-human/failed/
//      budget-exhausted/indeterminate mapping with stopReason FIRST, the
//      fail-closed contract violation (never ok, never needs-human), the
//      modelSpec runtime requirement, the invocation shape (allowlist
//      tools read/edit/run; sandbox level 'none' — the network-for-push
//      trap; wall-clock default and override), and the failure surfaces:
//      nonzero fetch, throwing worktreePrepare, a driver pre-dispatch
//      throw.
//   5. THE ACTED VERIFICATION: 'acted' is a self-report — the op captures
//      a PRE-dispatch baseline sha (step b) and, only after an acted
//      parse, re-fetches and re-validates: a moved sha → ok; an unchanged
//      sha or an unresolvable-after head → indeterminate; a fetch/validate
//      THROW in the verification → failed; an unresolvable BASELINE skips
//      the check (unverifiable is not unproven); an escalation
//      short-circuits BEFORE the verification (no extra validate call).
//   6. THE SHIPPED PROMPT (the real asset): the actual
//      prompts/conflict.default.md renders with no placeholder left, the
//      fetch-before-merge instruction, and the JSON-line contract — and
//      the op's DEFAULT loader reads that same file (the source-side half
//      of the dist-shipping regression guard).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import type {
  Driver,
  DriverStopReason,
  OpInvocation,
  WorkerResult,
} from '../../../src/driver/types.js';
import type { OpResult } from '../../../src/kernel/types.js';
import type { GhResult } from '../../../src/ops/review/gh.js';
import type { MergeEffects } from '../../../src/ops/merge/effects.js';
import { headRefFor } from '../../../src/ops/merge/effects.js';
import {
  DEFAULT_RESOLVE_WALL_CLOCK_MS,
  MergeConflictContractError,
  MergeConflictInputSchema,
  renderConflictPrompt,
  parseMergeConflictDecision,
} from '../../../src/ops/merge/resolveConflict.js';
import {
  makeResolveConflictOp,
  default as resolveConflictOp,
} from '../../../src/ops/merge/resolveConflict.js';
import type {
  ConflictResolutionValue,
  ResolveConflictInput,
} from '../../../src/ops/merge/resolveConflict.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OK: GhResult = { code: 0, stdout: '', stderr: '' };
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MODEL_SPEC = { model: 'resolver-model', provider: 'zai' };

/** A WorkerResult for a 'complete' run carrying `structuredOutput` (and,
 * when scripted, the driver-reported session handle). */
const completed = (structuredOutput: unknown, sessionId?: string): WorkerResult => ({
  ...(sessionId !== undefined ? { sessionId } : {}),
  structuredOutput,
  usage: ZERO_USAGE,
  denials: [],
  stopReason: 'complete',
});

/** A WorkerResult for a non-complete run (honest zero usage). */
const stopped = (
  stopReason: DriverStopReason,
  denials: WorkerResult['denials'] = [],
): WorkerResult => ({
  usage: ZERO_USAGE,
  denials,
  stopReason,
});

/** The dispatch-ready input (modelSpec bound). */
const baseInput = (): ResolveConflictInput => ({
  pr: 44,
  repoRoot: '/repo',
  headBranch: 'feat/topic',
  baseBranch: 'main',
  modelSpec: MODEL_SPEC,
});

/** The late-bound input (modelSpec omitted — the schema admits it; the op
 * must refuse to dispatch it). */
const lateBoundInput = (): ResolveConflictInput => ({
  pr: 44,
  repoRoot: '/repo',
  headBranch: 'feat/topic',
  baseBranch: 'main',
});

/**
 * THE FAKE EFFECTS — an in-memory MergeEffects, zero real git/gh. Every
 * call lands in `calls` (the exact-sequence log); the failure surfaces the
 * op can hit are scriptable (nonzero fetchRef, throwing worktreePrepare,
 * a throwing or unmoved verification). validateRef models a MOVABLE head:
 * the FIRST call answers `baselineSha` (the op's pre-dispatch capture),
 * later calls answer `postSha` (the post-acted verification) — postSha
 * defaults to a MOVED sha, i.e. the acted self-report is true unless a
 * test says otherwise.
 */
class FakeMergeEffects implements MergeEffects {
  readonly calls: string[] = [];
  fetchCode = 0;
  fetchStderr = '';
  fetchThrows: Error | null = null;
  /** Nonzero exit for a VERIFICATION fetch (any fetch after the first). */
  verifyFetchCode = 0;
  /** Thrown by a VERIFICATION fetch (any fetch after the first). */
  verifyFetchThrows: Error | null = null;
  prepareThrows: Error | null = null;
  validateThrows: Error | null = null;
  /** Thrown by a VERIFICATION validateRef (any validate after the first). */
  verifyValidateThrows: Error | null = null;
  /** The pre-dispatch head sha; null = unresolvable (verification skipped). */
  baselineSha: string | null = 'b'.repeat(40);
  /** The post-run head sha; null = unresolvable after. Default MOVED. */
  postSha: string | null = 'c'.repeat(40);
  private validateCalls = 0;
  private fetchCalls = 0;

  async validateRef(ref: string): Promise<{ ok: boolean; sha?: string }> {
    this.calls.push(`validate:${ref}`);
    this.validateCalls += 1;
    if (this.validateCalls === 1) {
      if (this.validateThrows !== null) throw this.validateThrows;
      return this.baselineSha === null ? { ok: false } : { ok: true, sha: this.baselineSha };
    }
    if (this.verifyValidateThrows !== null) throw this.verifyValidateThrows;
    return this.postSha === null ? { ok: false } : { ok: true, sha: this.postSha };
  }

  async fetchRef(ref: string): Promise<GhResult> {
    this.calls.push(`fetch:${ref}`);
    this.fetchCalls += 1;
    if (this.fetchCalls === 1) {
      if (this.fetchThrows !== null) throw this.fetchThrows;
      return { code: this.fetchCode, stdout: '', stderr: this.fetchStderr };
    }
    if (this.verifyFetchThrows !== null) throw this.verifyFetchThrows;
    return { code: this.verifyFetchCode, stdout: '', stderr: '' };
  }

  async worktreePrepare(pr: number, ref: string): Promise<{ path: string }> {
    this.calls.push(`prepare:${String(pr)}@${ref}`);
    if (this.prepareThrows !== null) throw this.prepareThrows;
    return { path: `/wt/pr-${String(pr)}` };
  }

  async worktreeRemove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
  }

  async mergePr(pr: number, opts: { method: 'merge' }): Promise<GhResult> {
    this.calls.push(`merge:${String(pr)}:${opts.method}`);
    return OK;
  }

  async retargetBase(pr: number, newBase: string): Promise<GhResult> {
    this.calls.push(`retarget:${String(pr)}:base=${newBase}`);
    return OK;
  }

  async pushRef(ref: string, fromPath: string): Promise<GhResult> {
    this.calls.push(`push:${ref}@${fromPath}`);
    return OK;
  }
}

/**
 * THE FAKE DRIVER — a recording Driver seam: every OpInvocation is kept for
 * the invocation-shape assertions; the scripted result is returned
 * verbatim, a scripted Error is thrown (the pre-dispatch-throw surface).
 */
class FakeDriver implements Driver {
  readonly invocations: OpInvocation[] = [];

  constructor(private readonly scripted: WorkerResult | Error) {}

  async run(invocation: OpInvocation): Promise<WorkerResult> {
    this.invocations.push(invocation);
    if (this.scripted instanceof Error) throw this.scripted;
    return this.scripted;
  }
}

/** The first recorded invocation, or a loud test failure. */
const firstInvocation = (driver: FakeDriver): OpInvocation => {
  const invocation = driver.invocations[0];
  if (invocation === undefined) throw new Error('the driver was never invoked');
  return invocation;
};

/** The error of a 'failed' result, or a loud test failure. */
const failedError = (result: OpResult<ConflictResolutionValue>): string => {
  if (result.status !== 'failed') {
    throw new Error(`expected status 'failed', got '${result.status}'`);
  }
  return result.error;
};

/**
 * THE FAKE SESSION STORE — records the workspace each session is created
 * in, hands out countable ids, and (optionally) mirrors each creation into
 * a shared log so the session's position in the effect sequence is
 * assertable.
 */
const fakeCreateSession = (
  log: string[] = [],
): {
  createSession: (workspace: string) => Promise<string>;
  workspaces: string[];
} => {
  const workspaces: string[] = [];
  let count = 0;
  const createSession = async (workspace: string): Promise<string> => {
    workspaces.push(workspace);
    count += 1;
    log.push(`session:${workspace}`);
    return `ses-${String(count)}`;
  };
  return { createSession, workspaces };
};

/** A minimal template carrying every placeholder the op renders (the real
 * file's contract, small), plus one placeholder the op never renders. */
const TEMPLATE = [
  'Resolve PR {{pr}}: merge {{baseRef}} into the worktree {{worktree}}.',
  'Conflict files:\n{{conflictFiles}}',
  'Push with: git push origin HEAD:{{headBranch}}',
  'Never push to {{protectedBranch}} or {{baseBranch}}.',
  'End with exactly {"decision":"acted|escalate","summary":"…"}',
  'Untouched: {{unknownPlaceholder}}',
].join('\n');

const fakeLoadPrompt = async (): Promise<string> => TEMPLATE;

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

// ---------------------------------------------------------------------------
// renderConflictPrompt
// ---------------------------------------------------------------------------

describe('renderConflictPrompt', () => {
  test('replaces every placeholder globally', () => {
    const rendered = renderConflictPrompt(
      [
        'pr {{pr}} pr {{pr}}',
        'head {{headBranch}} base {{baseBranch}} baseref {{baseRef}}',
        'files {{conflictFiles}} protected {{protectedBranch}} wt {{worktree}}',
      ].join('\n'),
      {
        pr: '44',
        headBranch: 'feat/topic',
        baseBranch: 'main',
        baseRef: 'origin/main',
        conflictFiles: '- src/a.ts',
        protectedBranch: 'trunk',
        worktree: '/wt/pr-44',
      },
    );
    expect(rendered).not.toContain('{{');
    expect(rendered).toContain('pr 44 pr 44');
    expect(rendered).toContain('head feat/topic base main baseref origin/main');
    expect(rendered).toContain('protected trunk wt /wt/pr-44');
  });

  test('leaves unknown placeholders alone and ignores unused vars', () => {
    expect(renderConflictPrompt('keep {{unknown}} as-is', { pr: '1', unused: 'x' })).toBe(
      'keep {{unknown}} as-is',
    );
  });
});

// ---------------------------------------------------------------------------
// The conservative git-refname gate (the prompt-interpolation boundary)
// ---------------------------------------------------------------------------

describe('the conservative git-refname gate', () => {
  /** Parse a schema input whose headBranch/baseBranch are overridden. */
  const parses = (over: Record<string, unknown>): boolean =>
    MergeConflictInputSchema.safeParse({ ...baseInput(), ...over }).success;

  test('project branch names parse; hostile and exotic ones fail closed', () => {
    // Ordinary project branch names.
    expect(parses({ headBranch: 'feature/x-2.0' })).toBe(true);
    expect(parses({ baseBranch: 'release/2.0_hotfix' })).toBe(true);
    // THE injection class: shell metacharacters in prompt-interpolated
    // commands.
    expect(parses({ headBranch: 'topic$(touch x)' })).toBe(false);
    expect(parses({ baseBranch: 'topic$(touch x)' })).toBe(false);
    // Git-refname hygiene: no leading dash, no '..' sequence, no spaces,
    // non-empty.
    expect(parses({ headBranch: '-leading' })).toBe(false);
    expect(parses({ baseBranch: 'a..b' })).toBe(false);
    expect(parses({ headBranch: 'a b' })).toBe(false);
    expect(parses({ headBranch: '' })).toBe(false);
    expect(parses({ baseBranch: '' })).toBe(false);
    // Bounded at 250 characters.
    expect(parses({ headBranch: `f/${'x'.repeat(250)}` })).toBe(false);
    expect(parses({ headBranch: `f/${'x'.repeat(240)}` })).toBe(true);
  });

  test('rejections name the conservative-refname contract', () => {
    const parsed = MergeConflictInputSchema.safeParse({
      ...baseInput(),
      headBranch: 'topic$(touch x)',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) => issue.message.includes('conservative git refname')),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

describe('resolveConflict op', () => {
  test('acted path: ok value, one prepare/remove pair around the fn, session + driver wired', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(
      completed({ decision: 'acted', summary: 'merged origin/main and pushed feat/topic' }),
    );
    const session = fakeCreateSession(effects.calls);
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: session.createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());

    expect(result).toEqual({
      status: 'ok',
      value: { pr: 44, decision: 'acted', summary: 'merged origin/main and pushed feat/topic' },
    });
    // The exact sequence: fetch + baseline validate (truth first), prepare,
    // the fn (session created INSIDE the worktree; after the acted parse
    // the verification re-fetches and re-validates), then
    // remove-in-finally — prepare and remove each exactly once, remove
    // after fn.
    expect(effects.calls).toEqual([
      `fetch:${headRefFor(44)}`,
      `validate:${headRefFor(44)}`,
      `prepare:44@${headRefFor(44)}`,
      'session:/wt/pr-44',
      `fetch:${headRefFor(44)}`,
      `validate:${headRefFor(44)}`,
      'remove:/wt/pr-44',
    ]);
    // The session was created with the worktree path as its workspace.
    expect(session.workspaces).toEqual(['/wt/pr-44']);
    expect(driver.invocations).toHaveLength(1);
    const invocation = firstInvocation(driver);
    // The driver received the created session id as its sessionRef.
    expect(invocation.sessionRef).toBe('ses-1');
    // The prompt carried the rendered vars and the acted contract.
    expect(invocation.prompt).toContain('feat/topic');
    expect(invocation.prompt).toContain('origin/main');
    expect(invocation.prompt).toContain('/wt/pr-44');
    expect(invocation.prompt).toContain('{"decision":"acted|escalate","summary":"…"}');
    // Tool surface: the write-capable allowlist, exactly.
    expect(invocation.toolPolicy).toEqual({ allow: ['read', 'edit', 'run'], mode: 'allowlist' });
    // THE SANDBOX TRAP (module doc): level 'none' is the ONLY correct
    // request — a workspace-write sandbox would block the network the
    // push needs, and the frozen SandboxPolicy has no network field to
    // request it with. There is no OS-level confinement on this seam: the
    // worktree cwd is a prompt-enforced convention, and the bounds that
    // remain are the allowlist above, the prompt's constraints, and the
    // wall-clock budget.
    expect(invocation.sandboxPolicy).toEqual({ level: 'none' });
    // Default wall clock (UC row 44's 20 minutes).
    expect(DEFAULT_RESOLVE_WALL_CLOCK_MS).toBe(1_200_000);
    expect(invocation.budget).toEqual({ wallClockMs: DEFAULT_RESOLVE_WALL_CLOCK_MS });
    expect(invocation.modelSpec).toEqual(MODEL_SPEC);
  });

  test('an input wallClockMs override reaches the invocation budget', async () => {
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    await op({ ...baseInput(), wallClockMs: 60_000 });

    expect(firstInvocation(driver).budget).toEqual({ wallClockMs: 60_000 });
  });

  test('conflictFiles render as a bulleted list; absence renders (not enumerated)', async () => {
    const withFiles = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const opWith = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      driver: withFiles,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });
    await opWith({ ...baseInput(), conflictFiles: ['src/a.ts', 'src/b.ts'] });
    expect(firstInvocation(withFiles).prompt).toContain('- src/a.ts\n- src/b.ts');

    const without = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const opWithout = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      driver: without,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
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
      driver,
      createSession: fakeCreateSession().createSession,
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
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
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
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('decision contract');
  });

  test('silent output (no structuredOutput) fails closed too', async () => {
    const driver = new FakeDriver(stopped('complete'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('decision contract');
  });

  test('stopReason aborted → indeterminate (partial work may exist)', async () => {
    const driver = new FakeDriver(stopped('aborted'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
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
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    await expect(op(baseInput())).resolves.toEqual({ status: 'budget-exhausted' });
  });

  test('stopReason error → failed, with the denials length as the hint', async () => {
    const driver = new FakeDriver(stopped('error', [{ tool: 'run', reason: 'denied by policy' }]));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('conflict agent failed');
    expect(failedError(result)).toContain('1 tool use(s) denied by policy');
  });

  test('a nonzero fetchRef fails closed before any worktree exists', async () => {
    const effects = new FakeMergeEffects();
    effects.fetchCode = 128;
    effects.fetchStderr = 'fatal: could not read from remote repository';
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('exit 128');
    // Fail closed: fetch only — no prepare, no remove, no dispatch.
    expect(effects.calls).toEqual([`fetch:${headRefFor(44)}`]);
    expect(driver.invocations).toHaveLength(0);
  });

  test('a throwing fetchRef fails too (a rejecting effect is an outcome, not a crash)', async () => {
    const effects = new FakeMergeEffects();
    effects.fetchThrows = new Error('git spawn lost');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('git spawn lost');
  });

  test('worktreePrepare throw → failed with the message; remove NOT called (nothing prepared)', async () => {
    const effects = new FakeMergeEffects();
    effects.prepareThrows = new Error('worktree add exploded');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('worktree add exploded');
    // withPreparedWorktree's contract, pinned from the op's side: the
    // prepare throw propagates untouched — fn never ran, so nothing was
    // prepared and there is nothing to remove.
    expect(effects.calls).toEqual([
      `fetch:${headRefFor(44)}`,
      `validate:${headRefFor(44)}`,
      `prepare:44@${headRefFor(44)}`,
    ]);
    expect(driver.invocations).toHaveLength(0);
  });

  test('modelSpec missing at dispatch → failed naming modelSpec; nothing runs', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(lateBoundInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('modelSpec');
    // Refused BEFORE any effect or dispatch — no truth fetch, no tree, no
    // driver call, no fabricated vendor default.
    expect(effects.calls).toEqual([]);
    expect(driver.invocations).toHaveLength(0);
  });

  test('a driver pre-dispatch throw is an op outcome: failed, not a crash', async () => {
    const driver = new FakeDriver(new Error('unknown model for provider'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('unknown model for provider');
  });

  test('the parse dep is the output gate (an injected parser can read what the real one would refuse)', async () => {
    const driver = new FakeDriver(completed('raw text the real parser would refuse'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
      parse: () => ({ decision: 'acted', summary: 'read by the injected parser' }),
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'ok',
      value: { pr: 44, decision: 'acted', summary: 'read by the injected parser' },
    });
  });

  test('the harnessConfig dep threads to the default driver construction (seam-agnostic dispatch)', async () => {
    // The load-bearing half is the TYPE-level threading into the
    // SubprocessDriver constructor (exactOptional conditional spread) —
    // deliberately unobservable through a fake driver. Behaviorally: a
    // dispatch with a harnessConfig present behaves identically; the LIVE
    // proof of a config's effect is F5's scripted-agent path (deps.driver).
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
      harnessConfig: defaultHarnessConfig,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'ok',
      value: { pr: 44, decision: 'acted', summary: 'ok' },
    });
    // And the default op builds with the config alone (nothing runs).
    expect(() => makeResolveConflictOp({ harnessConfig: defaultHarnessConfig })).not.toThrow();
  });

  test('the default op builds — deps default lazily, nothing runs at construction', () => {
    expect(() => makeResolveConflictOp()).not.toThrow();
    expect(typeof makeResolveConflictOp()).toBe('function');
    expect(typeof resolveConflictOp).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// The acted verification ('acted' is a self-report)
// ---------------------------------------------------------------------------

describe('the acted verification', () => {
  test('acted + the head MOVED → ok (the happy default)', async () => {
    const effects = new FakeMergeEffects(); // default: postSha ≠ baselineSha
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'ok',
      value: { pr: 44, decision: 'acted', summary: 'pushed' },
    });
  });

  test('acted + sha UNCHANGED → indeterminate with the did-not-move detail', async () => {
    const effects = new FakeMergeEffects();
    effects.postSha = effects.baselineSha; // the self-report lies
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('did not move');
      expect(result.detail).toContain(`baseline ${String(effects.baselineSha)}`);
      expect(result.detail).toContain(headRefFor(44));
    }
  });

  test('acted + head UNRESOLVABLE after the run → indeterminate', async () => {
    const effects = new FakeMergeEffects();
    effects.postSha = null;
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('did not move');
    }
  });

  test('a NONZERO verification fetch → indeterminate (unproven, not failed)', async () => {
    const effects = new FakeMergeEffects();
    effects.verifyFetchCode = 1;
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('did not move');
    }
  });

  test('a THROWING verification fetch → failed (totality)', async () => {
    const effects = new FakeMergeEffects();
    effects.verifyFetchThrows = new Error('verify fetch lost');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('verify fetch lost');
  });

  test('a THROWING verification validateRef → failed (totality)', async () => {
    const effects = new FakeMergeEffects();
    effects.verifyValidateThrows = new Error('verify validate lost');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('verify validate lost');
  });

  test('an UNRESOLVABLE baseline → indeterminate: unverifiable acted is never ok', async () => {
    const effects = new FakeMergeEffects();
    effects.baselineSha = null; // the head did not resolve pre-dispatch
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    // Without a baseline the self-report cannot be checked — never ok.
    await expect(op(baseInput())).resolves.toEqual({
      status: 'indeterminate',
      detail:
        'conflict agent reported acted but the head ref was unverifiable (pre-dispatch baseline unresolvable)',
    });
    // The check never ran: the only validate is the baseline attempt.
    const validateCalls = effects.calls.filter((call) => call.startsWith('validate:'));
    expect(validateCalls).toEqual([`validate:${headRefFor(44)}`]);
  });

  test('acted payloads carry the session handle when the driver reported one', async () => {
    const effects = new FakeMergeEffects();
    effects.postSha = effects.baselineSha; // the self-report lies
    const driver = new FakeDriver(
      completed({ decision: 'acted', summary: 'pushed' }, 'ses-driver-1'),
    );
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('did not move');
      expect(result.detail.endsWith('(session ses-driver-1)')).toBe(true);
    }

    // A failed payload shows the session id too.
    const failing = new FakeDriver(completed('I resolved everything fine', 'ses-driver-2'));
    const failedOp = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      driver: failing,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });
    const failedResult = await failedOp(baseInput());
    expect(failedResult.status).toBe('failed');
    expect(failedError(failedResult)).toContain('(session ses-driver-2)');
  });
});

// ---------------------------------------------------------------------------
// I11 forge fact carried as a test: the head push lands in refs/pull/<pr>/head
// ---------------------------------------------------------------------------

describe('I11 forge fact: a push to the head branch IS refs/pull/<pr>/head', () => {
  test('the acted verification observes the push THROUGH the pull ref, exclusively', async () => {
    // THE PREMISE (I11: forge facts carried as tests — the sibling pin is
    // executeMerges.test.ts's exact-sequence assertions, where every
    // baseline and revalidation call addresses refs/pull/<n>/head): the
    // agent pushes to the pr's head BRANCH, and the forge reflects that on
    // the read-only pull ref. The fake models exactly that — its movable
    // head lives ON refs/pull/<pr>/head — so the acted verification's
    // moved-sha reading is the pull ref's new sha.
    const effects = new FakeMergeEffects(); // default: postSha ≠ baselineSha
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
      loadPrompt: fakeLoadPrompt,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'ok',
      value: { pr: 44, decision: 'acted', summary: 'pushed' },
    });
    // The verification addressed the pr ONLY through the pull ref: every
    // fetch/validate in the log names refs/pull/44/head — the push and its
    // observation are the same ref (the fact the acted check depends on).
    const refCalls = effects.calls.filter(
      (call) => call.startsWith('fetch:') || call.startsWith('validate:'),
    );
    expect(refCalls.every((call) => call.endsWith(headRefFor(44)))).toBe(true);
    expect(refCalls).toContain(`validate:${headRefFor(44)}`);
  });
});

// ---------------------------------------------------------------------------
// The shipped prompt (the real asset — the dist-shipping guard's source half)
// ---------------------------------------------------------------------------

describe('the shipped conflict prompt', () => {
  const promptPath = fileURLToPath(
    new URL('../../../src/ops/merge/prompts/conflict.default.md', import.meta.url),
  );
  const vars = {
    pr: '44',
    headBranch: 'feat/topic',
    baseBranch: 'main',
    baseRef: 'origin/main',
    conflictFiles: '- src/a.ts',
    protectedBranch: 'main',
    worktree: '/wt/pr-44',
  };

  test('renders clean: no placeholder left, fetch-before-merge present, contract present', async () => {
    const real = await readFile(promptPath, 'utf8');
    expect(real.trim().length).toBeGreaterThan(0);

    const rendered = renderConflictPrompt(real, vars);
    // Every placeholder the op renders is consumed by the real template.
    expect(rendered).not.toContain('{{');
    // The base is refreshed BEFORE the merge — FETCH_HEAD, not a stale
    // origin/<base> ref.
    expect(rendered).toContain('git fetch origin main');
    expect(rendered).toContain('git merge FETCH_HEAD');
    // The output contract sentence, verbatim.
    expect(rendered).toContain('{"decision":"acted|escalate","summary":"…"}');
    // The protected-branch constraint is push/destination semantics — NOT
    // a merge-source ban (merging the base when it IS the protected
    // branch is required), and the merge source is FETCH_HEAD.
    // (Whitespace-collapsed so markdown line wrapping cannot split the
    // asserted phrases.)
    const collapsed = rendered.replace(/\s+/g, ' ');
    expect(collapsed).toContain('it is NEVER a push destination');
    expect(collapsed).toContain(
      'Using it as a merge SOURCE is correct and required when it is the base',
    );
    expect(collapsed).toContain('git merge FETCH_HEAD');
  });

  test('the DEFAULT loader reads the same file: the default op renders it verbatim', async () => {
    const real = await readFile(promptPath, 'utf8');
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    // NO loadPrompt dep — the op's default loader resolves the asset
    // beside the module and renders it with exactly these vars.
    const op = makeResolveConflictOp({
      effects,
      driver,
      createSession: fakeCreateSession().createSession,
    });

    const result = await op({ ...baseInput(), conflictFiles: ['src/a.ts'] });
    expect(result.status).toBe('ok');
    expect(firstInvocation(driver).prompt).toBe(renderConflictPrompt(real, vars));
  });
});
