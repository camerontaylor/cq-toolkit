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
import { toOutputSchema } from '../../driver/common/structured.js';
import { defaultHarnessConfig } from '../../harness/config.js';
import { currentJobContext } from '../../kernel/governor.js';
import { makeGitMutex } from '../../shared/gitMutex.js';
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
import { startFixerDeadline } from '../sweep/internal/fixerBudget.js';
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
import type { FailedAttemptGate } from '../sweep/taskLoop.js';

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
}

/** Only engine observations may stop retries or invalidate the shared worker tree. */
class AddressRefusal extends Error {
  constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message);
  }
}
class CheckFailure extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly scoped: boolean,
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
  // Resolve identity only inside an awaited mutation. Unused or early-refused
  // workers must not leave rejected setup promises racing checkout cleanup.
  let mutex: Promise<ReturnType<typeof makeGitMutex>> | undefined;
  const checkoutMutex = () =>
    (mutex ??= realpath(root).then(async (canonicalRoot) => {
      const result = await deps.git(['-C', canonicalRoot, 'rev-parse', '--absolute-git-dir']);
      if (result.code !== 0 || !result.stdout.trim())
        throw new Error('checkout index identity unavailable');
      return makeGitMutex({
        lockPath: resolve(await realpath(result.stdout.trim()), 'cq-review-address-mutation'),
      });
    }));
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
      throw new AddressRefusal('parent cancelled');
    if (deps.remainingTokens() <= 0 || deps.remainingWallMs() <= 0)
      throw new AddressRefusal('token or wall budget exhausted');
  };
  // Long candidate gates must not spend the cross-process retry budget
  // waiting for a healthy sibling in this worker. Rejections release the
  // FIFO too; restoration joins the same queue without skipping index protection.
  let mutations = Promise.resolve();
  const withMutation = <T>(action: () => Promise<T>, admit?: () => void): Promise<T> => {
    const pending = mutations.then(async () => {
      admit?.();
      return (await checkoutMutex()).withLock(async () => {
        // A different process may have held the lock until our budget expired.
        admit?.();
        return action();
      });
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
    if (
      !path ||
      path.startsWith('-') ||
      isAbsolute(path) ||
      path.split(/[\\/]/).some((part) => part === '..') ||
      /[*?\[\]{}]/.test(path)
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
    await assertAddressDependencyMetadata(metadataRoot, deps.dependencyRoot, admit);
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
    onDispatch?: (row: AddressAttempt) => void,
    sources: readonly { path: string; text: string }[] = [],
    diagnostics: readonly FailureSet[] = [],
  ) => {
    stop();
    if (remainingUnit(finding) <= 0) throw new AddressRefusal('unit wall budget exhausted');
    if (prior)
      prompt += `\nPrior failed-attempt patch (engine-owned feedback; do not repeat rejected changes):\n${prior.patch}`;
    const attributed = diagnosticSources(diagnostics);
    const unattributed = diagnosticMessages(diagnostics);
    const scanSet = (extra: readonly { text: string; path?: string }[] = []): ScanContent[] => {
      const set: ScanContent[] = [...extra, ...sources, ...attributed, ...(prior?.contents ?? [])];
      if (unattributed.length)
        set.push(...unattributed.map((message) => ({ text: message, diagnostic: true })));
      return set;
    };
    await scan(prompt, scanSet());
    stop();
    let requestRefusal: AddressRefusal | undefined;
    const resolved = deps.drivers.resolve({
      role: tier === 'reviewer' ? 'reviewer' : 'fixer',
      modelSpec: role,
      beforeRequest: async (text, contents = []) => {
        try {
          stop();
          await scan(text, scanSet(contents));
          stop();
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
    deps.attempts.push(row);
    onDispatch?.(row);
    const start = Date.now();
    const signals = [deps.parentSignal, currentJobContext()?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const deadline = startFixerDeadline(
      signals.length ? AbortSignal.any(signals) : undefined,
      Math.min(policy.budgets.step.wallMs, deps.remainingWallMs(), remainingUnit(finding)),
    );
    try {
      const result = await resolved.driver.run(
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
          budget: {
            maxTokens: deps.remainingTokens(),
            wallClockMs: Math.min(
              policy.budgets.step.wallMs,
              deps.remainingWallMs(),
              remainingUnit(finding),
            ),
          },
          outputSchema:
            invocation === 'closure'
              ? toOutputSchema('review.address.closure/v1', ClosureSchema)
              : toOutputSchema('review.address.outcome/v1', OutcomeSchema),
        },
        { signal: deadline.signal },
      );
      deps.account(result);
      row.usage = result.usage;
      if (result.costUSD !== undefined) row.costUSD = result.costUSD;
      if (requestRefusal) throw requestRefusal;
      stop();
      if (deadline.expired()) throw new AddressRefusal('step wall budget exhausted');
      if (result.stopReason !== 'complete') {
        if (result.stopReason === 'budget' || result.stopReason === 'aborted')
          throw new AddressRefusal(`worker stopped: ${result.stopReason}`);
        throw new Error(`worker stopped: ${result.stopReason}`);
      }
      return result.structuredOutput;
    } catch (error) {
      throw requestRefusal ?? error;
    } finally {
      row.wallMs = Date.now() - start;
      deadline.dispose();
    }
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
        if (remainingUnit(finding) <= 0) throw new AddressRefusal('unit wall budget exhausted');
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
          if (remainingUnit(finding) <= 0) throw new AddressRefusal('unit wall budget exhausted');
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
            throw new CheckFailure(
              `configured check was ${result.status} (${check.adapter}): ${detail.slice(0, 1000)}${transient ? '; transient check exit ' + String(capture?.exitCode) : ''}`,
              transient,
              findingScoped(check),
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
  const prepareDependencies = async (cwd: string, finding: Finding, admit: () => void) => {
    try {
      const dependencies = await dependencyDirectory(admit, cwd);
      if (dependencies)
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
    const dependencies = await prepareDependencies(cwd, finding, admit);
    try {
      let leg = baselineCache.get(parent);
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
      let observedHead = '';
      const history: AddressFailedAttempt[] = [];
      const validations: ValidationVerdict[] = [];
      const failed = (reason: string): AddressFix => ({
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
      let file = finding.file;
      if (!file) return failed('unanchored finding needs human scope');
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
      let editingRow: AddressAttempt | undefined;
      let restoreRefused = false;
      let dispatch:
        | { tier: 'worker' | 'rescue'; role: ModelSpec; ordinal: number; slug: string }
        | undefined;
      const admitMutation = () => {
        stop();
        if (remainingUnit(finding) <= 0) throw new AddressRefusal('unit wall budget exhausted');
      };
      const restore = async () =>
        withMutation(async () => {
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
          try {
            await writeFile(await safeFile(candidate, file), content);
            await git(candidate, ['add', '--', file]);
            const lastGate = validations
              .at(-1)
              ?.gates.find((gate) => gate.verdict !== 'pass')?.gate;
            const gate: FailedAttemptGate = /budget|cancel|aborted/.test(reason)
              ? 'budget'
              : fatal || /index|HEAD|snapshot|mutated/.test(reason)
                ? 'tamper'
                : /scope|protected/.test(reason)
                  ? 'path-policy'
                  : lastGate === 'paths'
                    ? 'path-policy'
                    : (lastGate ?? 'none');
            const outcome = gate === 'budget' || fatal ? 'escalated-to-human' : 'unfixed';
            const pinned = await pinAddressFailure((args) => git(candidate, args), {
              runPrefix,
              kind: 'review',
              slug: dispatch.slug,
              task: finding.id,
              parent: head,
              firstAttempt: dispatch.ordinal,
              tier: dispatch.tier,
              model: dispatch.role,
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
              model: dispatch.role,
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
            await git(root, ['restore', `--source=${head}`, '--staged', '--worktree', '--', file]);
          } finally {
            await git(root, ['worktree', 'remove', '--force', candidate]);
          }
          touched = false;
        }).catch((error: unknown) => {
          restoreRefused = true;
          throw error;
        });
      let workerUsed = 0,
        rescueUsed = 0,
        regression = false;
      let reason = 'initial finding';
      try {
        await initialize(admitMutation);
        await safeFile(root, file);
        const classified = classifyStagePaths([file], undefined, false, false);
        if (classified.kind !== 'clean') return failed(classified.message ?? 'protected scope');
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
          let failure: { error: unknown } | undefined;
          try {
            await prepareBaseline(candidate, baselineHead, finding, admitMutation);
          } catch (error) {
            failure = { error };
          }
          try {
            await git(root, ['worktree', 'remove', '--force', candidate]);
          } catch (cleanup) {
            if (failure) throw new BaselineCleanupError(failure.error, cleanup);
            throw cleanup;
          }
          if (failure) throw failure.error;
        }, admitMutation).catch((error: unknown) => refusePrecondition(error, 'setup', finding));
        while (true) {
          stop();
          if (Date.now() - unitStart >= policy.budgets.unit.wallMs)
            return failed('unit wall budget exhausted');
          const packageName =
            [...policy.packages]
              .sort((a, b) => b.path.length - a.path.length)
              .find((pkg) => {
                const path = relative(resolve(root, pkg.path), resolve(root, file));
                return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
              })?.name ?? policy.packages[0]!.name;
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
                (row) => {
                  touched = true;
                  editingRow = row;
                },
              ),
            );
          } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
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
              const message = `fix(review): Address ${finding.id.replace(/[\r\n]/g, ' ')}\n\nOutcome: code-bug\nConfidence: 90\nTested: configured related and broader checks`;
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
              const latest = [...deps.attempts].reverse().find((row) => row.finding === finding.id);
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
              const commit = await git(root, ['rev-parse', 'HEAD']);
              if (
                (await git(root, ['rev-parse', `${commit}^`])) !== parent ||
                (await git(root, ['rev-parse', `${commit}^{tree}`])) !== tree
              )
                throw new AddressRefusal('commit does not match gated parent/tree', true);
              verifiedHeads.add(commit);
              touched = false;
              for (let i = 0; i < baseline.length; i++)
                state = recordFixedFailures(state, baseline[i]!, broader[i]!);
              return {
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
            } finally {
              await git(root, ['worktree', 'remove', '--force', candidate]);
            }
          }, admitMutation).catch(async (error: unknown) => {
            reason = error instanceof Error ? error.message : String(error);
            if (error instanceof AddressRefusal) {
              refusal = error;
              if (error.fatal) fatal = reason;
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
    },
  };
}
