// Dev lane — `dev.review`: ONE pre-PR review cycle with recorded evidence
// (strategy §3, dev.review row; §6 "Now": one CodeRabbit cycle, D-J).
// docs/coderabbit-review.md is the protocol this op mechanizes:
//
//   1. THE BASE PIN: `merge-base(origin/<target>, HEAD)`, or an explicit
//      base resolved once to a commit sha (workState.ts).
//   2. THE SECRET SCAN GATES THE UPLOAD: every diff component the reviewer
//      can upload — each file's committed (base..HEAD), staged and unstaged
//      patch, and every untracked non-ignored file — is scanned BEFORE the
//      reviewer runs. Patches are read with `--text`, so binary files
//      contribute their removed and added bytes like any other file. Any
//      hit, oversized component, or scanner fault refuses the review.
//   3. THE HOST LOCK: the CLI reviewer is the scarce quota; cycles serialize
//      host-wide.
//   4. COMPLETION HONESTY: the recorded completion is what actually
//      happened — terminal, or blocked with the reason (coderabbit.ts). A
//      blocked cycle is still recorded but never counts toward readiness.
//   5. THE EVIDENCE: the raw stream log is saved OUTSIDE the repository; the
//      cycle record carries the log path, base, head, dirty identity, and
//      the normalized findings.
//
// DRIFT, NOT ISOLATION (strategy §2.4): the reviewer reads the live
// worktree. The identity is re-read after the components are captured, on
// entering the lock, and after the run; any drift refuses the cycle and
// nothing is recorded. This catches the implementor's own accidental edits
// during a long review. It is not a boundary against a concurrent process
// on the same machine — author evidence is a claim, and verification is
// required CI plus the reviewer bots at the exact head.
//
// THE REVIEWER CHOICE IS CONFIGURATION (strategy §2.7): `coderabbit` (the
// default) or `agent:<role>`, resolved from cq.json and run with the configured
// reviewer role.
//
// ONE OP, TWO ACTIONS: no action (or `cycle`) runs this module's review
// cycle; `enroll | status | fallback` runs the author-admission transport
// (review-transport.ts, unchanged from #332 — same wire shapes, same crq
// invocation `cq dev.review --action=enroll …`).
import type { Op, OpResult } from '../../kernel/types.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentReviewReport, AgentReviewResult } from '../review/agentReviewer.js';
import {
  isCoverageV2Complete,
  ReviewCoverageV2Schema,
  type ReviewCoverageV2,
} from '../review/internal/reviewCoverageV2.js';
import { LegacyReviewCoverageSchema } from '../review/internal/reviewPartitions.js';
import { HARDENED_DIFF_FLAGS } from '../../shared/gitHarden.js';
import {
  CODERABBIT_REVIEWER,
  coderabbitReviewArgv,
  decideCompletion,
  isTransientReviewerFailure,
  parseReviewerStream,
} from './coderabbit.js';
import type { ComponentScan, DiffSecretScanner, ScanComponentInput } from './denylist.js';
import type { CommandResult, DevEffects } from './effects.js';
import { faultText, guardDevOp } from './effects.js';
import {
  DEFAULT_DEV_TARGET,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  DEV_LEDGER_VERSION,
  type DevCycleRecord,
  type DevFinding,
  type DevReviewCompletion,
} from './record.js';
import { DevCycleInputSchema, type DevTransportInput } from './registry.js';
import {
  AUTHOR_TRANSPORT_HINT,
  makeAuthorAdmission,
  type AuthorDecision,
  type AuthorTransport,
} from './review-transport.js';
import {
  driftSince,
  git,
  gitStdout,
  readWorkState,
  zList,
  type WorkState,
} from './internal/workState.js';

/** Per-component scan cap: a bigger file patch or untracked file is refused, never truncated. */
export const SCAN_COMPONENT_CAP_BYTES = 4 * 1024 * 1024;

/** The immutable identity a terminal review's coverage must attest. */
export interface AgentReviewCoverageExpectation {
  head: string;
  base: string;
  scope: 'full' | 'uncommitted';
}

/**
 * A coverage proof is engine evidence, not a model claim. v2 must validate and
 * cover every piece; legacy v1 is report-only because it cannot prove delivery
 * through the current wire seam.
 */
export type AgentReviewCoverageVerdict =
  | { ok: true; coverage: ReviewCoverageV2 }
  | { ok: false; reason: string; legacy: boolean };

/** Independently verify the engine's coverage before it may settle a terminal review. */
export function verifyAgentReviewCoverage(
  coverage: unknown,
  expected: AgentReviewCoverageExpectation,
): AgentReviewCoverageVerdict {
  if (coverage === undefined || coverage === null)
    return { ok: false, reason: 'agent review returned no coverage evidence', legacy: false };
  const v2 = ReviewCoverageV2Schema.safeParse(coverage);
  if (v2.success) {
    if (!isCoverageV2Complete(v2.data))
      return { ok: false, reason: 'agent review coverage is incomplete', legacy: false };
    if (
      v2.data.head !== expected.head ||
      v2.data.base !== expected.base ||
      v2.data.scope !== expected.scope
    )
      return {
        ok: false,
        reason: `agent review coverage does not match the reviewed record (coverage head ${v2.data.head}, base ${v2.data.base}, scope ${v2.data.scope})`,
        legacy: false,
      };
    return { ok: true, coverage: v2.data };
  }
  const legacy = LegacyReviewCoverageSchema.safeParse(coverage);
  if (legacy.success) {
    if (
      legacy.data.head !== expected.head ||
      legacy.data.base !== expected.base ||
      legacy.data.scope !== expected.scope
    )
      return {
        ok: false,
        reason: 'legacy agent review coverage does not match the reviewed record',
        legacy: true,
      };
    if (!legacy.data.partitions.every((partition) => partition.complete))
      return { ok: false, reason: 'legacy agent review coverage is incomplete', legacy: true };
    return {
      ok: false,
      reason:
        'legacy v1 agent review coverage is report only; a terminal review requires v2 delivery evidence',
      legacy: true,
    };
  }
  return { ok: false, reason: 'agent review coverage failed validation', legacy: false };
}

/**
 * Human-readable evidence for a review log. It keeps mode, coverage version,
 * exclusions (with their deterministic assurance), limitations and advisories
 * visible without making a consumer parse the JSON blob.
 */
export function renderAgentReviewEvidence(report: AgentReviewReport | undefined): string[] {
  if (report === undefined)
    return ['coverage: none', 'exclusions: none', 'limitations: none', 'advisories: none'];
  const coverage = report.coverage as unknown;
  const record =
    coverage !== null && typeof coverage === 'object' ? (coverage as Record<string, unknown>) : {};
  const version = typeof record['version'] === 'number' ? record['version'] : 1;
  const mode = typeof record['mode'] === 'string' ? record['mode'] : 'legacy';
  const modeReason = typeof record['modeReason'] === 'string' ? record['modeReason'] : '';
  const pieces = Array.isArray(record['pieces'])
    ? (record['pieces'] as {
        path?: unknown;
        state?: unknown;
        exclusion?: { rule?: unknown; assuredBy?: unknown; limitation?: unknown };
      }[])
    : [];
  const excluded = pieces.filter((piece) => piece.state === 'excluded');
  const limitations = report.limitations ?? [];
  const advisories = report.advisories ?? [];
  const exclusions = excluded.map((piece) => {
    const exclusion = piece.exclusion ?? {};
    const rule = typeof exclusion.rule === 'string' ? exclusion.rule : 'unknown rule';
    const assurance =
      typeof exclusion.assuredBy === 'string'
        ? `assuredBy=${exclusion.assuredBy}`
        : typeof exclusion.limitation === 'string'
          ? `limitation=${exclusion.limitation}`
          : 'no assurance';
    return `${typeof piece.path === 'string' ? piece.path : 'unknown path'} (${rule}; ${assurance})`;
  });
  return [
    `coverage: v${String(version)} mode=${mode}${modeReason === '' ? '' : ` (${modeReason})`}`,
    `coverage pieces: ${String(pieces.length)} total, ${String(excluded.length)} excluded`,
    `exclusions: ${exclusions.length > 0 ? exclusions.join('; ') : 'none'}`,
    `limitations: ${limitations.length > 0 ? limitations.join('; ') : 'none'}`,
    `advisories: ${advisories.length > 0 ? advisories.join('; ') : 'none'}`,
    `coverage evidence: ${JSON.stringify(report.coverage)}`,
  ];
}

/** Input of the `dev.review` cycle action (plain JSON; the registry schema mirrors it). */
export interface DevCycleInput {
  /** Repository the review runs in (the subprocess effects bind to it). */
  repoRoot: string;
  /** The cycle action — the default when `action` is absent. */
  action?: 'cycle';
  /** The intended PR target branch (default: the documented queue target). */
  target?: string;
  /** Explicit immutable base sha overriding the merge-base pin. */
  base?: string;
  /** The reviewer choice: `coderabbit` (default) or `agent:<role>`. */
  reviewer?: string;
  /** Review only staged+unstaged work (the protocol's --uncommitted scope). */
  uncommitted?: boolean;
  /** Opt the cycle's dev.check legs into the integration suite. */
  includeIntegration?: boolean;
  /** Name the exact test files the cycle's dev.check legs run. */
  testFiles?: string[];
}

/**
 * Input of the ONE `dev.review` op: the review cycle above, or the
 * author-admission transport (`enroll | status | fallback`, pinned by
 * `DevTransportInputSchema`, unchanged from #332).
 */
export type DevReviewInput = DevCycleInput | DevTransportInput;

/** The injected surface of the `dev.review` op. */
export interface DevReviewDeps {
  /** The subprocess effects (cycle action only). */
  effects: DevEffects;
  /** Composition-owned cancellation/deadline; cleanup and evidence writes remain enabled. */
  signal?: AbortSignal;
  remainingWallMs?: () => number;
  /** The composed pre-upload secret scanner (cycle action only). */
  scanSecrets: DiffSecretScanner;
  /** Configured rule corpus, excluded from scan input and refused if changed. */
  patternsFile?: string;
  /** The configured, read-only agent reviewer used by `agent:<role>`. */
  runAgentReviewer?: (input: {
    repoRoot: string;
    head: string;
    branch: string;
    role: string;
    diff: string;
    components: readonly ScanComponentInput[];
    base: string;
    scope: 'full' | 'uncommitted';
  }) => Promise<AgentReviewResult>;
  /**
   * The author-admission transport (admission actions). When omitted, the
   * admission actions report the configuration gap.
   */
  transport?: AuthorTransport;
}

/** The dev.review report — the ok value of a TERMINAL cycle. */
export interface DevReviewReport {
  cycleId: string;
  reviewer: string;
  scope: 'full' | 'uncommitted';
  /** The intended PR target the cycle was recorded against. */
  target: string;
  base: string;
  head: string;
  dirtySha256: string;
  completion: DevReviewCompletion;
  findings: DevFinding[];
  /** Report context only: never dispatched or counted as blocking findings. */
  advisories: string[];
  logPath: string;
  untracked: string[];
  at: string;
}

/**
 * Build the ONE `dev.review` op. An admission action routes to the
 * author-admission transport and never touches the repo; anything else is
 * the review cycle (whose schema refuses an unknown action).
 */
export function makeDevReview(
  deps: DevReviewDeps,
): Op<DevReviewInput, DevReviewReport | AuthorDecision> {
  const cycle = makeReviewCycle(
    deps.effects,
    deps.scanSecrets,
    deps.runAgentReviewer,
    deps.patternsFile,
    deps.signal,
    deps.remainingWallMs,
  );
  return async (input) => {
    if (isAdmissionInput(input)) {
      if (deps.transport === undefined) {
        return { status: 'needs-human', reason: AUTHOR_TRANSPORT_HINT };
      }
      return makeAuthorAdmission(deps.transport)(input);
    }
    return cycle(input as DevCycleInput);
  };
}

/** The admission branch of the union (the registry dispatch uses the same test). */
export function isAdmissionInput(input: unknown): input is DevTransportInput {
  if (typeof input !== 'object' || input === null) return false;
  const action = (input as { action?: unknown }).action;
  return action === 'enroll' || action === 'status' || action === 'fallback';
}

function needsHuman(reason: string): OpResult<never> {
  return { status: 'needs-human', reason: `dev.review: ${reason}` };
}

/** The review cycle over injected effects and the injected secret scanner. */
function makeReviewCycle(
  effects: DevEffects,
  scanSecrets: DiffSecretScanner,
  runAgentReviewer?: DevReviewDeps['runAgentReviewer'],
  patternsFile?: string,
  signal?: AbortSignal,
  remainingWallMs?: () => number,
): Op<DevCycleInput, DevReviewReport> {
  return guardDevOp('dev.review', DevCycleInputSchema, async (input) => {
    const target = input.target ?? DEFAULT_DEV_TARGET;
    const scope = input.uncommitted === true ? 'uncommitted' : 'full';
    const reviewer = input.reviewer ?? CODERABBIT_REVIEWER;
    const isAgent = reviewer.startsWith('agent:');
    if (reviewer !== CODERABBIT_REVIEWER && !isAgent)
      return needsHuman(`unsupported reviewer '${reviewer}'`);
    if (isAgent && runAgentReviewer === undefined)
      return needsHuman('the configured agent reviewer is unavailable');

    const read = await readWorkState(effects, {
      target,
      ...(input.base !== undefined ? { base: input.base } : {}),
    });
    if (!read.ok) return needsHuman(read.reason);
    const state = read.state;

    const collected = await collectScanComponents(
      effects,
      state,
      scope,
      input.repoRoot,
      patternsFile,
    );
    if (!collected.ok) return needsHuman(`review refused — ${collected.reason}`);
    if (collected.excludedPaths.length > 0) {
      return needsHuman(
        `review refused — changed file(s) excluded from the pre-upload scan cannot be uploaded safely: ${collected.excludedPaths.join(', ')}`,
      );
    }
    if (collected.paths === 0) {
      return needsHuman(
        'no diff to review — the selected scope is empty (stage or commit the work first, or pass the right scope)',
      );
    }
    const refuseDrift = async (when: string): Promise<void> => {
      const drifted = await driftSince(effects, state);
      if (drifted.length > 0) {
        throw new Error(
          `${drifted.join('; ')} ${when} — the record would not describe what the reviewer saw; re-run dev.review on a stable tree`,
        );
      }
    };

    let scans: ComponentScan[];
    try {
      await refuseDrift('while the scan components were read');
      scans = await scanSecrets(collected.components);
    } catch (err) {
      return needsHuman(`the secret scan could not complete — review refused: ${faultText(err)}`);
    }
    const flagged = scans.flatMap((scan) =>
      scan.hits.map((hit) => `${hit.ruleId} in ${scan.component} (lines ${hit.lines.join(', ')})`),
    );
    if (flagged.length > 0) {
      return needsHuman(
        `secret scan found denylist-class content — review refused, remove it and re-run: ${flagged.join('; ')}`,
      );
    }

    // The run under the HOST lock; the completion is decided and the log
    // written inside the span, the record appended after it.
    const at = effects.nowIso();
    const argv = coderabbitReviewArgv(state.base, scope);
    let span: {
      completion: DevReviewCompletion;
      logPath: string;
      findings: Omit<DevFinding, 'id'>[];
      advisories: string[];
      /** The block came from the network/transient class (#509): a re-review may retry it. */
      transient?: boolean;
      /** The wall budget itself (remainingWallMs spent) stopped the CLI, rather than a safety or provider refusal; a parent cancel (sibling-leg failure, user interrupt) never sets it. */
      budgetStopped?: true;
    };
    try {
      span = await effects.withHostLock(async () => {
        signal?.throwIfAborted();
        await refuseDrift('while waiting for the review lock');
        if (isAgent) {
          const role = reviewer.slice('agent:'.length);
          if (!role) throw new Error('agent reviewer role is empty');
          const result = await runAgentReviewer!({
            repoRoot: input.repoRoot,
            head: state.head,
            branch: state.branch,
            diff: collected.components.map((component) => component.text).join('\n'),
            role,
            components: collected.components,
            base: scope === 'uncommitted' ? state.head : state.base,
            scope,
          });
          await refuseDrift('during the agent review run');
          const report = result.status === 'ok' ? result.value : result.report;
          const coverage = verifyAgentReviewCoverage(report?.coverage, {
            head: state.head,
            base: scope === 'uncommitted' ? state.head : state.base,
            scope,
          });
          const completion: DevReviewCompletion =
            result.status === 'ok'
              ? coverage.ok
                ? { kind: 'terminal' }
                : {
                    kind: 'blocked',
                    reason: `agent review returned no verifiable coverage proof — ${coverage.reason}`,
                  }
              : {
                  kind: 'blocked',
                  reason:
                    result.status === 'needs-human'
                      ? result.reason
                      : result.status === 'failed'
                        ? result.error
                        : result.status,
                };
          const findings = report?.findings ?? [];
          const advisories = report?.advisories ?? [];
          const logPath = await effects.writeReviewLog(
            state.branch,
            `${Date.now()}`,
            [
              '# dev.review agent cycle log',
              `reviewer: ${reviewer}`,
              `base: ${state.base}`,
              `head: ${state.head}`,
              `dirtySha256: ${state.dirtySha256}`,
              `scope: ${scope}`,
              `completion: ${completion.kind}`,
              `findings: ${String(findings.length)}`,
              ...renderAgentReviewEvidence(report),
              `usage: ${report?.usage ?? 0}`,
              `at: ${at}`,
              '',
            ].join('\n'),
          );
          return {
            completion,
            logPath,
            findings: findings.map((finding) => ({
              severity: finding.severity,
              ...(finding.file ? { fileName: finding.file } : {}),
              excerpt: finding.text,
            })),
            advisories,
            ...(result.status === 'needs-human' && report?.transient === true
              ? { transient: true }
              : {}),
          };
        }
        const timeoutMs = Math.min(DEFAULT_REVIEWER_TIMEOUT_MS, remainingWallMs?.() ?? Infinity);
        if (timeoutMs <= 0) throw new Error('review wall budget exhausted before dispatch');
        const raw = await runReviewer(effects, argv, timeoutMs, signal);
        await refuseDrift(
          'during the review run (content the scan never saw may have been uploaded)',
        );
        // A killed run is blocked, but whatever findings it emitted before
        // the kill are still recorded: they stay open until dispositioned.
        const parsed = parseReviewerStream(raw.stdout);
        const ordinaryCompletion =
          raw.exitCode === null ? undefined : decideCompletion(raw.exitCode, parsed);
        // budgetStopped demands evidence the WALL BUDGET alone was spent: a
        // parent cancel (sibling-leg failure, user interrupt) must never be
        // relabeled as a budget stop, even when it races a terminally
        // completed CLI run or the driver's own timeout. Budget spend via the
        // composition's signal abort is still covered, because that abort
        // implies remainingWallMs() <= 0.
        // Sample the wall budget exactly once and feed both the budget-stop
        // flag and the completion choice: a second, later reading inside the
        // ternary could observe expiry this check missed, yielding a
        // budget-blocked span with no budgetStopped marker — and thus no
        // report envelope — downstream.
        const wallRemainingMs = remainingWallMs?.() ?? Infinity;
        const budgetStopped =
          wallRemainingMs <= 0 &&
          (ordinaryCompletion?.kind === 'terminal' || (raw.exitCode === null && raw.timedOut));
        const completion: DevReviewCompletion =
          signal?.aborted || wallRemainingMs <= 0
            ? {
                kind: 'blocked',
                reason: `review cancelled or wall budget exhausted — ${faultText(signal?.reason ?? 'deadline elapsed')}`,
              }
            : raw.exitCode === null
              ? {
                  kind: 'blocked',
                  reason: raw.timedOut
                    ? `the reviewer CLI timed out after ${String(timeoutMs)}ms and was stopped — no review completed`
                    : `the reviewer CLI did not run — ${raw.stderr.trim().slice(0, 300)}`,
                }
              : decideCompletion(raw.exitCode, parsed);
        const logPath = await effects.writeReviewLog(
          state.branch,
          `${Date.now()}`,
          [
            '# dev.review cycle log',
            `reviewer: ${reviewer}`,
            `argv: ${CODERABBIT_REVIEWER} ${argv.join(' ')}`,
            `base: ${state.base}`,
            `head: ${state.head}`,
            `dirtySha256: ${state.dirtySha256}`,
            `scope: ${scope}`,
            `exitCode: ${raw.exitCode === null ? 'none (killed)' : String(raw.exitCode)}`,
            `timedOut: ${String(raw.timedOut)}`,
            `at: ${at}`,
            '',
            '# --- stdout (NDJSON) ---',
            raw.stdout,
            '# --- stderr ---',
            raw.stderr,
            '',
          ].join('\n'),
        );
        // #509: a dropped CLI connection (`con_err`) is the network class; a
        // cancelled or out-of-wall run never is.
        const transient =
          completion.kind === 'blocked' &&
          !signal?.aborted &&
          (remainingWallMs?.() ?? Infinity) > 0 &&
          isTransientReviewerFailure(parsed, raw);
        return {
          completion,
          logPath,
          findings: parsed.findings,
          advisories: [],
          ...(transient ? { transient: true } : {}),
          ...(budgetStopped ? { budgetStopped: true as const } : {}),
        };
      }, signal);
    } catch (err) {
      // A host-lock, drift, or log-write fault: nothing is recorded, and
      // the author re-runs. The message names the cause.
      if (!signal?.aborted && (remainingWallMs?.() ?? Infinity) > 0)
        return needsHuman(
          `the review cycle could not run to a recorded outcome — ${faultText(err)}`,
        );
      const reason = `review cancelled or wall budget exhausted — ${faultText(err)}`;
      // Cleanup is deliberately outside the cancelled execution effects.
      const logPath = await effects.writeReviewLog(state.branch, `${Date.now()}`, reason);
      span = { completion: { kind: 'blocked', reason }, logPath, findings: [], advisories: [] };
    }

    // The reviewer quota is ALREADY spent, so a store fault still reports
    // the verdict and the log path rather than burying the paid cycle.
    let record: DevCycleRecord;
    try {
      record = await effects.openLedger(state.branch).mutate((ledger) => {
        const cycleCount = ledger.records.filter((entry) => entry.kind === 'cycle').length;
        const cycleId = `c${String(cycleCount + 1).padStart(3, '0')}-${state.head.slice(0, 8)}`;
        const entry: DevCycleRecord = {
          kind: 'cycle',
          cycleId,
          reviewer,
          scope,
          target,
          base: state.base,
          head: state.head,
          dirtySha256: state.dirtySha256,
          completion: span.completion,
          findings: span.findings.map((finding, index) => ({
            ...finding,
            id: `${cycleId}#f${String(index + 1)}`,
          })),
          ...(span.advisories.length > 0 ? { advisories: span.advisories } : {}),
          logPath: span.logPath,
          untracked: state.untracked,
          at,
        };
        return {
          ledger: {
            version: DEV_LEDGER_VERSION,
            branch: ledger.branch,
            records: [...ledger.records, entry],
          },
          value: entry,
        };
      });
    } catch (err) {
      const verdict =
        span.completion.kind === 'terminal'
          ? 'the cycle TERMINAL'
          : `the cycle BLOCKED (${span.completion.reason})`;
      return {
        status: 'failed',
        error: `dev.review: ${verdict} with ${String(span.findings.length)} finding(s), but the record could not be persisted — ${faultText(err)}; log: ${span.logPath}`,
      };
    }

    if (record.completion.kind === 'blocked') {
      const blocked = needsHuman(
        `review cycle ${record.cycleId} was BLOCKED (${record.completion.reason}) — the cycle is recorded with ${String(record.findings.length)} finding(s); log: ${record.logPath}`,
      );
      // The class rides the report envelope (stripped before the strict
      // OpResult parse), never the persisted cycle record.
      return span.transient === true || span.budgetStopped === true
        ? {
            ...blocked,
            report: {
              ...(span.transient === true ? { transient: true } : {}),
              ...(span.budgetStopped === true ? { budgetStopped: true } : {}),
            },
          }
        : blocked;
    }
    return {
      status: 'ok',
      value: {
        cycleId: record.cycleId,
        reviewer,
        scope,
        target,
        base: record.base,
        head: record.head,
        dirtySha256: record.dirtySha256,
        completion: record.completion,
        findings: record.findings,
        advisories: record.advisories ?? [],
        logPath: record.logPath,
        untracked: record.untracked,
        at,
      },
    };
  });
}

/**
 * The scan components for the scope: one per (leg, path) from git's own
 * NUL-separated path list — so no patch header is parsed for a path — plus
 * one per untracked file. `paths` counts every path the scope touches
 * (including the scanner's own corpus file), so an empty scope is told
 * apart from a scope whose only change is that file.
 */
async function collectScanComponents(
  effects: DevEffects,
  state: WorkState,
  scope: 'full' | 'uncommitted',
  repoRoot: string,
  patternsFile?: string,
): Promise<
  | { ok: true; components: ScanComponentInput[]; paths: number; excludedPaths: string[] }
  | { ok: false; reason: string }
> {
  const legs: { name: string; args: string[] }[] = [
    ...(scope === 'full' ? [{ name: 'committed', args: [state.base, state.head] }] : []),
    { name: 'staged', args: ['--cached'] },
    { name: 'unstaged', args: [] },
  ];
  const components: ScanComponentInput[] = [];
  const excludedPaths: string[] = [];
  const configuredPatternsPath =
    patternsFile === undefined
      ? undefined
      : relative(resolve(repoRoot), resolve(repoRoot, patternsFile)).split(sep).join('/');
  const excludedPath =
    configuredPatternsPath === undefined ||
    configuredPatternsPath === '..' ||
    configuredPatternsPath.startsWith('../') ||
    isAbsolute(configuredPatternsPath)
      ? undefined
      : configuredPatternsPath;
  let paths = 0;
  for (const leg of legs) {
    const names = zList(
      gitStdout(
        await git(effects, ['diff', '--name-only', '-z', ...HARDENED_DIFF_FLAGS, ...leg.args]),
        `diff --name-only (${leg.name})`,
      ),
    );
    paths += names.length;
    for (const path of names) {
      if (path === excludedPath) {
        excludedPaths.push(path);
        continue;
      }
      const text = gitStdout(
        await git(effects, ['diff', ...HARDENED_DIFF_FLAGS, ...leg.args, '--', path]),
        `diff (${leg.name}) -- ${path}`,
      );
      if (Buffer.byteLength(text) > SCAN_COMPONENT_CAP_BYTES) {
        return {
          ok: false,
          reason: `the ${leg.name} patch of '${path}' exceeds the per-file scan cap (${String(SCAN_COMPONENT_CAP_BYTES)} bytes) — split or remove it; the scan refuses rather than truncate`,
        };
      }
      components.push({ component: `${leg.name}:${path}`, text, path });
    }
  }
  paths += state.untracked.length;
  for (const path of state.untracked) {
    const file = await effects.readWorktreeFile(path, SCAN_COMPONENT_CAP_BYTES);
    if (!file.ok) {
      return {
        ok: false,
        reason: `the untracked file '${path}' cannot be scanned — ${file.reason}`,
      };
    }
    components.push({ component: `untracked:${path}`, text: file.text, path });
  }
  return { ok: true, components, paths, excludedPaths };
}

/** Run one reviewer invocation; a spawn fault becomes a synthetic killed result. */
async function runReviewer(
  effects: DevEffects,
  argv: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return effects
    .runCommand(CODERABBIT_REVIEWER, argv, { timeoutMs, ...(signal ? { signal } : {}) })
    .catch((err: unknown): CommandResult => ({
      exitCode: null,
      stdout: '',
      stderr: `spawn fault: ${faultText(err)}`,
      timedOut: false,
    }));
}
