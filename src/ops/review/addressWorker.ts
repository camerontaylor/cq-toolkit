import {
  recordAddressTerminalAttempt,
  releaseAddressTerminalAttempt,
  checkpointAddressTerminalWorker,
  addressTerminalCandidate,
  deferAddressTerminalAttempt,
} from './internal/addressRunLifecycle.js';
import { randomUUID } from 'node:crypto';
import { GIT_HARDEN } from '../../shared/gitHarden.js';
import {
  assertAddressDependenciesIsolated,
  assertAddressDependencyMetadata,
  snapshotAddressDependencies,
} from './internal/addressDependencies.js';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { DriverFactory } from '../../driver/factory.js';
import type { ModelSpec, Usage, WorkerResult } from '../../driver/types.js';
import type { ObservationWriter } from '../../kernel/observation.js';
import { toOutputSchema } from '../../driver/common/structured.js';
import { defaultHarnessConfig } from '../../harness/config.js';
import { correlationInvocation } from '../../driver/correlationInvocation.js';
import { currentJobContext } from '../../kernel/governor.js';
import { checkoutWriterContext } from '../../shared/checkoutWriterContext.js';
import type { GhFn } from '../../adapters/forge-github/gh.js';
import type { EffectiveCqPolicy } from '../analyze/cqConfigDefaults.js';
import {
  makeCheckRunner,
  subprocessRunCheck,
  type FailureSet,
  type RawCheckOutput,
} from '../gates/checkRunner.js';
import { classifyStagePaths } from '../sweep/stagePaths.js';
import {
  normalizeFailurePaths,
  relatedCheckCommand,
  staticRelatedCheckCommand,
  relatedFilesRelativeToCheck,
} from '../sweep/tasks.js';
import { startFixerDeadline, type FixerDeadline } from '../sweep/internal/fixerBudget.js';
import { finishAttempt, type FinishAttemptStop } from '../fix/attemptRecord.js';
import type { AttemptFinishedJournalEvent } from '../../kernel/types.js';
import { errorClassOf } from '../../driver/errors.js';
import {
  composeScanners,
  makeGitleaksDefaultsScanner,
  makeRepoDiffScanner,
  type DiffSecretScanner,
} from '../dev/denylist.js';
import { makeSubprocessDevEffects } from '../dev/effects.js';
import { zList } from '../dev/internal/workState.js';
import { validateFix, type ValidationVerdict } from '../fix/validate.js';
import {
  createEscalationState,
  nextEscalation,
  recordFixedFailures,
  type EscalationState,
} from '../fix/escalation.js';
import type { Finding } from './findings.js';
import {
  pinAddressFailure,
  addressFailureFeedback,
  type AddressFailedAttempt,
} from './internal/addressEvidence.js';
import { formatCqTrailers } from '../../shared/cqTrailers.js';
import type { FailedAttemptGate } from '../sweep/taskLoop.js';

/**
 * ADR-0008 T14: the review lane's fixer slot in the `<package>/<fixer>` unit
 * identity (the production order runFix/registry use). The address worker is
 * the fixer a review finding is dispatched to, so its slot is `address`.
 */
const ADDRESS_FIXER = 'address';

const OutcomeSchema = z
  .object({
    disposition: z.enum(['fixed', 'rejected', 'deferred']),
    reason: z.string().min(1),
    evidence: z.array(z.object({ path: z.string(), line: z.number().int().positive() }).strict()),
  })
  .strict();
const ClosureSchema = z.object({ closed: z.boolean(), reason: z.string().min(1) }).strict();
export interface AddressPrecondition {
  kind: 'deterministic' | 'transient';
  scope: 'leg' | 'finding';
  stage: 'dependencies' | 'check' | 'setup' | 'reviewer';
  reason: string;
  finding?: string;
  cleanupError?: string;
  checkDiagnostics?: {
    exitCode: number | null;
    signal: string | null;
    stdoutTail: string;
    stderrTail: string;
  };
}
export interface AddressAttempt {
  finding: string;
  tier: 'worker' | 'rescue' | 'reviewer';
  attempt: number;
  invocation: 'edit' | 'feedback' | 'closure';
  reason: string;
  model: ModelSpec;
  observedHead: string;
  wallMs: number;
  usage?: Usage;
  costUSD?: number;
  validation?: ValidationVerdict[];
  failedAttempt?: AddressFailedAttempt;
}
export interface AddressFix {
  finding: Finding;
  observedHead: string;
  /** Exact parent whose candidate tree passed the worker gates. */
  validatedParent?: string;
  commit?: string;
  evidence?: Array<{ path: string; line: number }>;
  reason: string;
  /**
   * ADR-0008 T19: present ONLY on the operational failure path (failed()).
   * That path reuses the `deferred` status because the finding is unresolved,
   * but it is not an adjudication: the composition must never promote it into
   * a durable disposition. A deliberate `deferred` returned by a worker has
   * no `failure`, even when it omits the optional evidence array.
   */
  failure?: { reason: string };
  validation: ValidationVerdict[];
  failedAttempts?: AddressFailedAttempt[];
}
export interface AddressWorker {
  fix(finding: Finding, round: number): Promise<AddressFix>;
  escalation(): EscalationState;
  /** Engine-observed prerequisite failure; the enclosing leg must stop paid work. */
  preconditionFailure?(): string | undefined;
  preconditions?(): readonly AddressPrecondition[];
  /** Capture and admit against a verified head without crossing an engine commit. */
  withVerifiedHead?<T>(action: (head: string) => Promise<T>): Promise<T>;
  /**
   * ADR-0008 T14: attempt observations that never reached the writer (a
   * finishAttempt schema refusal, or an append the writer refused without a
   * recorded `failure`). Evidence only: the composition folds them into
   * observation.status 'indeterminate'; they never change a verdict.
   */
  observationFailures?(): readonly string[];
  /**
   * ADR-0008 T14: settle every fixer invocation still in flight, bounded by
   * `observationDrainMs`. A composition closes its observation stream before
   * it persists the report (T31), and `runPlan` can return with an op body
   * still running (the ladder's kill rung DETACHES an invocation that ignored
   * the abort), so the composition drains here first: an attempt-finished
   * append then lands before the close instead of being refused by it.
   */
  settleObservations?(): Promise<void>;
}
export interface AddressWorkerDeps {
  git: GhFn;
  drivers: DriverFactory;
  repoRoot: string;
  /** Installed caller checkout; reused only when dependency metadata matches the worker tree. */
  dependencyRoot?: string;
  /** Explicit prepared roots take priority over checkout-local dependencies. */
  preferDependencyRoot?: boolean;
  journalDir: string;
  policy: EffectiveCqPolicy;
  attempts: AddressAttempt[];
  /** Run-wide history survives rejected/cancelled jobs, independently of their result. */
  failedAttempts?: AddressFailedAttempt[];
  runPrefix?: string;
  remainingTokens(): number;
  remainingWallMs(): number;
  account(result: WorkerResult): void;
  scanner?: DiffSecretScanner;
  /** Exact untracked bookkeeping paths owned by the enclosing addressing operation. */
  isBookkeepingPath?(path: string): Promise<boolean>;
  /** Snapshot and classify under the enclosing engine's bookkeeping write fence. */
  inspectUntracked?(read: () => Promise<string[]>): Promise<{ paths: string[]; unknown: string[] }>;
  /** Restore engine-owned historical metadata before initial unknown-path inspection. */
  prepareBookkeeping?(): Promise<void>;
  parentSignal?: AbortSignal;
  /** Private engine association; structurally supplied values never authenticate. */
  terminalBinding?: object;
  /**
   * ADR-0008 T31: the composition observation writer, injected through the
   * RUNTIME deps only — never serialized into any dispatch input. Attempt
   * events (T14) and write observations (T18) append through it; a write
   * failure never changes this worker's verdict.
   */
  observationWriter?: ObservationWriter;
  /** The composition stream's runId: every observation event carries it. */
  observationRunId?: string;
  /**
   * The planned dispatch unit identity for this worker's observations, or
   * null on run-scoped events — never a fabricated kernel jobId.
   */
  observationUnitId?: string | null;
  /**
   * Upper bound on `settleObservations()`. A detached invocation cannot be
   * killed in-process, so the drain reports it as observation evidence
   * (indeterminate) rather than hanging the report behind a hung driver.
   */
  observationDrainMs?: number;
}

/** Only engine observations may stop retries or invalidate the shared worker tree. */
class AddressRefusal extends Error {
  constructor(
    message: string,
    readonly fatal = false,
    /** The failed-attempt gate this typed refusal settles. Absent means the
     * attempt had no semantic gate of its own (the validator's failing gate
     * or a plain `none` describes it). */
    readonly gate?: FailedAttemptGate,
  ) {
    super(message);
  }
}
class CheckFailure extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly scoped: boolean,
    readonly diagnostics?: AddressPrecondition['checkDiagnostics'],
  ) {
    super(message);
  }
}
class PreconditionRefusal extends AddressRefusal {
  constructor(readonly precondition: AddressPrecondition) {
    super(
      `${precondition.kind === 'transient' ? 'transient baseline' : 'baseline precondition'} failed: ${precondition.reason}`,
      precondition.kind === 'deterministic' && precondition.scope === 'leg',
    );
  }
}
class BaselineCleanupError extends Error {
  constructor(
    readonly original: unknown,
    readonly cleanup: unknown,
  ) {
    super(String(original));
  }
}
const transientSystemFailure = (error: unknown) =>
  ['ENOMEM', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOSPC', 'EIO', 'ETIMEDOUT'].includes(
    String((error as NodeJS.ErrnoException | null)?.code),
  );
const findingScoped = (check: EffectiveCqPolicy['checks'][number]) =>
  check.addressOnly === true || check.adapter === 'test-narrow';

/** One scan component: `diagnostic` marks text derived from a check diagnostic. */
type ScanContent = { text: string; path?: string; diagnostic?: boolean };

/**
 * One scan component per distinct check-diagnostic message with an
 * attributable file: the unescaped message under its normalized
 * repository-relative path, so a path-scoped denylist rule fires on content
 * a whole-request (`worker-request.json`) component would miss. Paths are
 * canonical checkout-relative names already normalized by the check runner.
 */
function diagnosticSources(checks: readonly FailureSet[]): ScanContent[] {
  const rows: ScanContent[] = [];
  for (const set of checks) {
    for (const failure of set.failures) {
      if (failure.file === null) continue;
      const path = failure.file.split(/[\\/]+/).join('/');
      if (rows.some((row) => row.path === path && row.text === failure.message)) continue;
      rows.push({ text: failure.message, path, diagnostic: true });
    }
  }
  return rows;
}

/**
 * Unescaped diagnostic messages that carry no attributable file: they are
 * still scanned (under the whole-request label) but the caller must refuse
 * the upload — provenance cannot be established for embedded source text.
 */
function diagnosticMessages(checks: readonly FailureSet[]): string[] {
  const messages: string[] = [];
  for (const set of checks) {
    for (const failure of set.failures) {
      if (failure.file === null && !messages.includes(failure.message))
        messages.push(failure.message);
    }
  }
  return messages;
}

/** One shared worker tree; only this engine may stage/commit, under a serial mutex. */
export function makeAddressWorker(deps: AddressWorkerDeps): AddressWorker {
  const { policy } = deps;
  let state = createEscalationState();
  const root = resolve(deps.repoRoot);
  const runPrefix = deps.runPrefix ?? `cq-address/${randomUUID()}`;
  const failures = deps.failedAttempts ?? [];
  const ordinals = new Map<string, number>();
  // ADR-0008 T14: the per-unit attempt ordinal carried on `attempt-finished`,
  // keyed by the dispatched package (the envelope's unit identity) and run-wide
  // across rounds. It is DISTINCT from the escalation job retry ordinal
  // (`next.decision.attempt`, which stays on the AddressAttempt row) and from
  // the failed-attempt pin ordinal (`dispatch.ordinal`); only fixer dispatches
  // are counted here. A counter (rather than the AddressAttempt row count) is
  // required because a dispatch refused before its row is pushed must not reuse
  // the previous attempt's ordinal.
  const attemptOrdinals = new Map<string, number>();
  // ADR-0008 T14: observation failures that never reached the writer (a
  // finishAttempt strict-schema refusal, or an append the writer refused
  // without recording its own `failure`). Evidence only — never a verdict;
  // observationFailures() hands them to the composition, which folds them
  // into observation.status 'indeterminate'.
  const observationFailures: string[] = [];
  // Track whole fix bodies, including the gaps between fixer dispatches.
  const inFlightFixes = new Map<Promise<void>, string>();
  let settled = false;
  const observationDrainMs = deps.observationDrainMs ?? 5_000;
  // ADR-0008 T14 emitter (mirrors T13): the event is BUILT inside the try so a
  // schema refusal becomes evidence instead of escaping the invocation, and an
  // append failure is read back from the writer's own `failure` unless the
  // writer did not record one. Never throws, so it cannot mask a verdict.
  const emitAttempt = async (build: () => AttemptFinishedJournalEvent): Promise<void> => {
    const writer = deps.observationWriter;
    if (writer === undefined) return;
    let event: AttemptFinishedJournalEvent;
    try {
      event = build();
    } catch (error) {
      observationFailures.push(`attempt observation failed: ${String(error)}`);
      return;
    }
    try {
      await writer.append(event);
    } catch (error) {
      if (writer.failure === null)
        observationFailures.push(`attempt observation failed: ${String(error)}`);
    }
  };
  /** The dispatched package owning a repository-relative file (the unit identity). */
  const packageOf = (file: string): string =>
    [...policy.packages]
      .sort((a, b) => b.path.length - a.path.length)
      .find((pkg) => {
        const path = relative(resolve(root, pkg.path), resolve(root, file));
        return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
      })?.name ?? policy.packages[0]!.name;
  const active = new Set<string>();
  const verifiedHeads = new Set<string>();
  let initialization: Promise<void> | undefined;
  let fatal: string | undefined;
  let preconditionFailure: string | undefined;
  const unitDeadlines = new Map<string, number>();
  const remainingUnit = (finding: Finding) =>
    (unitDeadlines.get(finding.id) ?? Infinity) - Date.now();
  const scanner =
    deps.scanner ??
    composeScanners(
      makeGitleaksDefaultsScanner(makeSubprocessDevEffects(root)),
      ...(policy.review.denylistPatternsFile === undefined
        ? []
        : [makeRepoDiffScanner(root, policy.review.denylistPatternsFile)]),
    );
  const git = async (cwd: string, args: string[]) => {
    const result = await deps.git(['-C', cwd, ...GIT_HARDEN, ...args]);
    if (result.code !== 0)
      throw new Error(`git ${args[0]} refused: ${result.stderr.slice(0, 500)}`);
    // Content is scanned with path-scoped, whitespace-sensitive rules. Only
    // metadata outputs (object IDs, sizes and command receipts) are normalized.
    return args.includes('-z') || args[0] === 'show' || args[0] === 'diff'
      ? result.stdout
      : result.stdout.trim();
  };
  const inspectUntracked = async () => {
    const read = async () =>
      zList(await git(root, ['ls-files', '-z', '--others', '--exclude-standard']));
    if (deps.inspectUntracked) return deps.inspectUntracked(read);
    const paths = await read();
    const unknown = [];
    for (const path of paths) if (!(await deps.isBookkeepingPath?.(path))) unknown.push(path);
    return { paths, unknown };
  };
  const stop = () => {
    if (fatal) throw new AddressRefusal(fatal, true);
    if (deps.parentSignal?.aborted || currentJobContext()?.signal?.aborted)
      throw new AddressRefusal('parent cancelled', false, 'budget');
    if (deps.remainingTokens() <= 0 || deps.remainingWallMs() <= 0)
      throw new AddressRefusal('token or wall budget exhausted', false, 'budget');
  };
  // Long candidate gates must not spend the cross-process retry budget
  // waiting for a healthy sibling in this worker. Rejections release the
  // FIFO too; restoration joins the same queue without skipping index protection.
  let mutations = Promise.resolve();
  const withMutation = <T>(action: () => Promise<T>, admit?: () => void): Promise<T> => {
    const pending = mutations.then(async () => {
      admit?.();
      const context = checkoutWriterContext();
      if (!context) throw new Error('address worker requires authenticated checkout lifetime');
      await context.assertIdentity();
      admit?.();
      return action();
    });
    mutations = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  const scan = async (text: string, contents: readonly ScanContent[] = []) => {
    const components = [
      { component: 'request', path: 'worker-request.json', text },
      ...contents.map((content, index) => ({
        component: `content-${index}`,
        path: content.path ?? 'worker-request.json',
        text: content.text,
      })),
    ];
    let scans: Awaited<ReturnType<DiffSecretScanner>>;
    try {
      scans = await scanner(components);
    } catch (error) {
      throw new AddressRefusal(`upload scanner failed: ${String(error)}`);
    }
    if (
      scans.length !== components.length ||
      components.some((component) => !scans.some((s) => s.component === component.component)) ||
      scans.some((s) => s.hits.length > 0)
    )
      throw new AddressRefusal('upload refused: missing, failed or positive denylist scan');
    // A diagnostic embedded in the prompt without file provenance can carry
    // protected source text no path-scoped rule will ever see: refuse it.
    if (contents.some((content) => content.diagnostic === true && content.path === undefined))
      throw new AddressRefusal('upload refused: diagnostic provenance unavailable');
  };
  const safeFile = async (cwd: string, path: string) => {
    // Glob characters in a real file name (a Next.js route such as
    // `pages/[id].tsx`) stay literal: every Git pathspec this path reaches
    // runs under the hardened --literal-pathspecs prefix.
    if (
      !path ||
      path.startsWith('-') ||
      isAbsolute(path) ||
      path.split(/[\\/]/).some((part) => part === '..')
    )
      throw new Error('finding must name one literal repository-relative file');
    const full = resolve(cwd, path);
    const canonical = await realpath(full);
    const rel = relative(await realpath(cwd), canonical);
    const stat = await lstat(full);
    if (!stat.isFile() || stat.nlink > 1)
      throw new Error('finding must name one ordinary unlinked file');
    if (
      rel.startsWith('../') ||
      rel === '..' ||
      isAbsolute(rel) ||
      (await lstat(full)).isSymbolicLink()
    )
      throw new Error('finding path escapes workspace or is a symlink');
    return canonical;
  };
  const dependencyDirectory = async (admit: () => void, metadataRoot = root) => {
    const installed = async (cwd: string) => {
      try {
        return await realpath(resolve(cwd, 'node_modules'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const local = await installed(root);
    if (local && (!deps.preferDependencyRoot || resolve(deps.dependencyRoot ?? root) === root)) {
      await assertAddressDependenciesIsolated(
        local,
        [root, ...(deps.dependencyRoot ? [deps.dependencyRoot] : [])],
        admit,
      );
      return local;
    }
    if (deps.dependencyRoot === undefined || resolve(deps.dependencyRoot) === root)
      return undefined;
    const caller = await installed(deps.dependencyRoot);
    if (!caller) {
      if (deps.preferDependencyRoot)
        throw new Error('prepared dependency root has no node_modules');
      return undefined;
    }
    await assertAddressDependencyMetadata(
      metadataRoot,
      deps.dependencyRoot,
      admit,
      deps.preferDependencyRoot,
    );
    await assertAddressDependenciesIsolated(caller, [root, deps.dependencyRoot], admit);
    return caller;
  };
  const invoke = async (
    finding: Finding,
    tier: AddressAttempt['tier'],
    attempt: number,
    invocation: AddressAttempt['invocation'],
    observedHead: string,
    workspace: string,
    prompt: string,
    role: ModelSpec,
    editable: boolean,
    prior?: Awaited<ReturnType<typeof addressFailureFeedback>>,
    onDispatch?: (row: AddressAttempt) => void | Promise<void>,
    sources: readonly { path: string; text: string }[] = [],
    diagnostics: readonly FailureSet[] = [],
  ) => {
    // ADR-0008 T14: the attempt boundary is the FIXER dispatch. A reviewer
    // closure verifies an attempt already recorded, and the payload's tier has
    // no reviewer member: labelling it 'worker' would fabricate evidence, so a
    // closure dispatch emits no attempt event.
    const attemptTier = tier === 'reviewer' ? null : tier;
    const unit = attemptTier === null ? '' : packageOf(finding.file!);
    const afterClose = settled;
    if (attemptTier !== null && afterClose)
      observationFailures.push(`attempt observation after close: ${unit}`);
    const ordinal = attemptTier === null ? 0 : (attemptOrdinals.get(unit) ?? 0) + 1;
    if (attemptTier !== null) attemptOrdinals.set(unit, ordinal);
    // Observed stop evidence for the finally-path event. Every throw route is
    // classified BEFORE the boundary; an unobserved throw keeps the honest
    // unknown default and finishAttempt records it as unclassified.
    let stopSet = false;
    let observedStop: FinishAttemptStop = {
      stopCode: 'unclassified',
      stopReason: 'attempt ended without an observed stop',
    };
    const setStop = (next: FinishAttemptStop): void => {
      observedStop = next;
      stopSet = true;
    };
    const cancelStop = (): FinishAttemptStop => ({
      stopCode: 'cancelled',
      stopReason: 'enclosing job cancelled',
    });
    // The cap this dispatch actually observed, named only when exhausted and
    // in stop()'s own order (token first); a unit deadline is a wall bound.
    const budgetCap = (): FinishAttemptStop | null => {
      if (deps.remainingTokens() <= 0)
        return {
          budgetExpired: true,
          budgetStopCode: 'token-cap',
          stopReason: 'token budget exhausted',
        };
      if (deps.remainingWallMs() <= 0)
        return {
          budgetExpired: true,
          budgetStopCode: 'wall-cap',
          stopReason: 'run wall budget exhausted',
        };
      if (remainingUnit(finding) <= 0)
        return {
          budgetExpired: true,
          budgetStopCode: 'wall-cap',
          stopReason: 'unit wall budget exhausted',
        };
      return null;
    };
    // A thrown admission gate (or a stop after a completed result) is
    // classified in stop()'s OWN order — the fatal refusal first, then the
    // parent's cancel, then the budget — so a cancel or a fatal that coincides
    // with an exhausted budget is never labelled the cap it merely met.
    const classifyStopThrow = (error: unknown): FinishAttemptStop => {
      if (fatal !== undefined) return { stopCode: 'unclassified', stopReason: fatal };
      if (deps.parentSignal?.aborted === true || currentJobContext()?.signal?.aborted === true)
        return cancelStop();
      const cap = budgetCap();
      if (cap !== null) return cap;
      return {
        stopCode: 'unclassified',
        stopReason: error instanceof Error ? error.message : String(error),
      };
    };
    // The engine's own admission gate. stop() is asked FIRST, in its own
    // precedence, so a refusal never reaches the boundary anonymously and the
    // cap is only named once stop() itself allowed the dispatch.
    const admitAttempt = (): void => {
      try {
        stop();
      } catch (error) {
        if (!stopSet) setStop(classifyStopThrow(error));
        throw error;
      }
      const cap = budgetCap();
      if (cap !== null) setStop(cap);
    };
    // A refused upload is an observed human deferral, exactly as T13 records it.
    const scanned = async (action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        if (error instanceof AddressRefusal && !stopSet)
          setStop({ stopCode: 'human-deferred', stopReason: error.message });
        throw error;
      }
    };
    const boundaryStart = Date.now();
    let attemptRow: AddressAttempt | undefined;
    let dispatchedModel: ModelSpec | null = null;
    let deadline: FixerDeadline | undefined;
    let allowedTokens: number | null = null;
    let allowedWall: number | null = null;
    let boundWallMs: number | null = null;
    let usage: Usage | undefined;
    let spentTokens: number | null = null;
    let servedModel: string | null = null;
    let thrown: unknown;
    let driverThrew = false;
    try {
      admitAttempt();
      if (remainingUnit(finding) <= 0)
        throw new AddressRefusal('unit wall budget exhausted', false, 'budget');
      if (prior)
        prompt += `\nPrior failed-attempt patch (engine-owned feedback; do not repeat rejected changes):\n${prior.patch}`;
      const attributed = diagnosticSources(diagnostics);
      const unattributed = diagnosticMessages(diagnostics);
      const scanSet = (extra: readonly { text: string; path?: string }[] = []): ScanContent[] => {
        const set: ScanContent[] = [
          ...extra,
          ...sources,
          ...attributed,
          ...(prior?.contents ?? []),
        ];
        if (unattributed.length)
          set.push(...unattributed.map((message) => ({ text: message, diagnostic: true })));
        return set;
      };
      await scanned(() => scan(prompt, scanSet()));
      admitAttempt();
      let requestRefusal: AddressRefusal | undefined;
      const resolved = deps.drivers.resolve({
        role: tier === 'reviewer' ? 'reviewer' : 'fixer',
        modelSpec: role,
        beforeRequest: async (text, contents = []) => {
          try {
            admitAttempt();
            await scanned(() => scan(text, scanSet(contents)));
            admitAttempt();
          } catch (error) {
            if (error instanceof AddressRefusal) requestRefusal = error;
            throw error;
          }
        },
        harness: {
          ...defaultHarnessConfig,
          tools: {
            read: { ...defaultHarnessConfig.tools.read },
            edit: {
              ...defaultHarnessConfig.tools.edit,
              enabled: editable,
              pathPatterns: editable ? [finding.file!] : [],
            },
            write: { ...defaultHarnessConfig.tools.write, enabled: false, pathPatterns: [] },
            bash: { ...defaultHarnessConfig.tools.bash, enabled: false, commandPatterns: [] },
          },
        },
      });
      const row: AddressAttempt = {
        finding: finding.id,
        tier,
        attempt,
        invocation,
        reason: prompt.split('\n')[0]!,
        model: resolved.modelSpec,
        observedHead,
        wallMs: 0,
      };
      await onDispatch?.(row);
      deps.attempts.push(row);
      // ADR-0008 T14: once the row exists, the event reuses ITS wall (the
      // dispatch, exactly as T13 does), so the prompt scan before dispatch is
      // not reported as budget-remaining wall that was never available.
      attemptRow = row;
      dispatchedModel = resolved.modelSpec;
      const start = Date.now();
      const signals = [deps.parentSignal, currentJobContext()?.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      // The caps this dispatch is actually bounded by, recorded as the observed
      // budget evidence (never an invented cap): the same values the request
      // carries and the deadline arms.
      const maxTokens = deps.remainingTokens();
      const wallClockMs = Math.min(
        policy.budgets.step.wallMs,
        deps.remainingWallMs(),
        remainingUnit(finding),
      );
      allowedTokens = maxTokens;
      allowedWall = wallClockMs;
      boundWallMs = wallClockMs;
      const attemptDeadline = startFixerDeadline(
        signals.length ? AbortSignal.any(signals) : undefined,
        wallClockMs,
      );
      deadline = attemptDeadline;
      try {
        let result: WorkerResult;
        try {
          result = await resolved.driver.run(
            {
              prompt,
              modelSpec: resolved.modelSpec,
              workspace: { path: workspace },
              toolPolicy: {
                mode: 'allowlist',
                allow: editable
                  ? ['read', 'edit']
                  : [
                      'read',
                      ...(tier === 'reviewer' && policy.review.searchTools ? ['grep', 'glob'] : []),
                    ],
              },
              sandboxPolicy: { level: editable ? 'workspace-write' : 'read-only' },
              budget: { maxTokens, wallClockMs },
              outputSchema:
                invocation === 'closure'
                  ? toOutputSchema('review.address.closure/v1', ClosureSchema)
                  : toOutputSchema('review.address.outcome/v1', OutcomeSchema),
              // Session-log correlation (M5b3): forward the governed job's minted
              // work identity onto every worker invocation so the lane stamps the
              // child's CQ_* env. The KERNEL reads the job context; the shared
              // driver helper stays pure over the correlation value (ADR-0002
              // one-directional rule). Absent outside a governed dispatch.
              ...correlationInvocation(currentJobContext()?.info?.correlation),
            },
            { signal: attemptDeadline.signal },
          );
        } catch (driverError) {
          // Only a driver-call rejection is a driver-sourced cause; a loop throw
          // must not be misattributed to the driver. A refusal the engine
          // recorded BEFORE dispatch (a request scan) is the engine's own stop,
          // not the driver's: it keeps its own source and class.
          driverThrew = requestRefusal === undefined;
          throw driverError;
        }
        deps.account(result);
        row.usage = result.usage;
        usage = result.usage;
        spentTokens =
          result.usage.input +
          result.usage.output +
          result.usage.cacheRead +
          result.usage.cacheWrite +
          (result.usage.reasoning ?? 0);
        servedModel = result.model ?? null;
        if (result.costUSD !== undefined) row.costUSD = result.costUSD;
        if (requestRefusal) throw requestRefusal;
        // stop() is asked FIRST, in its own order (fatal, cancel, budget), so a
        // cancel that coincides with an exhausted cap stays the cancel. A cap
        // reached by an otherwise complete result is then the budget variant
        // with the cap named; a fired deadline is the wall cap.
        try {
          stop();
        } catch (error) {
          if (!stopSet) setStop(classifyStopThrow(error));
          throw error;
        }
        const cap = budgetCap();
        if (cap !== null) setStop(cap);
        else if (attemptDeadline.expired())
          setStop({
            budgetExpired: true,
            budgetStopCode: 'wall-cap',
            stopReason: 'address fixer wallClockMs deadline expired',
          });
        if (attemptDeadline.expired())
          throw new AddressRefusal('step wall budget exhausted', false, 'budget');
        if (result.stopReason !== 'complete') {
          // A worker-reported budget stop without a named cap keeps the raw code:
          // finishAttempt's unknown branch preserves it (never a guessed cap).
          setStop({
            stopCode: result.stopReason,
            stopReason: `worker stopped: ${result.stopReason}`,
          });
          if (result.stopReason === 'budget' || result.stopReason === 'aborted')
            throw new AddressRefusal(`worker stopped: ${result.stopReason}`, false, 'budget');
          throw new Error(`worker stopped: ${result.stopReason}`);
        }
        if (!stopSet) setStop({ completed: true });
        return result.structuredOutput;
      } catch (error) {
        throw requestRefusal ?? error;
      } finally {
        row.wallMs = Date.now() - start;
        attemptDeadline.dispose();
      }
    } catch (error) {
      thrown ??= error;
      // Classify throws with no observed stop before the boundary: a fired
      // wallClockMs deadline is the budget variant with the cap named; a
      // cancelled or governed-aborted job is the cancel stop.
      if (!stopSet) {
        if (deadline?.expired() === true)
          setStop({
            budgetExpired: true,
            budgetStopCode: 'wall-cap',
            stopReason: 'address fixer wallClockMs deadline expired',
          });
        else if (deps.parentSignal?.aborted || currentJobContext()?.signal?.aborted)
          setStop(cancelStop());
      }
      throw error;
    } finally {
      // ADR-0008 T14: exactly one attempt-finished event per fixer dispatch,
      // whatever route reached this boundary (spawn failure, cancellation,
      // budget exhaustion, a refusal before dispatch). Observation failures
      // never change the outcome: emitAttempt swallows them into evidence.
      if (attemptTier !== null && !afterClose) {
        // Once the row exists its measured dispatch wall is the event's wall;
        // only a refusal that never reached the row falls back to the whole
        // boundary (which includes the pre-dispatch scan).
        const wallMs = attemptRow?.wallMs ?? Date.now() - boundaryStart;
        await emitAttempt(() => ({
          type: 'attempt-finished',
          runId: deps.observationRunId ?? deps.observationWriter?.compositionRunId ?? '',
          at: new Date().toISOString(),
          // Production identity is `<package>/<fixer>` (runFix, registry,
          // unit.ts); the review lane's fixer slot is ADDRESS_FIXER, and the
          // order is preserved rather than inventing a second one.
          unitId: deps.observationUnitId ?? `${unit}/${ADDRESS_FIXER}`,
          jobId: currentJobContext()?.info.jobKey ?? null,
          taskId: finding.id,
          attempt: ordinal,
          payload: finishAttempt({
            ...observedStop,
            // The prose message of a driver throw stays in stopReason; error.code
            // keeps the stable code, never the prose.
            ...(driverThrew && thrown instanceof Error
              ? { stopReason: `${observedStop.stopReason as string}; ${thrown.message}` }
              : {}),
            tier: attemptTier,
            invocation: `${runPrefix}:${finding.id}:${String(ordinal)}:${invocation}`,
            model: dispatchedModel,
            ...(dispatchedModel === null
              ? {}
              : {
                  provider: dispatchedModel.provider,
                  requestedModel: dispatchedModel.model,
                }),
            servedModel,
            tokens: spentTokens,
            usageChannels:
              usage === undefined
                ? {}
                : {
                    input: usage.input,
                    output: usage.output,
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    reasoning: usage.reasoning ?? null,
                  },
            requests: usage === undefined ? null : 1,
            wallMs,
            ...(driverThrew && thrown !== undefined
              ? {
                  error: {
                    type: thrown instanceof Error ? thrown.name : null,
                    // A stable code when the error carries one; a pre-dispatch
                    // DispatchError's class is the stable code when it does not.
                    code:
                      typeof (thrown as { code?: unknown } | null)?.code === 'string'
                        ? (thrown as { code: string }).code
                        : (errorClassOf(thrown) ?? null),
                    providerFinishReason: null,
                    source: 'driver',
                    certainty: 'observed' as const,
                  },
                }
              : {}),
            timeout:
              deadline === undefined || !deadline.expired()
                ? null
                : {
                    scope: 'attempt' as const,
                    boundMs: boundWallMs ?? 0,
                    source: 'address fixer wallClockMs deadline',
                  },
            budget: {
              allowed: { tokens: allowedTokens, wallMs: allowedWall },
              spent: { tokens: spentTokens, wallMs },
              remaining: {
                tokens:
                  allowedTokens === null || spentTokens === null
                    ? null
                    : Math.max(0, allowedTokens - spentTokens),
                wallMs: allowedWall === null ? null : Math.max(0, allowedWall - wallMs),
              },
            },
          }),
        }));
      }
    }
  };
  /** Drain whole fixes, bounded and verdict-neutral, before closing the writer. */
  const settleObservations = async (): Promise<void> => {
    settled = true;
    if (inFlightFixes.size === 0) return;
    const outstanding = [...inFlightFixes.keys()];
    const units = [...inFlightFixes.values()];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(outstanding).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), observationDrainMs);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!drained)
      observationFailures.push(`attempt observation still in flight at close: ${units.join(', ')}`);
  };
  const runChecks = async (
    cwd: string,
    finding: Finding,
    related: boolean,
    scope: 'all' | 'leg' | 'finding' = 'all',
    baseline = false,
  ) => {
    const results: FailureSet[] = [];
    for (const check of policy.checks) {
      if (scope !== 'all' && findingScoped(check) !== (scope === 'finding')) continue;
      try {
        stop();
        if (remainingUnit(finding) <= 0)
          throw new AddressRefusal('unit wall budget exhausted', false, 'budget');
        const checkRoot = resolve(cwd, check.command.cwd ?? '.');
        const rel = relative(await realpath(cwd), await realpath(checkRoot));
        if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
          throw new Error('check.cwd escapes candidate');
        let command = {
          ...check.command,
          cwd: checkRoot,
          timeoutMs: Math.min(
            check.command.timeoutMs ?? Infinity,
            deps.remainingWallMs(),
            policy.budgets.step.wallMs,
            remainingUnit(finding),
          ),
        };
        if (related || findingScoped(check)) {
          const files = relatedFilesRelativeToCheck([finding.file!], cwd, checkRoot);
          command =
            check.kind === 'static'
              ? {
                  ...command,
                  ...staticRelatedCheckCommand(command, check.adapter, files, check.relatedArgs),
                }
              : { ...command, ...relatedCheckCommand(command, files, check.relatedArgs) };
        }
        const signals = [deps.parentSignal, currentJobContext()?.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        );
        const signal = signals.length ? AbortSignal.any(signals) : undefined;
        for (let attempt = 0; ; attempt++) {
          stop();
          if (remainingUnit(finding) <= 0)
            throw new AddressRefusal('unit wall budget exhausted', false, 'budget');
          command.timeoutMs = Math.min(
            command.timeoutMs,
            deps.remainingWallMs(),
            remainingUnit(finding),
          );
          let capture: RawCheckOutput | undefined;
          const result = await makeCheckRunner(async (cmd) => {
            capture = await subprocessRunCheck(cmd, signal ? { signal } : undefined);
            return capture;
          })({ adapter: check.adapter, command });
          stop(); // Classify only after the child settled; cancellation wins.
          const transient =
            capture === undefined ||
            capture.exitCode === null ||
            [75, 129, 130, 137, 143].includes(capture.exitCode);
          if (baseline && transient && attempt === 0) continue;
          if (result.status !== 'ok' || transient) {
            let detail: string = result.status;
            if (result.status === 'indeterminate') detail = result.detail;
            else if (result.status === 'failed') detail = result.error;
            // Scan the full capture before retaining bounded tails: a secret may
            // straddle the tail boundary. Missing/failed scans suppress output.
            let safe = false;
            let withheld = '[withheld: scanner unavailable/failed]';
            if (baseline && capture) {
              const output = capture;
              let timer: ReturnType<typeof setTimeout> | undefined;
              let onAbort: (() => void) | undefined;
              try {
                const limit = Math.max(
                  0,
                  Math.min(
                    30_000,
                    deps.remainingWallMs(),
                    policy.budgets.step.wallMs,
                    remainingUnit(finding),
                  ),
                );
                const expired = new Promise<never>((_resolve, reject) => {
                  onAbort = () => reject(new Error('diagnostic scan cancelled'));
                  signal?.addEventListener('abort', onAbort, { once: true });
                  timer = setTimeout(() => reject(new Error('diagnostic scan timeout')), limit);
                  if (signal?.aborted || limit === 0) onAbort();
                });
                const scans = await Promise.race([
                  expired,
                  Promise.resolve().then(() =>
                    scanner(
                      [
                        {
                          component: 'check-stdout',
                          path: 'check-output.txt',
                          text: output.stdout,
                        },
                        {
                          component: 'check-stderr',
                          path: 'check-output.txt',
                          text: output.stderr,
                        },
                      ],
                      { timeoutMs: Math.max(1, limit) },
                    ),
                  ),
                ]);
                safe =
                  scans.length === 2 &&
                  ['check-stdout', 'check-stderr'].every((component) =>
                    scans.some((row) => row.component === component && row.hits.length === 0),
                  ) &&
                  scans.every((row) => row.hits.length === 0);
                if (scans.some((row) => row.hits.length > 0))
                  withheld = '[withheld: secret matched]';
              } catch {
                /* Suppress output when scanning is unavailable. */
              } finally {
                clearTimeout(timer);
                if (onAbort) signal?.removeEventListener('abort', onAbort);
              }
              stop();
            }
            const diagnostics =
              baseline && capture
                ? {
                    exitCode: capture.exitCode,
                    signal: capture.signal ?? null,
                    stdoutTail: safe ? capture.stdout.slice(-4096) : withheld,
                    stderrTail: safe ? capture.stderr.slice(-4096) : withheld,
                  }
                : undefined;
            throw new CheckFailure(
              `configured check was ${result.status} (${check.adapter}): ${detail.slice(0, 1000)}${transient ? '; transient check exit ' + String(capture?.exitCode) : ''}`,
              transient,
              findingScoped(check),
              diagnostics,
            );
          }
          results.push(normalizeFailurePaths(result.value, cwd, checkRoot));
          break;
        }
      } catch (error) {
        if (error instanceof AddressRefusal || error instanceof CheckFailure) throw error;
        throw new CheckFailure(
          error instanceof Error ? error.message : String(error),
          transientSystemFailure(error),
          findingScoped(check),
        );
      }
    }
    return results;
  };
  const initialize = (admit = stop) =>
    (initialization ??= withMutation(async () => {
      await deps.prepareBookkeeping?.();
      admit();
      if (
        (await git(root, ['diff', '--name-only', '-z', 'HEAD'])) ||
        (await git(root, ['diff', '--cached', '--name-only', '-z']))
      )
        throw new Error('review.address requires a clean tracked worker tree');
      const { unknown: callerUnknown } = await inspectUntracked();
      if (callerUnknown.length) throw new Error('review.address requires no unknown worker files');
      verifiedHeads.add(await git(root, ['rev-parse', 'HEAD']));
    }, admit));
  const preconditions: AddressPrecondition[] = [];
  const baselineCache = new Map<string, FailureSet[]>();
  const refusePrecondition = (
    original: unknown,
    stage: AddressPrecondition['stage'],
    finding?: Finding,
  ): never => {
    const error = original instanceof BaselineCleanupError ? original.original : original;
    const cleanupError =
      original instanceof BaselineCleanupError ? String(original.cleanup) : undefined;
    if (error instanceof AddressRefusal) {
      if (cleanupError) {
        error.message += `; baseline cleanup failed: ${cleanupError}`;
        if (error instanceof PreconditionRefusal) error.precondition.cleanupError = cleanupError;
        if (error.fatal && preconditionFailure) preconditionFailure = error.message;
      }
      throw error;
    }
    const transient =
      error instanceof CheckFailure ? error.transient : transientSystemFailure(error);
    const scoped = error instanceof CheckFailure && error.scoped;
    const cause: AddressPrecondition = {
      kind: transient ? 'transient' : 'deterministic',
      scope: scoped ? 'finding' : 'leg',
      stage,
      ...(error instanceof CheckFailure && error.diagnostics
        ? { checkDiagnostics: error.diagnostics }
        : {}),
      reason: error instanceof Error ? error.message : String(error),
      ...(scoped && finding ? { finding: finding.id } : {}),
      ...(cleanupError ? { cleanupError } : {}),
    };
    preconditions.push(cause);
    const refusal = new PreconditionRefusal(cause);
    if (cleanupError) refusal.message += `; baseline cleanup failed: ${cleanupError}`;
    if (refusal.fatal) preconditionFailure = refusal.message;
    throw refusal;
  };
  const prepareDependencies = async (
    cwd: string,
    finding: Finding,
    admit: () => void,
    snapshot = true,
  ) => {
    try {
      const dependencies = await dependencyDirectory(admit, cwd);
      if (dependencies && snapshot)
        await snapshotAddressDependencies(dependencies, resolve(cwd, 'node_modules'), admit);
      return dependencies;
    } catch (error) {
      return refusePrecondition(error, 'dependencies', finding);
    }
  };
  const prepareBaseline = async (
    cwd: string,
    parent: string,
    finding: Finding,
    admit: () => void,
    includeFinding = false,
  ) => {
    // A cached leg baseline still needs dependency VALIDATION, but the
    // preflight worktree is discarded without running checks, so its
    // node_modules copy is waste. Fixed candidates (includeFinding) always
    // take their own snapshot.
    const cached = baselineCache.get(parent);
    const dependencies = await prepareDependencies(
      cwd,
      finding,
      admit,
      cached === undefined || includeFinding,
    );
    try {
      let leg = cached;
      if (!leg) {
        leg = await runChecks(cwd, finding, false, 'leg', true);
        baselineCache.set(parent, leg);
      }
      const scoped = includeFinding ? await runChecks(cwd, finding, false, 'finding', true) : [];
      let i = 0,
        j = 0;
      return {
        dependencies,
        checks: includeFinding
          ? policy.checks.map((check) => (findingScoped(check) ? scoped[j++]! : leg[i++]!))
          : leg,
      };
    } catch (error) {
      return refusePrecondition(error, 'check', finding);
    }
  };
  return {
    escalation: () => state,
    preconditionFailure: () => preconditionFailure,
    preconditions: () => preconditions,
    observationFailures: () => observationFailures,
    settleObservations,
    async withVerifiedHead(action) {
      await initialize();
      return withMutation(async () => {
        const head = await git(root, ['rev-parse', 'HEAD']);
        stop();
        if (!verifiedHeads.has(head))
          throw new AddressRefusal('unexpected admission head outside engine', true);
        const result = await action(head);
        stop();
        const after = await git(root, ['rev-parse', 'HEAD']);
        stop();
        if (after !== head) throw new AddressRefusal('admission head changed outside engine', true);
        return result;
      }, stop);
    },
    async fix(finding, round) {
      let releaseFix!: () => void;
      const fixSettled = new Promise<void>((resolve) => {
        releaseFix = resolve;
      });
      try {
        // Resolve the unit before registration; every registered fix is released
        // by this finally, including early returns and thrown setup failures.
        const unit = finding.file ? packageOf(finding.file) : finding.id;
        inFlightFixes.set(fixSettled, unit);
        let observedHead = '';
        const history: AddressFailedAttempt[] = [];
        const validations: ValidationVerdict[] = [];
        /**
         * ADR-0008 T19 converse: a deliberate scope deferral is a terminal
         * adjudication, not an operational failure. It shares failed()'s shape
         * exactly but never carries the `failure` discriminator, so the
         * composition records the disposition instead of withholding it.
         * Classification rule: a result is DELIBERATE when it is decided
         * from the finding's own data and policy BEFORE any attempt or
         * execution; it is OPERATIONAL when it arises during or after an
         * attempt, or depends on resources or environment. The unanchored
         * finding and the pre-attempt protected-scope refusal are deliberate;
         * every human-tier escalation outcome (missing rescue role,
         * per-package or per-run rescue exhaustion) is resource failure and
         * stays on failed(). Each deliberate deferral must carry a verified
         * observation head, read the way the dispatch loop reads it.
         */
        const deferredForHuman = (reason: string): AddressFix => ({
          finding: {
            ...finding,
            status: 'deferred',
            reason,
            ...(history.length ? { evidence: JSON.stringify(history.at(-1)) } : {}),
          },
          observedHead,
          reason,
          validation: validations,
          failedAttempts: history,
        });
        const failed = (reason: string): AddressFix => ({
          ...deferredForHuman(reason),
          // The ONLY producer of this discriminator: an operational failure is
          // never a deliberate deferral (ADR-0008 T19).
          failure: { reason },
        });
        let file = finding.file;
        if (!file) {
          // A deliberate deferral is a durable disposition, so it must carry
          // the verified head — read exactly the way the dispatch loop does.
          // initialize(stop) is the same admission withVerifiedHead runs; it
          // is memoized, so the PR path and an already-dispatched filed
          // sibling join the existing admission rather than re-admitting.
          // Only a fileless finding that precedes every admission — the
          // local dispatch path, which calls fix directly — runs it here, so
          // verifiedHeads holds the head this read accepts; a head outside
          // that set is the existing refusal.
          await initialize(stop);
          observedHead = await withMutation(async () => {
            const head = await git(root, ['rev-parse', 'HEAD']);
            if (!verifiedHeads.has(head))
              throw new AddressRefusal('unexpected worker execution head', true);
            return head;
          }, stop);
          return deferredForHuman('unanchored finding needs human scope');
        }
        try {
          file = relative(await realpath(root), await safeFile(root, file));
          finding = { ...finding, file };
        } catch (error) {
          return failed(String(error));
        }
        if (active.has(file)) return failed('overlapping finding file is already active');
        active.add(file);
        const unitStart = Date.now();
        unitDeadlines.set(finding.id, unitStart + policy.budgets.unit.wallMs);
        let touched = false;
        let terminalAttempt: object | undefined;
        let terminalDeferred = false;
        let editingRow: AddressAttempt | undefined;
        // The driver-resolved model of the in-flight dispatch. Typed optional
        // only because it is assigned inside the dispatch callback (a
        // definite-assignment consequence, not a real possibility of absence):
        // the callback sets it together with `touched`, and restore() pins only
        // when `touched`, so both non-null uses are safe to assert.
        let resolvedModel: ModelSpec | undefined;
        let restoreRefused = false;
        let dispatch:
          | { tier: 'worker' | 'rescue'; role: ModelSpec; ordinal: number; slug: string }
          | undefined;
        const admitMutation = () => {
          stop();
          if (remainingUnit(finding) <= 0)
            throw new AddressRefusal('unit wall budget exhausted', false, 'budget');
        };
        const restore = async () => {
          if (terminalDeferred) return;
          if (
            touched &&
            deps.terminalBinding &&
            terminalAttempt &&
            deps.parentSignal?.aborted &&
            deferAddressTerminalAttempt(deps.terminalBinding, terminalAttempt)
          ) {
            terminalDeferred = true;
            return;
          }
          return withMutation(async () => {
            if (!touched) return;
            if (restoreRefused)
              throw new Error('prior evidence restore refused; caller bytes retained');
            const head = await git(root, ['rev-parse', 'HEAD']);
            if (!verifiedHeads.has(head))
              throw new Error('unexpected HEAD movement; evidence left intact');
            const indexed = zList(await git(root, ['diff', '--cached', '--name-only', '-z']));
            if (indexed.some((path) => path !== file))
              fatal = 'worker changed the index outside its scope';
            if (!dispatch) throw new Error('failed attempt has no dispatch identity');
            const content = await readFile(await safeFile(root, file));
            const candidate = resolve(deps.journalDir, `failed-candidate-${randomUUID()}`);
            await git(root, ['worktree', 'add', '--detach', candidate, head]);
            if (deps.terminalBinding)
              await addressTerminalCandidate(deps.terminalBinding, root, candidate, false);
            try {
              await writeFile(await safeFile(candidate, file), content);
              await git(candidate, ['add', '--', file]);
              const lastGate = validations
                .at(-1)
                ?.gates.find((gate) => gate.verdict !== 'pass')?.gate;
              // Typed failure sites name their gate; `reason` is free-form
              // (provider/model prose, closure and feedback reasons), so it
              // never decides the retained classification. A fatal refusal is
              // an engine tamper observation, and otherwise the validator's
              // failing gate is authoritative.
              const gate: FailedAttemptGate =
                attemptRefusal?.gate ??
                (fatal ? 'tamper' : lastGate === 'paths' ? 'path-policy' : (lastGate ?? 'none'));
              const outcome = gate === 'budget' || fatal ? 'escalated-to-human' : 'unfixed';
              const pinned = await pinAddressFailure((args) => git(candidate, args), {
                runPrefix,
                kind: 'review',
                slug: dispatch.slug,
                task: finding.id,
                parent: head,
                firstAttempt: dispatch.ordinal,
                tier: dispatch.tier,
                model: resolvedModel!,
                gate,
                outcome,
                reason,
                pushFailed: false,
              });
              const ordinal = Number(pinned.branch.slice(pinned.branch.lastIndexOf('/a') + 2));
              const retained: AddressFailedAttempt = {
                ...pinned,
                finding: finding.id,
                unit: `review/${dispatch.slug}`,
                outcome,
                model: resolvedModel!,
                file,
                parent: head,
                executionHead: observedHead,
                ordinal,
                tier: dispatch.tier,
                gate,
                reason,
              };
              history.push(retained);
              failures.push(retained);
              ordinals.set(finding.id, ordinal);
              if (editingRow) editingRow.failedAttempt = retained;
              if (
                (await git(root, ['rev-parse', 'HEAD'])) !== head ||
                !(await readFile(await safeFile(root, file))).equals(content)
              )
                throw new Error('failed-attempt source changed before owned restore');
              await git(root, [
                'restore',
                `--source=${head}`,
                '--staged',
                '--worktree',
                '--',
                file,
              ]);
            } finally {
              await (deps.terminalBinding
                ? addressTerminalCandidate(deps.terminalBinding, root, candidate, true)
                : git(root, ['worktree', 'remove', '--force', candidate]));
            }
            if (deps.terminalBinding && terminalAttempt) {
              releaseAddressTerminalAttempt(deps.terminalBinding, terminalAttempt);
              terminalAttempt = undefined;
            }
            touched = false;
          }).catch((error: unknown) => {
            restoreRefused = true;
            throw error;
          });
        };
        let workerUsed = 0,
          rescueUsed = 0,
          regression = false;
        let reason = 'initial finding';
        // The typed refusal that ended the current attempt, if any. Function
        // scoped because restore() runs from catches that precede the
        // per-iteration `refusal` declaration; the gate it carries is what
        // the retained failed attempt records.
        let attemptRefusal: AddressRefusal | undefined;
        // Set once `git commit` has created a commit: from then on ANY error
        // is terminal for this unit (a retry would re-dispatch work whose
        // commit already landed). `committedFix` carries the result to return
        // when verification succeeded and only later bookkeeping failed.
        let commitCreated = false;
        let committedFix: AddressFix | undefined;
        try {
          await initialize(admitMutation);
          await safeFile(root, file);
          const classified = classifyStagePaths([file], undefined, false, false);
          if (classified.kind !== 'clean') {
            // Pre-attempt policy refusal on the finding's own path: DELIBERATE
            // by the classification rule, so it defers (with a verified head)
            // instead of failing. initialize() just admitted this head.
            observedHead = await withMutation(async () => {
              const head = await git(root, ['rev-parse', 'HEAD']);
              if (!verifiedHeads.has(head))
                throw new AddressRefusal('unexpected worker execution head', true);
              return head;
            }, admitMutation);
            return deferredForHuman(classified.message ?? 'protected scope');
          }
          if (!policy.roles.reviewer)
            refusePrecondition(
              new Error('roles.reviewer required for assigned-finding closure'),
              'reviewer',
              finding,
            );
          await withMutation(async () => {
            const baselineHead = await git(root, ['rev-parse', 'HEAD']);
            if (!verifiedHeads.has(baselineHead))
              throw new AddressRefusal('unexpected baseline head outside engine', true);
            const candidate = resolve(deps.journalDir, `baseline-${randomUUID()}`);
            await git(root, ['worktree', 'add', '--detach', candidate, baselineHead]);
            if (deps.terminalBinding)
              await addressTerminalCandidate(deps.terminalBinding, root, candidate, false);
            let failure: { error: unknown } | undefined;
            try {
              await prepareBaseline(candidate, baselineHead, finding, admitMutation);
            } catch (error) {
              failure = { error };
            }
            try {
              await (deps.terminalBinding
                ? addressTerminalCandidate(deps.terminalBinding, root, candidate, true)
                : git(root, ['worktree', 'remove', '--force', candidate]));
            } catch (cleanup) {
              if (failure) throw new BaselineCleanupError(failure.error, cleanup);
              throw cleanup;
            }
            if (failure) throw failure.error;
          }, admitMutation).catch((error: unknown) => refusePrecondition(error, 'setup', finding));
          while (true) {
            attemptRefusal = undefined;
            stop();
            if (Date.now() - unitStart >= policy.budgets.unit.wallMs)
              return failed('unit wall budget exhausted');
            // The dispatched package is the observation unit identity; one
            // resolver so the observation envelope and the escalation agree.
            const packageName = packageOf(file);
            const next = nextEscalation(state, policy.escalation, {
              package: packageName,
              task: finding.id,
              workerUsed,
              rescueUsed,
              canRescue: policy.roles.rescue !== undefined,
              regression,
              reason,
            });
            state = next.state;
            if (next.decision.tier === 'human') return failed(next.decision.reason);
            const { tier, attempt } = next.decision;
            if (tier === 'worker') workerUsed++;
            else rescueUsed++;
            const role = tier === 'worker' ? policy.roles.worker : policy.roles.rescue;
            if (!role) return failed(`roles.${tier} is required`);
            observedHead = await withMutation(async () => {
              const head = await git(root, ['rev-parse', 'HEAD']);
              if (!verifiedHeads.has(head))
                throw new AddressRefusal('unexpected worker execution head', true);
              return head;
            }, admitMutation);
            let prior: Awaited<ReturnType<typeof addressFailureFeedback>> | undefined;
            if (tier === 'rescue' && history.length) {
              prior = await withMutation(async () => {
                if (
                  (await git(root, ['diff', '--name-only', '-z', 'HEAD', '--', file])) ||
                  (await git(root, ['diff', '--cached', '--name-only', '-z', '--', file]))
                )
                  throw new AddressRefusal('owned file is dirty before rescue feedback', true);
                return addressFailureFeedback((args) => git(root, args), history.at(-1)!);
              }, admitMutation);
            }
            dispatch = {
              tier,
              role,
              ordinal: (ordinals.get(finding.id) ?? 0) + 1,
              slug: packageName,
            };
            let output: z.infer<typeof OutcomeSchema>;
            try {
              output = OutcomeSchema.parse(
                await invoke(
                  finding,
                  tier,
                  attempt,
                  'edit',
                  observedHead,
                  root,
                  `${next.decision.reason}\nAddress only ${file}. Read it with the read tool first; to fix the finding, apply the change to ${file} with the edit tool before you answer. Never stage or commit, run commands, or edit any other path. Return fixed only after a successful edit; otherwise return rejected or deferred with a concrete reason and code evidence.\nRound ${round}. Finding: ${JSON.stringify(finding)}\nPrevious: ${reason}`,
                  role,
                  true,
                  prior,
                  async (row) => {
                    if (deps.terminalBinding) {
                      terminalAttempt = await withMutation(async () => {
                        const parent = await git(root, ['rev-parse', 'HEAD']);
                        if (!verifiedHeads.has(parent))
                          throw new AddressRefusal('unexpected terminal capture head', true);
                        return recordAddressTerminalAttempt(deps.terminalBinding!, {
                          root,
                          file,
                          parent,
                          executionHead: observedHead,
                          runPrefix,
                          finding: finding.id,
                          slug: dispatch!.slug,
                          ordinal: dispatch!.ordinal,
                          tier,
                          model: row.model,
                        });
                      }, admitMutation);
                    }
                    touched = true;
                    editingRow = row;
                    resolvedModel = row.model;
                  },
                ),
              );
            } catch (error) {
              reason = error instanceof Error ? error.message : String(error);
              if (error instanceof AddressRefusal) attemptRefusal = error;
              await restore();
              if (error instanceof AddressRefusal) {
                if (error.fatal) fatal = reason;
                return failed(reason);
              }
              continue;
            }
            let refusal: AddressRefusal | undefined;
            const accepted = await withMutation(async (): Promise<AddressFix | undefined> => {
              stop();
              const parent = await git(root, ['rev-parse', 'HEAD']);
              if (!verifiedHeads.has(parent))
                throw new AddressRefusal('verified parent changed outside engine', true);
              const index = await git(root, ['diff', '--cached', '--name-only', '-z']);
              if (index)
                throw new AddressRefusal('worker changed the index; engine refuses staging', true);
              const changes = zList(await git(root, ['diff', '--name-only', '-z', 'HEAD']));
              const { paths: untracked, unknown: callerUntracked } = await inspectUntracked();
              if ([...changes, ...callerUntracked].some((p) => !active.has(p)))
                throw new AddressRefusal('unknown or out-of-scope worker edits', true);
              if (
                classifyStagePaths([...changes, ...untracked], undefined, false, false).kind !==
                'clean'
              )
                throw new AddressRefusal('protected worker edits', true);
              const candidate = resolve(deps.journalDir, `candidate-${randomUUID()}`);
              await git(root, [
                'worktree',
                'add',
                '--detach',
                candidate,
                output.disposition === 'fixed' ? parent : observedHead,
              ]);
              if (deps.terminalBinding)
                await addressTerminalCandidate(deps.terminalBinding, root, candidate, false);
              try {
                // Candidate checks may invoke a package manager. Keep their
                // node_modules metadata private so relinking cannot corrupt the
                // caller's dependencies. Package links retain absolute targets.
                const prepared =
                  output.disposition === 'fixed'
                    ? await prepareBaseline(candidate, parent, finding, admitMutation, true)
                    : undefined;
                const dependencies = prepared?.dependencies;
                const baseline = prepared?.checks ?? [];

                const content = await readFile(await safeFile(root, file));
                await writeFile(await safeFile(candidate, file), content);
                await git(candidate, ['add', '--', file]);
                const tree = await git(candidate, ['write-tree']);
                const diff = await git(candidate, [
                  'diff',
                  '--cached',
                  '--no-ext-diff',
                  '--no-textconv',
                  '--',
                  file,
                ]);
                if (output.disposition !== 'fixed') {
                  if (diff) throw new Error('disposition accompanied by edits');
                  if (output.evidence.length === 0)
                    throw new Error('disposition needs execution-head evidence');
                  for (const evidence of output.evidence) {
                    await safeFile(root, evidence.path);
                    const text = await git(root, ['show', `${observedHead}:${evidence.path}`]);
                    if (text.split('\n').length < evidence.line)
                      throw new Error('disposition evidence missing at execution head');
                  }
                  if (output.disposition === 'rejected') {
                    if (!policy.roles.reviewer)
                      throw new Error('roles.reviewer required for rejection evidence');
                    const reviewed = ClosureSchema.parse(
                      await invoke(
                        finding,
                        'reviewer',
                        attempt,
                        'closure',
                        observedHead,
                        candidate,
                        `Verify this rejection using only the worker-observed execution head ${observedHead}. closed=true means the finding is a false positive supported by this tree. Finding: ${JSON.stringify(finding)}. Reason/evidence: ${JSON.stringify(output)}`,
                        policy.roles.reviewer,
                        false,
                      ),
                    );
                    if (!reviewed.closed)
                      throw new Error('rejection not supported at worker execution head');
                  }
                  touched = false;
                  if (deps.terminalBinding && terminalAttempt) {
                    releaseAddressTerminalAttempt(deps.terminalBinding, terminalAttempt);
                    terminalAttempt = undefined;
                  }
                  return {
                    finding: {
                      ...finding,
                      status: output.disposition,
                      reason: output.reason,
                      evidence: JSON.stringify(output.evidence),
                    },
                    observedHead,
                    evidence: output.evidence,
                    reason: output.reason,
                    validation: [],
                    failedAttempts: history,
                  };
                }
                if (!diff) throw new Error('fixed claim has no candidate edit');
                const related = await runChecks(candidate, finding, true);
                const feedback = OutcomeSchema.parse(
                  await invoke(
                    finding,
                    tier,
                    attempt,
                    'feedback',
                    parent,
                    candidate,
                    `related-check feedback\nConfirm this candidate fix for ${JSON.stringify(finding)}. Candidate tree ${tree}, parent ${parent}. Checks: ${JSON.stringify(related)}. Read only; return fixed only if the finding is addressed.`,
                    role,
                    false,
                    prior,
                    undefined,
                    undefined,
                    related,
                  ),
                );
                if (feedback.disposition !== 'fixed')
                  throw new Error(`feedback did not confirm fix: ${feedback.reason}`);
                const broader = await runChecks(candidate, finding, false);
                const message = `fix(review): Address ${finding.id.replace(/[\r\n]/g, ' ')}\n\nOutcome: code-bug\nConfidence: 90\nTested: configured related and broader checks\n${formatCqTrailers(
                  [
                    ['Cq-Run', runPrefix],
                    ['Cq-Unit', `review/${dispatch!.slug}`],
                    // Review finding ids are caller-supplied paths that may
                    // contain newlines (existing commits sanitize the subject
                    // the same way); a trailer is a single physical line, so
                    // sanitize before the shared writer.
                    ['Cq-Task', finding.id.replace(/[\r\n]+/g, ' ')],
                    ['Cq-Attempt', String(dispatch!.ordinal)],
                    ['Cq-Tier', tier],
                    // Attribution must record the model the driver actually
                    // resolved, not the configured role (invoke() stamps
                    // editingRow.model from resolved.modelSpec).
                    ['Cq-Model', `${editingRow!.model.provider}/${editingRow!.model.model}`],
                  ],
                )}`;
                const gates = await Promise.all(
                  baseline.map((base, index) =>
                    validateFix({
                      baseline: base,
                      related: async () => related[index]!,
                      broader: async () => broader[index]!,
                      relatedAccepts: (set) =>
                        // Lint and bounded tests compare stable failure identities below,
                        // including pre-existing failures in the finding file.
                        ['test-narrow', 'oxlint-json'].includes(policy.checks[index]!.adapter) ||
                        set.exitCode === 0 ||
                        (set.failures.length > 0 && !set.failures.some((f) => f.file === file)),
                      stagedPaths: [file],
                      diff,
                      message,
                      protectTests: false,
                      requireProgress: false,
                    }),
                  ),
                );
                validations.push(...gates);
                const latest = [...deps.attempts]
                  .reverse()
                  .find((row) => row.finding === finding.id);
                if (latest) latest.validation = gates;
                regression = gates.some((g) => g.regression === true);
                if (gates.some((g) => g.verdict !== 'pass'))
                  throw new Error('candidate validation refused');
                const reviewer = policy.roles.reviewer;
                if (!reviewer)
                  throw new Error('roles.reviewer required for assigned-finding closure');
                const closure = ClosureSchema.parse(
                  await invoke(
                    finding,
                    'reviewer',
                    attempt,
                    'closure',
                    parent,
                    candidate,
                    `Verify assigned-finding closure on this exact candidate. Read only. Return closed=true only if the defect described is resolved.\nFinding: ${JSON.stringify(finding)}\nCandidate tree: ${tree}\nPatch: ${diff}`,
                    reviewer,
                    false,
                    undefined,
                    undefined,
                    [
                      { path: file, text: diff },
                      { path: file, text: await git(candidate, ['show', `${parent}:${file}`]) },
                      { path: file, text: await git(candidate, ['show', `${tree}:${file}`]) },
                    ],
                  ),
                );
                if (!closure.closed)
                  throw new Error(`assigned finding remains open: ${closure.reason}`);
                stop();
                if (
                  (await git(candidate, ['write-tree'])) !== tree ||
                  (await git(candidate, ['diff', '--name-only', '-z'])) ||
                  zList(
                    await git(candidate, ['ls-files', '-z', '--others', '--exclude-standard']),
                  ).filter(
                    (path) =>
                      !(
                        dependencies &&
                        (path === 'node_modules' || path.startsWith('node_modules/'))
                      ),
                  ).length > 0
                )
                  throw new AddressRefusal('check or feedback mutated candidate', true);
                if ((await git(root, ['rev-parse', 'HEAD'])) !== parent)
                  throw new AddressRefusal('verified parent changed during candidate gates', true);
                if (!(await readFile(await safeFile(root, file))).equals(content))
                  throw new AddressRefusal('worker file changed after candidate snapshot', true);
                await git(root, ['add', '--', file]);
                if (
                  zList(await git(root, ['diff', '--cached', '--name-only', '-z'])).some(
                    (p) => p !== file,
                  )
                )
                  throw new AddressRefusal('staging absorbed sibling paths', true);
                await git(root, ['commit', '-m', message]);
                commitCreated = true;
                // Verification is bookkeeping for an already-created commit. It
                // must settle even when cancellation has stopped new admissions.
                const commit = deps.terminalBinding
                  ? await checkpointAddressTerminalWorker(deps.terminalBinding, root, undefined, {
                      parent,
                      tree,
                    })
                  : await git(root, ['rev-parse', 'HEAD']);
                if (
                  !deps.terminalBinding &&
                  ((await git(root, ['rev-parse', `${commit}^`])) !== parent ||
                    (await git(root, ['rev-parse', `${commit}^{tree}`])) !== tree)
                )
                  throw new AddressRefusal('commit does not match gated parent/tree', true);
                verifiedHeads.add(commit);
                touched = false;
                const accepted: AddressFix = {
                  finding: {
                    ...finding,
                    status: 'fixed',
                    reason: closure.reason,
                    evidence: commit,
                  },
                  observedHead,
                  validatedParent: parent,
                  commit,
                  reason: closure.reason,
                  validation: gates,
                  failedAttempts: history,
                };
                // The fix is complete and its commit verified; a later
                // bookkeeping fault must not hide it or re-dispatch the unit.
                committedFix = accepted;
                for (let i = 0; i < baseline.length; i++)
                  state = recordFixedFailures(state, baseline[i]!, broader[i]!);
                if (deps.terminalBinding && terminalAttempt) {
                  releaseAddressTerminalAttempt(deps.terminalBinding, terminalAttempt);
                  terminalAttempt = undefined;
                }
                return accepted;
              } finally {
                await (deps.terminalBinding
                  ? addressTerminalCandidate(deps.terminalBinding, root, candidate, true)
                  : git(root, ['worktree', 'remove', '--force', candidate]));
              }
            }, admitMutation).catch(async (error: unknown) => {
              reason = error instanceof Error ? error.message : String(error);
              if (committedFix !== undefined) {
                // The verified commit landed; report it instead of a deferred
                // row that hides the commit and invites a paid retry.
                const annotated = `${committedFix.reason}; post-commit bookkeeping failed: ${reason}`;
                return {
                  ...committedFix,
                  reason: annotated,
                  finding: { ...committedFix.finding, reason: annotated },
                };
              }
              if (error instanceof AddressRefusal) {
                refusal = error;
                attemptRefusal = error;
                if (error.fatal) fatal = reason;
              } else if (commitCreated) {
                // A commit exists but its verification did not settle: fail the
                // unit as terminal rather than re-dispatching it.
                refusal = new AddressRefusal(
                  `post-commit bookkeeping failed: ${reason}`,
                  true,
                  'tamper',
                );
                attemptRefusal = refusal;
                fatal = refusal.message;
              }
              await restore();
              return undefined;
            });
            if (accepted) return accepted;
            if (refusal) return failed(reason);
          }
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
          if (error instanceof AddressRefusal && error.fatal) fatal = reason;
          try {
            await restore();
          } catch (restoreError) {
            fatal = `evidence restore refused: ${String(restoreError)}`;
            return failed(`${reason}; ${fatal}`);
          }
          return failed(reason);
        } finally {
          active.delete(file);
          unitDeadlines.delete(finding.id);
        }
      } finally {
        inFlightFixes.delete(fixSettled);
        releaseFix();
      }
    },
  };
}
