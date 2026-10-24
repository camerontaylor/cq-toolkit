import { randomUUID } from 'node:crypto';
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
import { validateFix, type ValidationVerdict } from '../fix/validate.js';
import {
  createEscalationState,
  nextEscalation,
  recordFixedFailures,
  type EscalationState,
} from '../fix/escalation.js';
import type { Finding } from './findings.js';

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
  evidenceRef?: string;
  evidenceSha?: string;
}
export interface AddressFix {
  finding: Finding;
  observedHead: string;
  commit?: string;
  evidence?: Array<{ path: string; line: number }>;
  reason: string;
  validation: ValidationVerdict[];
}
export interface AddressWorker {
  fix(finding: Finding, round: number): Promise<AddressFix>;
  escalation(): EscalationState;
}
export interface AddressWorkerDeps {
  git: GhFn;
  drivers: DriverFactory;
  repoRoot: string;
  journalDir: string;
  policy: EffectiveCqPolicy;
  attempts: AddressAttempt[];
  remainingTokens(): number;
  remainingWallMs(): number;
  account(result: WorkerResult): void;
  scanner?: DiffSecretScanner;
  parentSignal?: AbortSignal;
}

/** One shared worker tree; only this engine may stage/commit, under a serial mutex. */
export function makeAddressWorker(deps: AddressWorkerDeps): AddressWorker {
  const { policy } = deps;
  let state = createEscalationState();
  const root = resolve(deps.repoRoot);
  const mutex = makeGitMutex({ lockPath: resolve(deps.journalDir, 'commit-mutex') });
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
    const result = await deps.git(['-C', cwd, ...args]);
    if (result.code !== 0)
      throw new Error(`git ${args[0]} refused: ${result.stderr.slice(0, 500)}`);
    return result.stdout.trim();
  };
  const stop = () => {
    if (fatal) throw new Error(fatal);
    if (deps.parentSignal?.aborted || currentJobContext()?.signal?.aborted)
      throw new Error('parent cancelled');
    if (deps.remainingTokens() <= 0 || deps.remainingWallMs() <= 0)
      throw new Error('token or wall budget exhausted');
  };
  const scan = async (text: string, contents: readonly { text: string; path?: string }[] = []) => {
    const components = [
      { component: 'request', path: 'worker-request.json', text },
      ...contents.map((content, index) => ({
        component: `content-${index}`,
        path: content.path ?? 'worker-request.json',
        text: content.text,
      })),
    ];
    const scans = await scanner(components);
    if (
      scans.length !== components.length ||
      components.some((component) => !scans.some((s) => s.component === component.component)) ||
      scans.some((s) => s.hits.length > 0)
    )
      throw new Error('upload refused: missing, failed or positive denylist scan');
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
    return full;
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
  ) => {
    stop();
    if (remainingUnit(finding) <= 0) throw new Error('unit wall budget exhausted');
    await scan(prompt);
    stop();
    const resolved = deps.drivers.resolve({
      role: tier === 'reviewer' ? 'reviewer' : 'fixer',
      modelSpec: role,
      beforeRequest: async (...args) => {
        stop();
        await scan(...args);
        stop();
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
          run: { ...defaultHarnessConfig.tools.run, enabled: false, commandPatterns: [] },
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
          toolPolicy: { mode: 'allowlist', allow: editable ? ['read', 'edit'] : ['read'] },
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
      stop();
      if (deadline.expired()) throw new Error('step wall budget exhausted');
      if (result.stopReason !== 'complete') throw new Error(`worker stopped: ${result.stopReason}`);
      return result.structuredOutput;
    } finally {
      row.wallMs = Date.now() - start;
      deadline.dispose();
    }
  };
  const runChecks = async (cwd: string, finding: Finding, related: boolean) => {
    const results: FailureSet[] = [];
    for (const check of policy.checks) {
      stop();
      if (remainingUnit(finding) <= 0) throw new Error('unit wall budget exhausted');
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
      if (related) {
        const files = relatedFilesRelativeToCheck([finding.file!], cwd, checkRoot);
        command =
          check.kind === 'static'
            ? {
                ...command,
                ...staticRelatedCheckCommand(command, check.adapter, files, check.relatedArgs),
              }
            : { ...command, ...relatedCheckCommand(command, files, check.relatedArgs) };
      }
      const result = await makeCheckRunner(subprocessRunCheck)({ adapter: check.adapter, command });
      if (result.status !== 'ok') throw new Error(`configured check was ${result.status}`);
      results.push(normalizeFailurePaths(result.value, cwd, checkRoot));
    }
    return results;
  };
  return {
    escalation: () => state,
    async fix(finding, round) {
      let observedHead = '';
      const validations: ValidationVerdict[] = [];
      const failed = (reason: string): AddressFix => ({
        finding: { ...finding, status: 'deferred', reason },
        observedHead,
        reason,
        validation: validations,
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
      const restore = async () =>
        mutex.withLock(async () => {
          if (!touched) return;
          const head = await git(root, ['rev-parse', 'HEAD']);
          if (!verifiedHeads.has(head))
            throw new Error('unexpected HEAD movement; evidence left intact');
          const indexed = (await git(root, ['diff', '--cached', '--name-only']))
            .split('\n')
            .filter(Boolean);
          if (indexed.some((path) => path !== file))
            fatal = 'worker changed the index outside its scope';
          await git(root, ['add', '--', file]);
          const sha = await git(root, ['stash', 'create']);
          if (sha) {
            const ref = `refs/cq/review-address/${randomUUID()}`;
            await git(root, ['update-ref', ref, sha]);
            const row = [...deps.attempts].reverse().find((entry) => entry.finding === finding.id);
            if (row) {
              row.evidenceRef = ref;
              row.evidenceSha = sha;
            }
          }
          await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file]);
          touched = false;
        });
      let workerUsed = 0,
        rescueUsed = 0,
        regression = false;
      let reason = 'initial finding';
      try {
        initialization ??= mutex.withLock(async () => {
          if (
            (await git(root, ['diff', '--name-only', 'HEAD'])) ||
            (await git(root, ['diff', '--cached', '--name-only']))
          )
            throw new Error('review.address requires a clean tracked worker tree');
          const unknown = (await git(root, ['ls-files', '--others', '--exclude-standard']))
            .split('\n')
            .filter((path) => path && !path.startsWith('.cq/'));
          if (unknown.length) throw new Error('review.address requires no unknown worker files');
          verifiedHeads.add(await git(root, ['rev-parse', 'HEAD']));
        });
        await initialization;
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
          observedHead = await git(root, ['rev-parse', 'HEAD']);
          if (!verifiedHeads.has(observedHead)) throw new Error('unexpected worker execution head');
          touched = true;
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
                `${next.decision.reason}\nAddress only ${file}. Never stage or commit, run commands, or edit any other path. Return fixed, rejected or deferred with a concrete reason and code evidence.\nRound ${round}. Finding: ${JSON.stringify(finding)}\nPrevious: ${reason}`,
                role,
                true,
              ),
            );
          } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
            await restore();
            if (/upload|scan|cancel|budget|denylis/i.test(reason)) return failed(reason);
            continue;
          }
          const accepted = await mutex
            .withLock(async (): Promise<AddressFix | undefined> => {
              stop();
              const parent = await git(root, ['rev-parse', 'HEAD']);
              if (!verifiedHeads.has(parent))
                throw new Error('verified parent changed outside engine');
              const index = await git(root, ['diff', '--cached', '--name-only']);
              if (index) throw new Error('worker changed the index; engine refuses staging');
              const changes = (await git(root, ['diff', '--name-only', 'HEAD']))
                .split('\n')
                .filter(Boolean);
              const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard']))
                .split('\n')
                .filter((p) => p && !p.startsWith('.cq/'));
              if ([...changes, ...untracked].some((p) => !active.has(p)))
                throw new Error('unknown or out-of-scope worker edits');
              if (
                classifyStagePaths([...changes, ...untracked], undefined, false, false).kind !==
                'clean'
              )
                throw new Error('protected worker edits');
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
                try {
                  await lstat(resolve(root, 'node_modules'));
                  await symlink(
                    resolve(root, 'node_modules'),
                    resolve(candidate, 'node_modules'),
                    'dir',
                  );
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
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
                  ),
                );
                if (!closure.closed)
                  throw new Error(`assigned finding remains open: ${closure.reason}`);
                stop();
                if (
                  (await git(candidate, ['write-tree'])) !== tree ||
                  (await git(candidate, ['diff', '--name-only'])) ||
                  (await git(candidate, ['ls-files', '--others', '--exclude-standard']))
                    .split('\n')
                    .filter((path) => path && path !== 'node_modules')
                    .join('\n')
                )
                  throw new Error('check or feedback mutated candidate');
                if ((await git(root, ['rev-parse', 'HEAD'])) !== parent)
                  throw new Error('verified parent changed during candidate gates');
                if (!(await readFile(await safeFile(root, file))).equals(content))
                  throw new Error('worker file changed after candidate snapshot');
                await git(root, ['add', '--', file]);
                if (
                  (await git(root, ['diff', '--cached', '--name-only']))
                    .split('\n')
                    .some((p) => p !== file)
                )
                  throw new Error('staging absorbed sibling paths');
                await git(root, ['commit', '-m', message]);
                const commit = await git(root, ['rev-parse', 'HEAD']);
                if (
                  (await git(root, ['rev-parse', `${commit}^`])) !== parent ||
                  (await git(root, ['rev-parse', `${commit}^{tree}`])) !== tree
                )
                  throw new Error('commit does not match gated parent/tree');
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
                  commit,
                  reason: closure.reason,
                  validation: gates,
                };
              } finally {
                await git(root, ['worktree', 'remove', '--force', candidate]);
              }
            })
            .catch(async (error: unknown) => {
              reason = error instanceof Error ? error.message : String(error);
              if (
                /protected|out-of-scope|index|parent changed|mutated|staging absorbed|commit does not|unexpected/.test(
                  reason,
                )
              )
                fatal = reason;
              await restore();
              return undefined;
            });
          if (accepted) return accepted;
          if (
            /protected|out-of-scope|index|parent changed|mutated|staging absorbed|commit does not|upload|cancel|budget/.test(
              reason,
            )
          )
            return failed(reason);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
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
