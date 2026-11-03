// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// F4 slice 1 — tests for the conflict agent
// (src/ops/merge/resolveConflict.ts + prompts/conflict.default.md, ws-f
// scope item 4; UC §3 row 44).
//
// Pinned here, group by group:
//   1. THE SEAM (the repo's FIRST driver-consuming op): the whole flow runs
//      through fakes — a recording MergeEffects, a recording Driver behind
//      a recording DriverFactory, a fake prompt loader — ZERO real
//      processes, networks, or filesystems. The exact effect-call sequence
//      is pinned: fetch → prepare → remove-in-finally (no pre-created
//      session — the worktree rides the invocation as its workspace
//      binding).
//   2. FACTORY RESOLUTION (ADR-0002 §2.5): the op resolves ONE request —
//      role 'conflict-resolver', the input's modelSpec, the harness dep —
//      through deps.drivers (default: createDriverFactory), dispatches
//      through the RESOLVED driver, and puts the factory's NORMALISED
//      modelSpec on the invocation (never the input's). The served-model
//      wrapper is NOT tested here: the fake factory's driver is what the
//      op dispatches, and the wrapper is the real factory's concern
//      (test/driver/factory.wrappers.test.ts owns it).
//   3. THE DECISION CONTRACT (parseMergeConflictDecision): the object form;
//      the 'escalated' alias normalized; unknown extra keys tolerated; a
//      JSON line embedded in narration; last-valid-line-wins; and the
//      fail-closed rejections — pure prose, an unknown decision word, a
//      non-string summary, empty string, number/null/array — each a
//      MergeConflictContractError whose message states the contract and
//      bounds the quoted prefix at 200 chars.
//   4. renderConflictPrompt: every placeholder replaced globally; unknown
//      placeholders left alone; unused vars ignored.
//   5. THE OP FLOW (module doc a–h): ok/needs-human/failed/
//      budget-exhausted/indeterminate mapping with stopReason FIRST, the
//      §2.9 throw rows (a factory-resolve or driver-run throw under an
//      aborted governed signal → indeterminate; config/auth/unclassified →
//      needs-human), an `error` verdict → failed with errorClass=<x> named
//      in the text, the fail-closed contract violation (never ok, never
//      needs-human), the modelSpec runtime requirement, the invocation
//      shape (allowlist tools read/edit/bash; sandbox level 'none' — the
//      network-for-push trap; the workspace binding; the decision-schema
//      outputSchema; NO sessionRef; wall-clock default and override), and
//      the failure surfaces: nonzero fetch, throwing worktreePrepare, a
//      driver pre-dispatch throw.
//   6. THE ACTED VERIFICATION: 'acted' is a self-report — the op captures
//      a PRE-dispatch baseline sha (step b) and, only after an acted
//      parse, re-fetches and re-validates: a moved sha → ok; an unchanged
//      sha or an unresolvable-after head → indeterminate; a fetch/validate
//      THROW in the verification → failed; an unresolvable BASELINE skips
//      the check (unverifiable is not unproven); an escalation
//      short-circuits BEFORE the verification (no extra validate call).
//   7. THE SHIPPED PROMPT (the real asset): the actual
//      prompts/conflict.default.md renders with no placeholder left, the
//      fetch-before-merge instruction, the push-then-propagation-wait
//      instruction (bounded refs/pull/<pr>/head poll before acting — the
//      F5 drill's live finding), and the JSON-line contract — and
//      the op's DEFAULT loader reads that same file (the source-side half
//      of the dist-shipping regression guard).
//
// Split layout (one file per subject; shared fixtures live here):
//   - resolveConflict.factory-resolution.test.ts: Factory resolution (ADR-0002 §2.5) — header group 2
//   - resolveConflict.parse-decision.test.ts: parseMergeConflictDecision — header group 3
//   - resolveConflict.render-prompt.test.ts: renderConflictPrompt — header group 4
//   - resolveConflict.refname-gate.test.ts: the conservative git-refname gate
//   - resolveConflict.op-outcomes.test.ts: 'resolveConflict op' outcome mapping + invocation shape — header group 5 (first half)
//   - resolveConflict.op-failures.test.ts: 'resolveConflict op' failure surfaces — header group 5 (second half)
//   - resolveConflict.acted-verification.test.ts: the acted verification — header group 6
//   - resolveConflict.forge-fact.test.ts: I11 forge fact (refs/pull/<pr>/head)
//   - resolveConflict.shipped-prompt.test.ts: the shipped conflict prompt — header group 7
//   - resolveConflict.invocation-correlation.test.ts: forward governed invocation correlation (M5b5)
import type { DriverFactory, DriverRequest, ResolvedDriver } from '../../../src/driver/factory.js';
import type {
  Driver,
  DriverStopReason,
  OpInvocation,
  WorkerResult,
} from '../../../src/driver/types.js';
import type { OpResult } from '../../../src/kernel/types.js';
import type { GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { MergeEffects } from '../../../src/adapters/forge-github/mergeEffects.js';
import type {
  ConflictResolutionValue,
  ResolveConflictInput,
} from '../../../src/ops/merge/resolveConflict.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const OK: GhResult = { code: 0, stdout: '', stderr: '' };
export const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const MODEL_SPEC = { model: 'resolver-model', provider: 'zai' };

/** A WorkerResult for a 'complete' run carrying `structuredOutput` (and,
 * when scripted, the driver-reported session handle). */
export const completed = (structuredOutput: unknown, sessionId?: string): WorkerResult => ({
  model: MODEL_SPEC.model,
  ...(sessionId !== undefined ? { sessionId } : {}),
  structuredOutput,
  usage: ZERO_USAGE,
  denials: [],
  stopReason: 'complete',
});

/** A WorkerResult for a non-complete run (honest zero usage). */
export const stopped = (
  stopReason: DriverStopReason,
  denials: WorkerResult['denials'] = [],
): WorkerResult => ({
  usage: ZERO_USAGE,
  denials,
  stopReason,
});

/** The dispatch-ready input (modelSpec bound). */
export const baseInput = (): ResolveConflictInput => ({
  pr: 44,
  repoRoot: '/repo',
  headBranch: 'feat/topic',
  baseBranch: 'main',
  modelSpec: MODEL_SPEC,
});

/** The late-bound input (modelSpec omitted — the schema admits it; the op
 * must refuse to dispatch it). */
export const lateBoundInput = (): ResolveConflictInput => ({
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
export class FakeMergeEffects implements MergeEffects {
  readonly calls: string[] = [];
  /** pr → forge base ref (what readBaseRef answers); absent → 'main'. */
  readonly baseRefs = new Map<number, string>();
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

  async readBaseRef(pr: number): Promise<{ ok: boolean; baseRefName?: string }> {
    // The resolve op never reads a base ref — only executeMerges does. The
    // method exists to satisfy the seam; absent an explicit entry it answers
    // the trunk (a stacked scenario seeds baseRefs).
    this.calls.push(`readBase:${String(pr)}`);
    return { ok: true, baseRefName: this.baseRefs.get(pr) ?? 'main' };
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
export class FakeDriver implements Driver {
  readonly invocations: OpInvocation[] = [];

  constructor(private readonly scripted: WorkerResult | Error) {}

  async run(invocation: OpInvocation): Promise<WorkerResult> {
    this.invocations.push(invocation);
    if (this.scripted instanceof Error) throw this.scripted;
    return this.scripted;
  }
}

/**
 * THE FAKE FACTORY — a recording DriverFactory seam: every DriverRequest
 * is kept for the resolution assertions; resolve hands back the scripted
 * driver on the 'ai-sdk' lane with the request's modelSpec VERBATIM (the
 * real factory's normalisation is its own concern — factory tests own it).
 */
export class FakeDriverFactory implements DriverFactory {
  readonly requests: DriverRequest[] = [];

  constructor(private readonly driver: Driver) {}

  resolve(request: DriverRequest): ResolvedDriver {
    this.requests.push(request);
    return { driver: this.driver, lane: 'ai-sdk', modelSpec: request.modelSpec };
  }
}

/** The factory for `driver`, or a loud test failure if it never resolved. */
export const factoryOf = (driver: Driver): FakeDriverFactory => new FakeDriverFactory(driver);

/** The first recorded factory request, or a loud test failure. */
export const firstRequest = (factory: FakeDriverFactory): DriverRequest => {
  const request = factory.requests[0];
  if (request === undefined) throw new Error('the factory was never asked to resolve');
  return request;
};

/** The first recorded invocation, or a loud test failure. */
export const firstInvocation = (driver: FakeDriver): OpInvocation => {
  const invocation = driver.invocations[0];
  if (invocation === undefined) throw new Error('the driver was never invoked');
  return invocation;
};

/** The error of a 'failed' result, or a loud test failure. */
export const failedError = (result: OpResult<ConflictResolutionValue>): string => {
  if (result.status !== 'failed') {
    throw new Error(`expected status 'failed', got '${result.status}'`);
  }
  return result.error;
};

/** A minimal template carrying every placeholder the op renders (the real
 * file's contract, small), plus one placeholder the op never renders. */
export const TEMPLATE = [
  'Resolve PR {{pr}}: merge {{baseRef}} into the worktree {{worktree}}.',
  'Conflict files:\n{{conflictFiles}}',
  'Push with: git push origin HEAD:{{headBranch}}',
  'Never push to {{protectedBranch}} or {{baseBranch}}.',
  'End with exactly {"decision":"acted|escalate","summary":"…"}',
  'Untouched: {{unknownPlaceholder}}',
].join('\n');

export const fakeLoadPrompt = async (): Promise<string> => TEMPLATE;
