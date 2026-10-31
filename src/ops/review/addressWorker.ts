import { randomUUID } from 'node:crypto';
import { GIT_HARDEN } from '../../shared/gitHarden.js';
import { assertAddressDependenciesIsolated } from './internal/addressDependencies.js';
import { readFile, writeFile, lstat, realpath, symlink } from 'node:fs/promises';
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
import { makeCheckRunner, subprocessRunCheck, type FailureSet } from '../gates/checkRunner.js';
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
  /** Capture and admit against a verified head without crossing an engine commit. */
  withVerifiedHead?<T>(action: (head: string) => Promise<T>): Promise<T>;
}
export interface AddressWorkerDeps {
  git: GhFn;
  drivers: DriverFactory;
  repoRoot: string;
  /** Installed caller checkout; reused only when package manifests/locks match the worker tree. */
  dependencyRoot?: string;
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
  const dependencyDirectory = async (admit: () => void) => {
    const installed = async (cwd: string) => {
      try {
        return await realpath(resolve(cwd, 'node_modules'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const local = await installed(root);
    if (local) {
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
    if (!caller) return undefined;
    const manifest = async (cwd: string, path: string) => {
      try {
        return await readFile(resolve(cwd, path), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    for (const path of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
    ]) {
      if ((await manifest(root, path)) !== (await manifest(deps.dependencyRoot, path)))
        throw new Error(
          'installed dependency root manifests/locks differ; install dependencies in the PR worktree',
        );
    }
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
  const runChecks = async (cwd: string, finding: Finding, related: boolean) => {
    const results: FailureSet[] = [];
    for (const check of policy.checks) {
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
      // The bounded test gate needs the same explicit fix scope at baseline
      // and candidate: a clean detached baseline has no git diff to discover.
      if (related || check.addressOnly === true || check.adapter === 'test-narrow') {
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
      const result = await makeCheckRunner((cmd) =>
        subprocessRunCheck(cmd, signal ? { signal } : undefined),
      )({
        adapter: check.adapter,
        command,
      });
      // Cancellation is classified only after the actual child has settled.
      stop();
      if (result.status !== 'ok') throw new Error(`configured check was ${result.status}`);
      results.push(normalizeFailurePaths(result.value, cwd, checkRoot));
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
  return {
    escalation: () => state,
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
              // Reuse installed dependencies as a trusted local runtime input.
              // Workers cannot edit this path; the candidate still owns all
              // tracked source/config and has no sibling uncommitted edits.
              const dependencies = await dependencyDirectory(admitMutation);
              if (dependencies)
                await symlink(dependencies, resolve(candidate, 'node_modules'), 'dir');
              const baseline =
                output.disposition === 'fixed' ? await runChecks(candidate, finding, false) : [];

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
                ).filter((path) => path !== 'node_modules').length > 0
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
