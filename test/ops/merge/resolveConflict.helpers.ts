// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,push-scan,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// F4 slice 1 — tests for the conflict agent
// (src/ops/merge/resolveConflict.ts + prompts/conflict.default.md, ws-f
// scope item 4; UC §3 row 44; issue #1193 moved the publication push from
// the worker to the op, behind the pre-push denylist gate).
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
//      base-fetch network trap; the workspace binding; the decision-schema
//      outputSchema; NO sessionRef; wall-clock default and override), and
//      the failure surfaces: nonzero fetch, throwing worktreePrepare, a
//      driver pre-dispatch throw.
//   6. THE PUBLICATION GATE (issue #1193): an acted decision is a claim of
//      a LOCAL commit; the op locates the resolution commit on the
//      prepared worktree's branch, reads the baseline..resolved patch,
//      scans its added lines through the denylist seam, and pushes ONLY
//      on a clean scan — a hit or a scanner fault refuses (needs-human,
//      nothing pushed), an unscannable change refuses (failed), and the
//      publication push's exit code IS the verdict (nonzero → failed).
//      See resolveConflict.push-scan.test.ts.
//   7. THE SHIPPED PROMPT (the real asset): the actual
//      prompts/conflict.default.md renders with no placeholder left, the
//      fetch-before-merge instruction, the NO-PUSH publication contract
//      (the caller scans and pushes — issue #1193), and the JSON-line
//      contract — and the op's DEFAULT loader reads that same file (the
//      source-side half of the dist-shipping regression guard).
//
// Split layout (one file per subject; shared fixtures live here):
//   - resolveConflict.factory-resolution.test.ts: Factory resolution (ADR-0002 §2.5) — header group 2
//   - resolveConflict.parse-decision.test.ts: parseMergeConflictDecision — header group 3
//   - resolveConflict.render-prompt.test.ts: renderConflictPrompt — header group 4
//   - resolveConflict.refname-gate.test.ts: the conservative git-refname gate
//   - resolveConflict.op-outcomes.test.ts: 'resolveConflict op' outcome mapping + invocation shape — header group 5 (first half)
//   - resolveConflict.op-failures.test.ts: 'resolveConflict op' failure surfaces — header group 5 (second half)
//   - resolveConflict.push-scan.test.ts: the publication gate — header group 6
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
import type { DiffSecretScanner, ScanComponentInput } from '../../../src/ops/dev/denylist.js';
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
 * op can hit are scriptable (nonzero fetchRef, throwing worktreePrepare).
 * validateRef models the two-shape reality of the publication gate (issue
 * #1193): the FIRST call answers `baselineSha` (the op's pre-dispatch
 * capture on the pull ref), later calls answer `resolutionSha` (the
 * gate's worktree-branch read) — resolutionSha defaults to a MOVED sha,
 * i.e. the agent's commit claim is true unless a test says otherwise.
 * diffPatch defaults to an EMPTY clean patch (a scan with nothing to
 * scan) unless a test scripts a patch body.
 */
export class FakeMergeEffects implements MergeEffects {
  readonly calls: string[] = [];
  /** pr → forge base ref (what readBaseRef answers); absent → 'main'. */
  readonly baseRefs = new Map<number, string>();
  fetchCode = 0;
  fetchStderr = '';
  fetchThrows: Error | null = null;
  prepareThrows: Error | null = null;
  validateThrows: Error | null = null;
  /** Thrown by a GATE validateRef (any validate after the first). */
  gateValidateThrows: Error | null = null;
  /** The pre-dispatch head sha; null = unresolvable (gate rung 1). */
  baselineSha: string | null = 'b'.repeat(40);
  /** The worktree-branch sha the gate reads; null = unresolvable (rung 2). */
  resolutionSha: string | null = 'c'.repeat(40);
  /** The diffPatch verdict: nonzero = the change is unscannable (rung 3). */
  diffCode = 0;
  diffStderr = '';
  diffThrows: Error | null = null;
  /** The unified patch body diffPatch answers with (default: empty —
   * nothing changed, nothing to scan). */
  diffPatchText = '';
  /** Nonzero exit for the publication push (gate rung 6). */
  pushCode = 0;
  pushStderr = '';
  pushThrows: Error | null = null;
  /** The topology the gate reads on the resolution commit (rung 3):
   * null (the default) models a VALID single commit whose parent is the
   * baseline; an explicit array is returned verbatim (merge commits list
   * two parents, a wrong-parent commit the wrong sha); `false` models an
   * unreadable topology. */
  resolutionParents: string[] | null | false = null;
  private validateCalls = 0;
  private fetchCalls = 0;

  async validateRef(ref: string): Promise<{ ok: boolean; sha?: string }> {
    this.calls.push(`validate:${ref}`);
    this.validateCalls += 1;
    if (this.validateCalls === 1) {
      if (this.validateThrows !== null) throw this.validateThrows;
      return this.baselineSha === null ? { ok: false } : { ok: true, sha: this.baselineSha };
    }
    if (this.gateValidateThrows !== null) throw this.gateValidateThrows;
    return this.resolutionSha === null ? { ok: false } : { ok: true, sha: this.resolutionSha };
  }

  async fetchRef(ref: string): Promise<GhResult> {
    this.calls.push(`fetch:${ref}`);
    this.fetchCalls += 1;
    if (this.fetchCalls === 1) {
      if (this.fetchThrows !== null) throw this.fetchThrows;
      return { code: this.fetchCode, stdout: '', stderr: this.fetchStderr };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  /** The forge base tip the publication gate verifies a merge parent
   * against (issue #1193, shape B); null models a forge answer with no
   * usable OID (the gate must refuse). */
  baseTipSha: string | null = 'd'.repeat(40);
  /** isAncestor's exit code for the gate's ancestry read; 0 = the second
   * parent IS public base history, 1 = not. */
  ancestorCode: 0 | 1 = 1;

  async readBaseRef(
    pr: number,
  ): Promise<{ ok: boolean; baseRefName?: string; baseTipSha?: string }> {
    // The resolve op's gate reads the base ref on MERGE-shaped resolutions
    // (shape B) to verify the second parent is public base history;
    // executeMerges reads it before every merge action. Absent an explicit
    // entry it answers the trunk (a stacked scenario seeds baseRefs).
    this.calls.push(`readBase:${String(pr)}`);
    const baseTip = this.baseTipSha === null ? {} : { baseTipSha: this.baseTipSha };
    return { ok: true, baseRefName: this.baseRefs.get(pr) ?? 'main', ...baseTip };
  }

  async isAncestor(ancestor: string, descendant: string): Promise<GhResult> {
    this.calls.push(`ancestor:${ancestor}->${descendant}`);
    return { code: this.ancestorCode, stdout: '', stderr: '' };
  }

  /** The resolution commit's message the gate scans (rung 5); null
   * models an unreadable message (the gate must fail closed). */
  commitMessage: string | null = 'fix: resolve conflict with main\n';
  /** The gate's message scan bound test hook: when true, the fake
   * answers an over-bound message (the gate must fail closed). */
  overlongMessage = false;
  /** Whether the forge base tip is locally present for the ancestry read
   * (rung 3 shape B); true models a tip the repo has not fetched. */
  objectMissing = false;
  /** Nonzero exit for the gate's base fetch (rung 3 shape B). */
  fetchBaseCode = 0;

  async readCommitMessage(sha: string): Promise<GhResult> {
    this.calls.push(`message:${sha}`);
    if (this.commitMessage === null) return { code: 1, stdout: '', stderr: 'fatal: bad object' };
    return {
      code: 0,
      stdout: this.overlongMessage ? 'x'.repeat(100_001) : this.commitMessage,
      stderr: '',
    };
  }

  async objectExists(sha: string): Promise<GhResult> {
    this.calls.push(`objectExists:${sha}`);
    return { code: this.objectMissing ? 128 : 0, stdout: '', stderr: '' };
  }

  async fetchBaseBranch(branch: string): Promise<GhResult> {
    this.calls.push(`fetchBase:${branch}`);
    return { code: this.fetchBaseCode, stdout: '', stderr: '' };
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
    if (this.pushThrows !== null) throw this.pushThrows;
    return { code: this.pushCode, stdout: '', stderr: this.pushStderr };
  }

  async diffPatch(from: string, to: string): Promise<GhResult> {
    this.calls.push(`diff:${from}..${to}`);
    if (this.diffThrows !== null) throw this.diffThrows;
    return { code: this.diffCode, stdout: this.diffPatchText, stderr: this.diffStderr };
  }

  async commitParents(sha: string): Promise<{ ok: boolean; parents?: string[] }> {
    this.calls.push(`parents:${sha}`);
    if (this.resolutionParents === false) return { ok: false };
    return {
      ok: true,
      parents: this.resolutionParents ?? [this.baselineSha ?? 'b'.repeat(40)],
    };
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

// ---------------------------------------------------------------------------
// Stub scanners (the publication gate's denylist seam, issue #1193)
// ---------------------------------------------------------------------------

/** A scanner that always clears — the stub for tests that only need the
 * gate to PASS the scan rung. */
export const scanClean: DiffSecretScanner = async () => [];

/** A scanner that flags EVERY component with one rule (the scan-hit
 * refusal stub); the rule id and flagged component names are the
 * evidence the op must surface. */
export const scanHits =
  (ruleId = 'denylisted-token'): DiffSecretScanner =>
  async (components) =>
    components.map(({ component }) => ({ component, hits: [{ ruleId, lines: [1] }] }));

/** A scanner that always THROWS (the scanner-fault refusal stub). */
export const scanFault =
  (message = 'scanner exploded'): DiffSecretScanner =>
  async () => {
    throw new Error(message);
  };

/** A recording wrapper: delegates to `inner`, keeps the LAST component set
 * it saw (the scan-before-push ordering and scan-input assertions). */
export const recordingScan = (
  inner: DiffSecretScanner,
): {
  scanner: DiffSecretScanner;
  lastComponents: () => readonly ScanComponentInput[] | undefined;
} => {
  let seen: readonly ScanComponentInput[] | undefined;
  const scanner: DiffSecretScanner = async (components) => {
    seen = components;
    return inner(components);
  };
  return { scanner, lastComponents: () => seen };
};

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
  'Commit the resolution; do NOT push — the caller scans and pushes {{headBranch}}.',
  'Never push to {{protectedBranch}} or {{baseBranch}}.',
  'End with exactly {"decision":"acted|escalate","summary":"…"}',
  'Untouched: {{unknownPlaceholder}}',
].join('\n');

export const fakeLoadPrompt = async (): Promise<string> => TEMPLATE;
