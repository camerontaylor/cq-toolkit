// Dev lane — `dev.cycle`: the pre-PR composition (strategy §3, dev.cycle
// row). ONE command composing the family's own ops over the SAME injected
// effects:
//
//   dev.check → review.run → review.address --source=local (until clean, ≤
//   review.rounds) → the FINAL dev.check at the addressed head → readiness →
//   push → pr.open.
//
// THE COMPOSITION ADDS NO POLICY OF ITS OWN: every step is the op the SDK
// and CLI dispatch. The injected deps default to the production bindings the
// registry entry carries (subprocess effects, the real driver factory,
// makeReviewRun, makeReviewAddress, makePrOpen, the real git transport); a
// test may script any of them (the fake-forge/dev-effects precedent).
//
// THE FINAL CHECK EXISTS BECAUSE ADDRESSING MOVES HEAD: review.address's
// validated commits change the identity every record is pinned to, so the
// pre-address check would read stale at the head the PR is opened from. The
// re-review the clean run ends on has already recorded a terminal cycle at
// the final head; only the deterministic gates need re-running. A red SHA
// is never drafted: a red final check is surfaced verbatim, except that a
// run with at least one verified fix may draft its newest commit passing ALL
// final gates, probed in an isolated worktree and published from a new
// branch pinned to it, the author's branch untouched (#536, Giles D2b).
//
// EXIT SHAPES (I1; the op returns taxonomy values — the CLI owns the codes):
//   - clean loop: the branch is READY at the final head → the branch is
//     pushed (opt-out `push:false`) and pr.open opens the READY PR; ok.
//   - round cap, budget, or blocked re-review: review.address's structured
//     stop carries its report — open findings with their
//     attempt logs. The findings are PUBLISHED, not buried: the branch is
//     pushed and pr.open (draft + draftWhenNotReady) opens the DRAFT whose
//     managed section carries the readiness GAPS verbatim; the open-findings
//     + attempt-log section is then composed onto the body with the SAME
//     managed-section protocol (composeSection). The op resolves needs-human
//     (CLI exit 3) and the reason carries the follow-up command
//     `cq review.address --source=pr:<n>` verbatim.
//   - any other refusal (a red check, a blocked review source without a
//     publication marker, a push or forge failure) surfaces VERBATIM and stops the cycle —
//     a composition never bypasses a step's refusal. A refusal AFTER a
//     successful publication carries the follow-up command too: the branch
//     is already on the forge.
//
// NO NARRATION FROM THE OP: stderr is the CLI's machine-mode contract
// (`--json` keeps stderr EMPTY), so the follow-up command travels in the
// report (ok) or the refusal reason (not ok) — never on a side channel.
import type { GhFn } from '../../adapters/forge-github/gh.js';
import { makeGhRunner } from '../../adapters/forge-github/gh.js';
import type { Op, OpResult } from '../../kernel/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults } from '../analyze/cqConfigDefaults.js';
import { createDriverFactory, type DriverFactory } from '../../driver/factory.js';
import type { Usage } from '../../driver/types.js';
import { composeSection, mdSafe, type PrEffects } from '../pr/assemblePrs.js';
import { makeSubprocessPrEffects } from '../../adapters/forge-github/ghEffects.js';
import type { PrOpenInput, PrOpenReport } from '../pr/open.js';
import { makePrOpen } from '../pr/open.js';
import type { ReviewAddressInput, ReviewAddressReport } from '../review/address.js';
import type { AddressFix } from '../review/addressWorker.js';
import { makeReviewAddress } from '../review/address.js';
import type { FindingsRecord } from '../review/findings.js';
import type { ReviewRunInput } from '../review/run.js';
import { makeReviewRun } from '../review/run.js';
import type { DiffSecretScanner } from './denylist.js';
import type { DevCheckInput, DevCheckReport } from './check.js';
import { makeDevCheck } from './check.js';
import type { DevEffects } from './effects.js';
import { guardDevOp, makeSubprocessDevEffects } from './effects.js';
import { DEFAULT_DEV_TARGET, devLedgerPath } from './record.js';
import { readReadinessWithGaps } from './ready.js';
import { CLEAN_TREE, readWorkState } from './internal/workState.js';
import {
  droppedFixes,
  probeLines,
  recordedFixChain,
  scanNewestFirst,
  type GreenPrefixProbe,
} from './internal/greenPrefix.js';
import { DevCycleCompositionInputSchema } from './registry.js';

/**
 * Wall time held back from the review and address legs for the publication
 * leg: the final dev.check (observed 1–2 min on the dev VM in the S7
 * dogfood), the verified push, pr.open and the findings-section compose.
 * Ten minutes is ~5× the observed gates, headroom for a loaded host, and
 * ~4% of the dogfood's 4 h run budget. A run budget under 40 min reserves a
 * quarter of itself instead, so short budgets still leave the legs time.
 */
export const DEV_CYCLE_PUBLICATION_RESERVE_MS = 10 * 60 * 1000;

/**
 * #536: wall time a green-prefix publication keeps for itself after its last
 * probe — the pinned push, pr.open, the findings compose and the worktree
 * cleanup. A probe starts only when the time left covers one more final
 * check (at the measured duration, plus a quarter) AND this margin.
 */
export const GREEN_PREFIX_PUBLICATION_MARGIN_MS = 2 * 60 * 1000;
/**
 * #536: file names (at any depth) whose change between two candidates means
 * their dependency graphs may differ, so the probe worktree is reinstalled
 * before the probe. Matched on the changed paths' basenames: the hardened git
 * runner takes literal pathspecs only (no glob magic).
 */
export const GREEN_PREFIX_DEPENDENCY_INPUTS: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'yarn.lock',
  '.npmrc',
  // pnpm hooks rewrite manifests and resolution (https://pnpm.io/pnpmfile).
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
];
/** #536: the dependency-install bound in the probe worktree (also capped by the reserve). */
export const GREEN_PREFIX_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Input of the `dev.cycle` op (plain JSON; the registry schema mirrors it). */
export interface DevCycleCompositionInput {
  /** Repository the whole cycle runs in (every effect binds to it). */
  repoRoot: string;
  /** The intended PR target branch (default: the documented queue target). */
  target?: string;
  /**
   * Push the branch before pr.open — pr.open requires a pushed head, so the
   * default true publishes the reviewed head and verifies the remote now
   * carries exactly it. `--push=false` opts out (an SDK composition that
   * publishes elsewhere); pr.open's own pushed-head rule then decides.
   */
  push?: boolean;
  /** PR title; default is the head commit's subject (pr.open's rule). */
  title?: string;
  /**
   * Opt EVERY dev.check invocation the cycle makes into the integration
   * suite (`--include-integration`) — the opening check, the stopped-run
   * re-check and the final check at the addressed head share one step
   * input, so the choice reaches all three and is recorded in each check
   * record. The `--base`/`--range` selector's closure can name gated e2e
   * files for plain src changes, and the wrapper's refusal cannot be
   * satisfied from inside dev.check — the caller opts in explicitly (S7
   * dogfood attempt A). Default off.
   */
  includeIntegration?: boolean;
  /**
   * Name the EXACT test files EVERY dev.check invocation the cycle makes
   * run — the opening check, the stopped-run re-check and the final check
   * at the addressed head share this step input (the wrapper's own escape
   * for a too-broad automatic selection): replaces the `--base`/`--range`
   * selection entirely, matching dev.check's own contract (a `range`
   * supplied alongside is refused); every check record discloses the
   * narrowing via `testSelection: { mode: 'named', files }`.
   */
  testFiles?: string[];
}

/** The dev.cycle report — the ok value (a ready, published branch). */
export interface DevCycleReport {
  branch: string;
  /** The final reviewed head the PR was opened from. */
  head: string;
  target: string;
  pr: PrOpenReport;
  /** true when this run pushed the branch (the default); false = push opted out. */
  pushed: boolean;
  /** The PR-side continuation command for the published PR. */
  followUp: string;
  /** Non-blocking review context from the published comparison. */
  advisories?: string[];
}

/** The follow-up command dev.cycle reports after publishing a PR. */
export function followUpCommand(prNumber: number, repoRoot: string, target?: string): string {
  // Safely single-quoted for the shell: an embedded quote ends the quoting.
  const quoted = `'${repoRoot.replaceAll("'", `'\\''`)}'`;
  // A non-default target changes the PR-side comparison (the address leg
  // pins its base against the cycle's target); the default is omitted so
  // the plain command stays the common case.
  const targetPart =
    target === undefined || target === DEFAULT_DEV_TARGET
      ? ''
      : ` --target='${target.replaceAll("'", `'\\''`)}'`;
  return `cq review.address --repoRoot=${quoted}${targetPart} --source=pr:${String(prNumber)}`;
}

/** The managed body section's START marker for the open-findings + attempts section. */
export const DEV_FINDINGS_SECTION_MARKER = '<!-- cq:dev-findings -->';

/**
 * One markdown-safe text line: control characters become spaces, pipes are
 * escaped for tables, and markdown DELIMITERS go through the tracker
 * manifest's `mdSafe` so a recorded finding cannot close a code span or
 * fabricate markup (the same rule pr.open's renderer applies).
 */
function mdLine(text: string): string {
  return mdSafe(
    text
      .split(/[\p{Cc}]/u)
      .join(' ')
      .replace(/\|/g, '\\|'),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The stopped run's public record: the open findings (severity and file, one
 * line each) and every attempt logged against them, markdown-safe. The
 * attempts ARE the spec's "attempt logs" — finding id, tier/invocation,
 * wall time and the worker's own reason — rendered from the address report's
 * run-wide arrays. Stopped runs only: a ready PR carries no findings section,
 * because there is nothing open to list.
 */
export function renderFindingsSection(
  report: ReviewAddressReport,
  selection?: GreenPrefixSelection,
): string {
  // Name the structured stop that triggered this draft publication.
  const blocked = report.stop === 'rereview-blocked';
  const budget = report.stop === 'budget';
  // #536: a clean address run whose final gates were red has no stop marker.
  const redFinal = selection !== undefined && report.stop === undefined;
  const lines: string[] = [
    DEV_FINDINGS_SECTION_MARKER,
    redFinal
      ? '<!-- cq-toolkit dev findings (generated by dev.cycle after red final gates; updated in place, never duplicated) -->'
      : blocked
        ? '<!-- cq-toolkit dev findings (generated by dev.cycle after a blocked re-review; updated in place, never duplicated) -->'
        : budget
          ? '<!-- cq-toolkit dev findings (generated by dev.cycle after a run budget stop; updated in place, never duplicated) -->'
          : '<!-- cq-toolkit dev findings (generated by dev.cycle at the review round cap; updated in place, never duplicated) -->',
    redFinal
      ? '## Findings after red final gates — author evidence'
      : blocked
        ? '## Findings after a blocked re-review — author evidence'
        : budget
          ? '## Open findings after a run budget stop — author evidence'
          : '## Open findings at the review round cap — author evidence',
    '',
    redFinal
      ? `> review.address finished clean with ${String(report.fixesPerRun)} verified fix(es), but the final gates were red at the addressed head; ${String(report.openBlocking.length)} open blocking finding(s) at that head; every attempt below was logged by the engine.`
      : blocked
        ? `> review.address made ${String(report.fixesPerRun)} verified fix(es), then its re-review stayed blocked on a network/transient class after one retry, so these findings are UNVERIFIED by a fresh review: ${mdLine(report.reasons.at(-1) ?? 're-review blocked')}. ${String(report.openBlocking.length)} open blocking finding(s); every attempt below was logged by the engine.`
        : budget
          ? `> review.address stopped on the run budget with ${String(report.openBlocking.length)} open blocking finding(s); every attempt below was logged by the engine.`
          : `> review.address stopped at its round cap with ${String(report.openBlocking.length)} open blocking finding(s); every attempt below was logged by the engine.`,
    '',
    ...(selection === undefined ? [] : greenPrefixLines(selection)),
    '- open blocking findings:',
  ];
  if (report.openBlocking.length === 0) lines.push('  - (none)');
  for (const finding of report.openBlocking) {
    lines.push(
      `  - \`${mdLine(finding.id)}\` (${mdLine(finding.severity)}${finding.file === undefined ? '' : `, \`${mdLine(finding.file)}\``}) — ${mdLine(finding.text)}`,
    );
  }
  lines.push('- attempt log:');
  if (report.attempts.length === 0) lines.push('  - (no attempts were dispatched)');
  for (const attempt of report.attempts) {
    lines.push(
      `  - \`${mdLine(attempt.finding)}\` ${attempt.tier}/${attempt.invocation} #${String(attempt.attempt)} — ${mdLine(attempt.reason)} (${mdLine(attempt.model.model)}${attempt.usage === undefined ? '' : `, tokens ${String(attempt.usage.input + attempt.usage.output)}`}, ${String(attempt.wallMs)}ms)`,
    );
  }
  lines.push('<!-- /cq:dev-findings -->');
  return lines.join('\n');
}

/** #536: what a draft published at an earlier, green verified-fix commit carries. */
export interface GreenPrefixSelection {
  /** The published commit: the newest verified-fix commit passing ALL final gates. */
  head: string;
  /** The addressed head whose final gates were red. */
  addressedHead: string;
  /** The final gates that were red at the addressed head. */
  redGates: readonly string[];
  /** The verified fixes committed after `head` — not in the draft. */
  dropped: readonly AddressFix[];
  /** Every probe, newest candidate first. */
  probes: readonly GreenPrefixProbe[];
  /**
   * The author's ledger at the abandoned tip (Giles D2c): referenced by path
   * and content hash only. Its deferred debt, coverage, dispositions and
   * receipts are NOT bound to the published commit and stay unacknowledged.
   */
  authorLedger: { path: string; sha256: string };
}

/**
 * The selection block: where the draft was published and what it leaves out.
 * The findings listed after it stay review.address's view at the ADDRESSED
 * head — carried over, never re-reviewed at the published commit — and the
 * dropped fixes' findings are named separately as a conservative carryover
 * (treat them as open at the published commit), never as a new review result.
 */
function greenPrefixLines(selection: GreenPrefixSelection): string[] {
  const lines = [
    `> PUBLISHED AT \`${selection.head}\`, the newest verified-fix commit that passed ALL final gates. The addressed head \`${selection.addressedHead}\` failed them (red: ${mdLine(selection.redGates.join(', ') || 'see the dev-record')}). The findings and attempts below are review.address's record at the addressed head, carried over and NOT re-reviewed at the published commit.`,
    '',
    '- dropped fixes (committed after the published commit, so NOT in this draft; conservative carryover — treat their findings as open here):',
  ];
  if (selection.dropped.length === 0) lines.push('  - (none)');
  for (const fix of selection.dropped) {
    lines.push(
      `  - \`${mdLine(fix.commit ?? '(no commit)')}\` \`${mdLine(fix.finding.id)}\` (${mdLine(fix.finding.severity)}, recorded ${mdLine(fix.finding.status)}) — ${mdLine(fix.finding.text)}`,
    );
  }
  lines.push(
    `- unbound deferred debt from the abandoned tip; not acknowledged: the author ledger \`${mdLine(selection.authorLedger.path)}\` (sha256 \`${selection.authorLedger.sha256}\`) at \`${selection.addressedHead}\` — nothing in it (deferred debt, coverage, dispositions, receipts) is bound to this draft.`,
  );
  lines.push('- final-gate probes (newest candidate first):');
  for (const line of probeLines(selection.probes)) lines.push(`  - ${mdLine(line)}`);
  lines.push('');
  return lines;
}

/** What a step's non-ok result says, per the frozen taxonomy. */
function issue(result: OpResult<unknown>): string {
  return result.status === 'needs-human'
    ? result.reason
    : result.status === 'failed'
      ? result.error
      : result.status === 'indeterminate'
        ? result.detail
        : result.status;
}

/**
 * Retag one step result with the leg that produced it (a composition's
 * refusal names WHERE it stopped), keeping the frozen variant's shape.
 */
function stepResult(
  leg: string,
  result: OpResult<unknown>,
):
  | Extract<OpResult<never>, { status: 'needs-human' }>
  | Extract<OpResult<never>, { status: 'failed' }>
  | Extract<OpResult<never>, { status: 'indeterminate' }>
  | Extract<OpResult<never>, { status: 'budget-exhausted' }> {
  const text = issue(result);
  const prefix = `dev.cycle (${leg}): `;
  if (result.status === 'failed') return { status: 'failed', error: `${prefix}${text}` };
  if (result.status === 'indeterminate')
    return { status: 'indeterminate', detail: `${prefix}${text}` };
  if (result.status === 'budget-exhausted') return { status: 'budget-exhausted' };
  return { status: 'needs-human', reason: `${prefix}${text}` };
}

/** The composition's injected steps (all defaulting to the production ops). */
export interface DevCycleDeps {
  effects: DevEffects;
  /** The deterministic gate leg (default: makeDevCheck over the effects). */
  check?: (input: DevCheckInput) => Promise<OpResult<DevCheckReport>>;
  /** The findings producer (default: the production review.run). */
  review?: (input: ReviewRunInput) => Promise<OpResult<FindingsRecord>>;
  /** The address leg (default: the production review.address). */
  address?: (
    input: ReviewAddressInput,
  ) => Promise<OpResult<unknown> & { report?: ReviewAddressReport }>;
  /** The publication leg (default: the production pr.open over the effects). */
  open?: (input: PrOpenInput) => Promise<OpResult<PrOpenReport>>;
  /**
   * The forge effects the DEFAULT publication leg binds and the findings
   * section compose uses (production: makeSubprocessPrEffects). When `open`
   * is injected WITHOUT `gh`, the injected leg OWNS the forge — the
   * composition performs no direct body edit at all (a production-gh
   * fallback could edit an unrelated PR), so the injected leg is
   * responsible for publishing the findings section itself.
   */
  gh?: PrEffects;
  /** The secret scanner the default check leg binds (registry parity with dev.check). */
  scanSecrets?: DiffSecretScanner;
  drivers?: DriverFactory;
  /** The git transport the push leg binds (tests script it). */
  git?: GhFn;
  /**
   * #536: effects bound to ANOTHER checkout root — the isolated probe
   * worktree the red-final-gate fallback checks and publishes from (default:
   * the subprocess effects). Every gate, ledger and work-state read of that
   * worktree goes through them, so its records never touch the author's.
   */
  effectsFor?: (root: string) => DevEffects;
  /**
   * #536: install the repository's dependencies in the probe worktree
   * (bounded and abortable; no network, no fallback). The red-final-gate
   * fallback is OFF without it: a probe without dependencies would read red
   * for environmental reasons.
   */
  installDeps?: (root: string, signal: AbortSignal) => Promise<void>;
  /**
   * #536: the secret scanner for a probe worktree, built from THAT checkout's
   * own configuration (the registry's portable scanner over the given root).
   * When the author's check scans with `scanSecrets` but this is absent, the
   * fallback cannot probe (a probe never runs under another tree's rules).
   */
  scanSecretsFor?: (
    root: string,
    effects: DevEffects,
  ) => DiffSecretScanner | undefined | Promise<DiffSecretScanner | undefined>;
  /** #536: the probe worktree's check leg (default: makeDevCheck over its effects). */
  checkIn?: (
    effects: DevEffects,
    root: string,
  ) => (input: DevCheckInput) => Promise<OpResult<DevCheckReport>>;
  /** #536: the probe worktree's publication leg (default: pr.open over its effects). */
  openIn?: (
    effects: DevEffects,
    root: string,
  ) => (input: PrOpenInput) => Promise<OpResult<PrOpenReport>>;
}

/** Build the `dev.cycle` op over the injected steps. */
export function makeDevCycle(deps: DevCycleDeps): Op<DevCycleCompositionInput, DevCycleReport> {
  return guardDevOp('dev.cycle', DevCycleCompositionInputSchema, async (input) => {
    // ONE run budget across the legs (S7 attempt H): the run started here,
    // and every token a default leg's driver spends is metered here.
    const cycleStarted = Date.now();
    let spentTokens = 0;
    const drivers = meterDrivers(deps.drivers ?? createDriverFactory(), (tokens) => {
      spentTokens += tokens;
    });
    const target = input.target ?? DEFAULT_DEV_TARGET;
    const check =
      deps.check ?? ((step: DevCheckInput) => makeDevCheck(deps.effects, deps.scanSecrets)(step));
    const review = deps.review ?? ((step: ReviewRunInput) => makeReviewRun({ drivers })(step));
    // The default address leg is CONSTRUCTED with the cycle's (metered)
    // driver factory: the whole cycle honours one wiring — test transports
    // injected here must not be replaced by real provider factories inside
    // the address leg's own default construction. The UN-INJECTED path
    // shares it deliberately too (it also feeds the default review.run leg
    // above): an address leg that self-built createDriverFactory() would
    // spend tokens no meter sees, and the ONE run budget's maxTokens
    // (legBudget below) is computed from spentTokens. Sharing is safe
    // because the factory carries no per-instance state: every resolve()
    // constructs a FRESH lane instance and wrappers from immutable config
    // (env knobs are read at resolve time, never cached), and meterDrivers
    // forwards the whole one-method seam — DriverFactory is `resolve`
    // alone, Driver is `run` alone, lane/modelSpec ride the spread — so
    // the legs share the wiring, never driver state.
    const address =
      deps.address ?? ((step: ReviewAddressInput) => makeReviewAddress({ drivers })(step));
    // The forge effects for the findings-section compose: the DEFAULT
    // publication leg's own effects. When deps.open is injected WITHOUT
    // deps.gh, the injected leg owns the forge — no effects are constructed
    // (production gh against input.repoRoot could edit an unrelated PR), so
    // the composition skips the direct body edit entirely (v9bK9).
    const ownForge = deps.open === undefined || deps.gh !== undefined;
    const gh = ownForge ? (deps.gh ?? makeSubprocessPrEffects(input.repoRoot)) : undefined;
    const open =
      deps.open ??
      ((step: PrOpenInput) =>
        makePrOpen(deps.effects, gh ?? makeSubprocessPrEffects(input.repoRoot))(step));
    const git =
      deps.git ?? makeGhRunner({ bin: 'git', cwd: input.repoRoot, timeoutMs: 10 * 60 * 1000 });

    // The publication leg's shared precondition: the branch on the forge at
    // exactly the local head (the same verified-publication contract
    // pr.ensureTrackerBranch applies), run once per cycle end.
    const pushed = input.push !== false;
    const publishHead = async (
      branch: string,
      head: string,
      pinHead = false,
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      if (!pushed) return { ok: true };
      const result = await git([
        '-C',
        input.repoRoot,
        'push',
        'origin',
        `${pinHead ? head : `refs/heads/${branch}`}:refs/heads/${branch}`,
      ]);
      if (result.code !== 0)
        return {
          ok: false,
          reason: `the push of '${branch}' failed — ${(result.stderr.trim() || 'git push failed').slice(0, 500)}`,
        };
      const remote = await git([
        '-C',
        input.repoRoot,
        'ls-remote',
        'origin',
        `refs/heads/${branch}`,
      ]);
      const remoteHead = remote.stdout
        .split('\n')
        .find((line) => line.trim() !== '')
        ?.trim()
        .split(/\s+/)[0];
      if (remote.code !== 0)
        return {
          ok: false,
          reason: `the pushed head could not be verified on the remote (ls-remote failed)`,
        };
      if (remoteHead !== head)
        return {
          ok: false,
          reason: `the remote branch '${branch}' is at ${remoteHead ?? '(no head)'}, not the reviewed head ${head} — refusing to open a PR the forge does not carry`,
        };
      return { ok: true };
    };

    // ---- policy (the reviewers/severities the readiness read honours) ----
    const configText = await readFile(join(input.repoRoot, 'cq.json'), 'utf8').catch(() => null);
    let policy:
      | {
          reviewers: readonly string[];
          blockingSeverities: readonly string[];
          runWallMs: number;
          runMaxTokens: number | undefined;
        }
      | undefined;
    if (configText !== null) {
      const parsed = parseCqConfig(configText, input.repoRoot);
      if (!parsed.ok)
        return { status: 'needs-human', reason: `dev.cycle: cq.json — ${parsed.reason}` };
      const packageText = await readFile(join(input.repoRoot, 'package.json'), 'utf8').catch(
        () => '{}',
      );
      let packageName = 'repository';
      try {
        const value: unknown = JSON.parse(packageText);
        if (
          typeof value === 'object' &&
          value !== null &&
          'name' in value &&
          typeof value.name === 'string'
        )
          packageName = value.name;
      } catch {
        /* descriptive fallback only */
      }
      const configured = resolveCqConfigDefaults(parsed.config, { packageName });
      policy = {
        reviewers: configured.review.reviewers,
        blockingSeverities: configured.review.blockingSeverities,
        runWallMs: configured.budgets.run.wallMs,
        runMaxTokens: configured.budgets.run.maxTokens,
      };
    }

    // --------------------------- 1. dev.check ----------------------------
    const checkStep: DevCheckInput = {
      repoRoot: input.repoRoot,
      target,
      ...(input.includeIntegration === true ? { includeIntegration: true } : {}),
      ...(input.testFiles !== undefined ? { testFiles: input.testFiles } : {}),
    };
    const firstCheck = await check(checkStep);
    if (firstCheck.status !== 'ok') return stepResult('dev.check', firstCheck);

    // What is left of the ONE run budget for an agentic leg: the wall to the
    // run deadline minus the publication reserve (so a budget stop can still
    // run the final gates and publish), and the tokens the metered drivers
    // have not spent. Without a cq.json the legs keep their own defaults.
    // An EXHAUSTED remainder (≤ 0) yields undefined: the caller then SKIPS
    // the leg — an immediate budget stop that launches no driver — rather
    // than handing it a clamped 1 ms/1 token it can only overshoot by one
    // full driver call before its own stop() fires.
    const legBudget = (): { wallMs?: number; maxTokens?: number } | undefined => {
      if (policy === undefined) return {};
      const reserve = Math.min(DEV_CYCLE_PUBLICATION_RESERVE_MS, Math.floor(policy.runWallMs / 4));
      const wallMs = policy.runWallMs - reserve - (Date.now() - cycleStarted);
      if (wallMs <= 0) return undefined;
      const maxTokens =
        policy.runMaxTokens === undefined ? undefined : policy.runMaxTokens - spentTokens;
      if (maxTokens !== undefined && maxTokens <= 0) return undefined;
      return {
        wallMs,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      };
    };

    // --------------------------- 2. review.run ---------------------------
    const runBudget = legBudget();
    if (runBudget === undefined) return { status: 'budget-exhausted' };
    const run = await review({ repoRoot: input.repoRoot, target, ...runBudget });
    if (run.status !== 'ok') return stepResult('review.run', run);

    // ------------------ 3. review.address (until clean) ------------------
    // The comparison base is the review's pinned base (the address leg's
    // admission guards the same comparison the producer reviewed); the
    // address leg owns the rounds and its own stop reasons. Its `push`
    // option stays OFF: the composition publishes once, at the end, after
    // the final check — never mid-loop.
    const addressBudget = legBudget();
    if (addressBudget === undefined) return { status: 'budget-exhausted' };
    const addressResult = await address({
      repoRoot: input.repoRoot,
      source: 'local',
      target,
      ...(run.value.reviewed === undefined ? {} : { base: run.value.reviewed.base }),
      ...addressBudget,
    });
    if (addressResult.status !== 'ok') {
      // STRUCTURED PUBLICATION STOPS: the address leg marks its designed stop with the
      // structured `stop: 'round-cap'` marker riding the report envelope
      // (set by its own finish(); the report is the kernel-sanctioned
      // extension, stripped before the strict OpResultSchema parse — a
      // top-level result field would be an unrecognized key). The leg's
      // own finish() appends '; report: <path>' to every needs-human reason
      // — a reason string can never be matched exactly. Other budget-like refusals
      // and admission failures ALSO carry a report —
      // publishing over them would turn a failed run into
      // needs-human-with-PR — so report presence is never the trigger;
      // the structured stop is. Any other refusal propagates verbatim and
      // stops the cycle.
      //
      // Budget stops share this path, using the publication reserve for final gates.
      // BLOCKED RE-REVIEW (#509, owner 2026-10-27): the leg marks
      // `stop: 'rereview-blocked'` only when its re-review stayed blocked on
      // the network/transient class after one retry AND at least one
      // verified fix exists. Those fixes take the SAME publication path —
      // final gates first, then a DRAFT naming the blocked re-review — so a
      // late network failure no longer leaves verified work unpublished. A
      // re-review blocked on any other class (scan refusal, auth, …) still
      // propagates verbatim.
      const stop = addressResult.status === 'needs-human' ? addressResult.report?.stop : undefined;
      if (
        (stop !== 'round-cap' && stop !== 'budget' && stop !== 'rereview-blocked') ||
        addressResult.report === undefined
      )
        return stepResult('review.address', addressResult);

      // The FINAL deterministic gates run BEFORE the stopped-run publication
      // (the same gates the clean path re-runs at the addressed head): a fix
      // that broke format/knip must not publish, even as a draft. A red gate
      // propagates verbatim — no push, no PR.
      const capStarted = Date.now();
      const capCheck = await check(checkStep);
      if (capCheck.status !== 'ok')
        return await redFinal(capCheck, Date.now() - capStarted, addressResult.report);
      return await finishNotReady(
        stop === 'rereview-blocked'
          ? `the re-review was blocked after verified fixes (retried once on a network/transient class) — ${addressResult.status === 'needs-human' ? addressResult.reason : 're-review blocked'}`
          : stop === 'budget'
            ? `review.address stopped on the run budget — ${addressResult.status === 'needs-human' ? addressResult.reason : 'token or wall budget exhausted'}`
            : 'review round cap reached with open findings',
        addressResult.report,
      );
    }

    // ------------------- 4. the FINAL dev.check --------------------------
    // The address leg's commits moved HEAD: re-run the deterministic gates
    // so the readiness record rests on a green check at the head the PR is
    // opened from. A red gate is surfaced verbatim (never a draft).
    const finalStarted = Date.now();
    const finalCheck = await check(checkStep);
    if (finalCheck.status !== 'ok')
      return await redFinal(
        finalCheck,
        Date.now() - finalStarted,
        addressResult.report ?? addressReportOf(addressResult),
      );

    // ------------------------- 5. readiness ------------------------------
    const readiness = await readReadinessWithGaps(deps.effects, 'dev.cycle', target, policy);
    if (!readiness.ok) {
      if (readiness.gaps === undefined)
        return { status: 'needs-human', reason: `dev.cycle (readiness): ${readiness.reason}` };
      // NOT READY past a clean address run: the recorded evidence is behind
      // the state (untracked files, an earlier blocked attempt) or the
      // findings came back open. The DRAFT with the gaps verbatim is the
      // honest publication — never a bypass. The gates are already green
      // (the final check above); publication goes straight out.
      return await finishNotReady(readiness.reason, addressResult.report);
    }

    // -------------- 6. push + pr.open (the READY PR) ---------------------
    const { state, record } = readiness.read;
    const publication = await publishHead(state.branch, state.head);
    if (!publication.ok)
      return { status: 'needs-human', reason: `dev.cycle (push): ${publication.reason}` };
    const openResult = await open({
      repoRoot: input.repoRoot,
      target,
      ...(input.title === undefined ? {} : { title: input.title }),
    });
    if (openResult.status !== 'ok') return stepResult('pr.open', openResult);
    return {
      status: 'ok',
      value: {
        branch: record.branch,
        head: record.head,
        target,
        pr: openResult.value,
        pushed,
        followUp: followUpCommand(openResult.value.number, input.repoRoot, target),
        ...(openResult.value.advisories === undefined
          ? {}
          : { advisories: openResult.value.advisories }),
      },
    };

    // -------- #536: red final gates after verified fixes -----------------
    // A red final gate never drafts its own SHA. When the gates were red at
    // the addressed head T after at least one verified fix (both the
    // structured-stop path and the clean-address path, Giles D2b), the cycle
    // probes the verified-fix chain newest to oldest in an ISOLATED worktree
    // and, on the first commit G passing ALL final gates, publishes a DRAFT
    // from a NEW branch pinned to G. The author's branch, worktree and ledger
    // stay at T. Anything short of that returns the red result verbatim, with
    // the probe attribution appended once probing began.
    async function redFinal(
      red: OpResult<DevCheckReport>,
      redMs: number,
      report: ReviewAddressReport | undefined,
    ): Promise<OpResult<never>> {
      const verbatim = stepResult('dev.check (final)', red);
      if (
        red.status !== 'failed' ||
        verbatim.status !== 'failed' ||
        report === undefined ||
        deps.installDeps === undefined ||
        !pushed ||
        firstCheck.status !== 'ok' ||
        run.status !== 'ok'
      )
        return verbatim;
      let outcome: Awaited<ReturnType<typeof publishGreenPrefix>>;
      try {
        outcome = await publishGreenPrefix(report, redMs, firstCheck.value.head, run.value.head);
      } catch (err) {
        // A fault before any probe resource existed (the owned phase has its
        // own release): the red result stands, with the fault named.
        return {
          status: 'failed',
          error: `${verbatim.error} — the green-prefix fallback faulted before probing: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
        };
      }
      if (outcome.kind === 'skip') return verbatim;
      if (outcome.kind === 'published') return outcome.result;
      return { status: 'failed', error: `${verbatim.error} — ${outcome.attribution}` };
    }

    async function publishGreenPrefix(
      report: ReviewAddressReport,
      redMs: number,
      firstCheckedHead: string,
      admittedHead: string,
    ): Promise<
      | { kind: 'skip' }
      | { kind: 'none'; attribution: string }
      | { kind: 'published'; result: OpResult<never> }
    > {
      const installDeps = deps.installDeps!;
      // The author's state: exactly the verified head, clean, red on record.
      const author = await readWorkState(deps.effects, { target });
      if (!author.ok) return { kind: 'skip' };
      const T = author.state.head;
      if (report.verifiedHead !== T || author.state.dirtySha256 !== CLEAN_TREE)
        return { kind: 'skip' };
      const authorRecords = deps.effects.openLedger(author.state.branch).load().records;
      const lastCheck = authorRecords.findLast((record) => record.kind === 'check');
      if (lastCheck?.kind !== 'check' || lastCheck.head !== T || lastCheck.passed)
        return { kind: 'skip' };
      const ledgerPath = devLedgerPath(input.repoRoot, author.state.branch);
      const ledgerBytes = await readFile(ledgerPath).catch(() => undefined);
      if (ledgerBytes === undefined) return { kind: 'skip' };
      const authorLedger = {
        path: ledgerPath,
        sha256: createHash('sha256').update(ledgerBytes).digest('hex'),
      };
      const redGates = lastCheck.gates
        .filter((gate) => gate.status === 'fail')
        .map((gate) => gate.name);
      // The chain: the report's fix commits must BE git's linear history A..T.
      // A is the head this run's review.run reviewed and review.address
      // admitted (its record is the cycle's own, immutable evidence). It must
      // be this run's green opening check: a red or unchecked admitted head
      // publishes nothing.
      const A = admittedHead;
      if (A !== firstCheckedHead)
        return {
          kind: 'none',
          attribution: `no green-prefix publication: the admitted head ${A} is not this run's green opening check (${firstCheckedHead})`,
        };
      const recorded = recordedFixChain(report, A);
      if ('fault' in recorded)
        return { kind: 'none', attribution: `no green-prefix publication: ${recorded.fault}` };
      const gitAt = async (args: readonly string[]) =>
        deps.effects.runCommand('git', ['-C', input.repoRoot, ...args], { timeoutMs: 60_000 });
      const firstParent = await gitAt(['rev-list', '--first-parent', '--reverse', `${A}..${T}`]);
      const all = await gitAt(['rev-list', '--reverse', `${A}..${T}`]);
      const chain = firstParent.stdout.split('\n').filter((line) => line.trim() !== '');
      if (
        firstParent.exitCode !== 0 ||
        all.exitCode !== 0 ||
        all.stdout !== firstParent.stdout ||
        chain.join(' ') !== recorded.commits.join(' ') ||
        chain.at(-1) !== T
      )
        return {
          kind: 'none',
          attribution: `no green-prefix publication: the recorded verified-fix commits are not the linear history ${A}..${T}`,
        };
      const candidates = chain.slice(0, -1).reverse();
      if (candidates.length === 0)
        return {
          kind: 'none',
          attribution:
            'no green-prefix publication: no verified-fix commit precedes the addressed head',
        };

      // The reserve: the run deadline (or one publication reserve from now).
      const deadline =
        policy === undefined
          ? Date.now() + DEV_CYCLE_PUBLICATION_RESERVE_MS
          : cycleStarted + policy.runWallMs;
      const probeCost = Math.ceil(redMs * 1.25);
      const left = () => deadline - Date.now() - GREEN_PREFIX_PUBLICATION_MARGIN_MS;
      if (Math.min(GREEN_PREFIX_INSTALL_TIMEOUT_MS, left() - probeCost) <= 0)
        return {
          kind: 'none',
          attribution: `no green-prefix publication: the reserve (${String(Math.max(0, left()))}ms after the publication margin) cannot cover a worktree setup and one ${String(probeCost)}ms probe`,
        };

      const tmp = join(
        dirname(input.repoRoot),
        '.cq-dev-cycle-probes',
        // Run-unique: anything at this path after OUR worktree add is ours,
        // including a worktree git materialized before failing.
        `${basename(input.repoRoot)}-${T.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
      );
      const authorBranch = author.state.branch;
      const pub = `${author.state.branch}-cq-green-${T.slice(0, 12)}`;
      const branchExists = async () =>
        (await gitAt(['show-ref', '--verify', '--quiet', `refs/heads/${pub}`])).exitCode === 0;
      // A pre-existing branch of this name (an earlier publication for this
      // tip, or anything else) is refused and NEVER touched.
      if (await branchExists())
        return {
          kind: 'none',
          attribution: `no green-prefix publication: the publication branch '${pub}' already exists (an earlier publication for this tip?) — it is left untouched`,
        };

      // The owned lifetime: everything this run creates (the worktree, the
      // branch) is released in the finally below, whatever returns or throws.
      let worktreeAdded = false;
      // The SHA this run last set the publication branch to, defined only
      // once THIS run created it atomically (update-ref against the zero id).
      // Release deletes with the same compare-and-swap, so a ref anyone else
      // created or moved is never deleted — a failed delete is reported.
      let ownedAt: string | undefined;
      // Set once a push of the branch was ATTEMPTED: the remote may carry it
      // even when verification failed, so the local branch is then kept.
      let pushAttempted = false;
      const setupStarted = Date.now();
      const releaseFaults: string[] = [];
      let outcome:
        | { kind: 'none'; attribution: string }
        | { kind: 'published'; result: OpResult<never> };
      try {
        outcome = await probeAndPublish();
      } catch (err) {
        const text = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        outcome = pushAttempted
          ? {
              kind: 'published',
              result: {
                status: 'needs-human',
                reason: `dev.cycle (green prefix): the push of '${pub}' was attempted, then the publication threw — ${text}; the remote may carry '${pub}', and the local branch is kept`,
              },
            }
          : {
              kind: 'none',
              attribution: `no green-prefix publication: the probe phase threw — ${text}`,
            };
      } finally {
        // Release OUR worktree and (unless a push was attempted) OUR branch.
        // A failed release is reported below, never retried or widened.
        if (worktreeAdded) {
          const removed = await gitAt(['worktree', 'remove', '--force', tmp]).catch(
            (err: unknown) => ({ exitCode: -1, stderr: String(err) }),
          );
          if (removed.exitCode !== 0)
            releaseFaults.push(
              `worktree remove ${tmp} failed: ${removed.stderr.trim().slice(0, 300)}`,
            );
        }
        if (ownedAt !== undefined && !pushAttempted) {
          const deleted = await gitAt(['update-ref', '-d', `refs/heads/${pub}`, ownedAt]).catch(
            (err: unknown) => ({ exitCode: -1, stderr: String(err) }),
          );
          if (deleted.exitCode !== 0)
            releaseFaults.push(
              `delete of '${pub}' at ${ownedAt} failed (left in place): ${deleted.stderr.trim().slice(0, 300)}`,
            );
        }
      }
      if (releaseFaults.length === 0) return outcome;
      const note = `; probe cleanup: ${releaseFaults.join('; ')}`;
      if (outcome.kind === 'none')
        return { kind: 'none', attribution: `${outcome.attribution}${note}` };
      const result = outcome.result;
      if (result.status === 'needs-human')
        return { kind: 'published', result: { ...result, reason: `${result.reason}${note}` } };
      if (result.status === 'failed')
        return { kind: 'published', result: { ...result, error: `${result.error}${note}` } };
      if (result.status === 'indeterminate')
        return { kind: 'published', result: { ...result, detail: `${result.detail}${note}` } };
      return outcome;

      async function probeAndPublish(): Promise<
        { kind: 'none'; attribution: string } | { kind: 'published'; result: OpResult<never> }
      > {
        // Create the branch atomically: update-ref with the zero old id fails
        // if the ref exists, so success alone proves this run created it.
        const zero = '0'.repeat(T.length);
        const created = await gitAt(['update-ref', `refs/heads/${pub}`, candidates[0]!, zero]);
        if (created.exitCode !== 0)
          return {
            kind: 'none',
            attribution: `no green-prefix publication: the publication branch '${pub}' could not be created (it may already exist) — it is left untouched: ${created.stderr.trim().slice(0, 300)}`,
          };
        ownedAt = candidates[0]!;
        if (existsSync(tmp))
          return {
            kind: 'none',
            attribution: `no green-prefix publication: the probe path ${tmp} already exists — it is left untouched`,
          };
        const added = await gitAt(['worktree', 'add', tmp, pub]);
        // The path was absent and is run-unique: a worktree git registered or
        // materialized there before failing is still ours to release.
        worktreeAdded =
          added.exitCode === 0 ||
          existsSync(tmp) ||
          (await gitAt(['worktree', 'list', '--porcelain'])).stdout
            .split('\n')
            .includes(`worktree ${tmp}`);
        if (added.exitCode !== 0)
          return {
            kind: 'none',
            attribution: `no green-prefix publication: the probe worktree could not be created — ${added.stderr.trim().slice(0, 300)}`,
          };
        // The install gets what the reserve leaves after the setup actually
        // spent and one probe (the estimate is re-taken, never the old figure).
        const installMs = Math.min(GREEN_PREFIX_INSTALL_TIMEOUT_MS, left() - probeCost);
        if (installMs <= 0)
          return {
            kind: 'none',
            attribution: `no green-prefix publication: after the ${String(Date.now() - setupStarted)}ms worktree setup the reserve no longer covers an install and one ${String(probeCost)}ms probe`,
          };
        try {
          await installDeps(tmp, AbortSignal.timeout(installMs));
        } catch (err) {
          return {
            kind: 'none',
            attribution: `no green-prefix publication: the probe worktree's dependency install failed — ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
          };
        }
        let installedAt = candidates[0]!;
        // Whether a commit configures a custom pnpm hook at all (the
        // `pnpmfile` setting in its root .npmrc or pnpm-workspace.yaml). Its
        // path is NOT parsed: any configuration form we cannot fully read
        // must fail closed, so a configured hook makes every change between
        // candidates count as a dependency change.
        const configuresPnpmfile = async (commit: string): Promise<boolean> => {
          for (const file of ['.npmrc', 'pnpm-workspace.yaml']) {
            const shown = await gitAt(['show', `${commit}:${file}`]);
            if (shown.exitCode === 0 && shown.stdout.includes('pnpmfile')) return true;
          }
          return false;
        };
        const tmpEffects = (deps.effectsFor ?? makeSubprocessDevEffects)(tmp);
        // Named test files under the author's checkout are re-rooted into the
        // probe checkout (the wrapper refuses paths outside its repository).
        const probeStep: DevCheckInput = {
          ...checkStep,
          repoRoot: tmp,
          ...(checkStep.testFiles === undefined
            ? {}
            : {
                testFiles: checkStep.testFiles.map((file) => {
                  if (!isAbsolute(file)) return file;
                  const inside = relative(input.repoRoot, file);
                  // Outside means a leading '..' SEGMENT ('..fixtures/x' is inside).
                  const outside =
                    inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
                  return outside ? file : join(tmp, inside);
                }),
              }),
        };
        const scan = await scanNewestFirst(
          candidates,
          async (commit): Promise<GreenPrefixProbe> => {
            if (commit !== candidates[0]) {
              const moved = await deps.effects.runCommand(
                'git',
                ['-C', tmp, 'checkout', '--quiet', '-B', pub, commit],
                { timeoutMs: 60_000 },
              );
              if (moved.exitCode !== 0)
                return {
                  commit,
                  verdict: 'fault',
                  detail: `checkout failed: ${moved.stderr.trim().slice(0, 300)}`,
                };
              ownedAt = commit;
            }
            // Dependencies follow the candidate: when its dependency inputs
            // differ from the installed commit's, reinstall within the reserve
            // (or fault) — never probe against another commit's graph.
            if (commit !== installedAt) {
              const changed = await gitAt([
                'diff',
                '--name-only',
                '--no-ext-diff',
                '--no-textconv',
                '--no-renames',
                '-z',
                installedAt,
                commit,
              ]);
              if (changed.exitCode !== 0)
                return {
                  commit,
                  verdict: 'fault',
                  detail: `dependency-input comparison failed: ${changed.stderr.trim().slice(0, 300)}`,
                };
              const paths = changed.stdout.split('\0').filter((path) => path !== '');
              const differs =
                paths.some((path) => GREEN_PREFIX_DEPENDENCY_INPUTS.includes(basename(path))) ||
                (paths.length > 0 &&
                  ((await configuresPnpmfile(installedAt)) || (await configuresPnpmfile(commit))));
              if (differs) {
                const reinstallMs = Math.min(GREEN_PREFIX_INSTALL_TIMEOUT_MS, left() - probeCost);
                if (reinstallMs <= 0)
                  return {
                    commit,
                    verdict: 'fault',
                    detail: 'its dependency inputs differ and the reserve cannot cover a reinstall',
                  };
                await installDeps(tmp, AbortSignal.timeout(reinstallMs));
                installedAt = commit;
              }
            }
            // A FRESH check leg per candidate: its secret scanner is built from
            // the candidate's own checkout, never the author's cached rules.
            const probeCheck = await probeCheckFor(tmpEffects, tmp);
            if (probeCheck === undefined)
              return {
                commit,
                verdict: 'fault',
                detail: 'no secret scanner could be bound to the probe worktree',
              };
            const probed = await probeCheck(probeStep);
            const recordAt = tmpEffects
              .openLedger(pub)
              .load()
              .records.findLast((record) => record.kind === 'check');
            const atCommit =
              recordAt?.kind === 'check' && recordAt.head === commit ? recordAt : undefined;
            if (probed.status === 'ok' && probed.value.passed && probed.value.head === commit)
              return { commit, verdict: 'green', checkId: probed.value.checkId };
            if (probed.status === 'failed' && atCommit !== undefined && !atCommit.passed)
              return {
                commit,
                verdict: 'red',
                checkId: atCommit.checkId,
                redGates: atCommit.gates.filter((g) => g.status === 'fail').map((g) => g.name),
              };
            return { commit, verdict: 'fault', detail: issue(probed).slice(0, 300) };
          },
          () =>
            left() < probeCost
              ? `the reserve no longer covers a ${String(probeCost)}ms probe plus the publication margin`
              : undefined,
        );
        const scanned = `green-prefix scan over ${A}..${T}: ${scan.stopped ?? `selected ${scan.selected ?? ''}`} [${probeLines(scan.probes).join('; ')}]`;
        if (scan.selected === undefined)
          return { kind: 'none', attribution: `${scanned} — nothing published` };
        const G = scan.selected;
        // A probe cannot be interrupted mid-check (dev.check takes no signal),
        // so the reserve is re-checked AFTER it: an overrun publishes nothing.
        if (left() < 0)
          return {
            kind: 'none',
            attribution: `${scanned} — the probes overran the reserve (${String(-left())}ms into the publication margin) — nothing published`,
          };

        // Bind the selected SHA: the author is still at T, the probe worktree
        // is on the publication branch at G, clean, with G's green check last.
        const authorNow = await readWorkState(deps.effects, { target });
        const pubState = await readWorkState(tmpEffects, { target });
        const pubCheck = tmpEffects
          .openLedger(pub)
          .load()
          .records.findLast((record) => record.kind === 'check');
        if (
          !authorNow.ok ||
          authorNow.state.head !== T ||
          authorNow.state.branch !== authorBranch ||
          !pubState.ok ||
          pubState.state.branch !== pub ||
          pubState.state.head !== G ||
          pubState.state.dirtySha256 !== CLEAN_TREE ||
          pubCheck?.kind !== 'check' ||
          pubCheck.head !== G ||
          !pubCheck.passed
        )
          return {
            kind: 'none',
            attribution: `${scanned} — the selected commit ${G} lost its binding before publication (author or probe state moved) — nothing published`,
          };
        // The binding re-reads above spend time too: the reserve is checked
        // once more immediately before the push, the point of no return.
        if (left() < 0)
          return {
            kind: 'none',
            attribution: `${scanned} — the reserve ran out during the publication binding (${String(-left())}ms into the publication margin) — nothing published`,
          };
        pushAttempted = true;
        const pushedPub = await publishHead(pub, G, true);
        if (!pushedPub.ok)
          return {
            kind: 'published',
            result: {
              status: 'needs-human',
              reason: `dev.cycle (push): ${pushedPub.reason}; the remote may carry '${pub}', and the local branch is kept`,
            },
          };
        const openPub = (
          deps.openIn ??
          ((effects) => makePrOpen(effects, gh ?? makeSubprocessPrEffects(input.repoRoot)))
        )(tmpEffects, tmp);
        const openResult = await openPub({
          repoRoot: tmp,
          target,
          draft: true,
          draftWhenNotReady: true,
          ...(input.title === undefined ? {} : { title: input.title }),
        });
        if (openResult.status !== 'ok')
          return {
            kind: 'published',
            result: stepResult('pr.open', openResult) as OpResult<never>,
          };
        const pr = openResult.value;
        const dropped = droppedFixes(report, chain, G);
        if (gh !== undefined) {
          try {
            const composed = composeSection(
              await gh.getPrBody(pr.number),
              renderFindingsSection(report, {
                head: G,
                addressedHead: T,
                redGates,
                dropped,
                probes: scan.probes,
                authorLedger,
              }),
            );
            await gh.editPrBody(pr.number, composed);
          } catch (err) {
            return {
              kind: 'published',
              result: {
                status: 'needs-human',
                reason: `dev.cycle (pr body): draft PR #${String(pr.number)} is open at ${G} but the findings section could not be composed — ${err instanceof Error ? err.message : String(err)}`,
              },
            };
          }
        }
        return {
          kind: 'published',
          result: {
            status: 'needs-human',
            reason: `dev.cycle: NOT READY — the final gates were red at the addressed head ${T} (${redGates.join(', ') || 'see the dev-record'}); draft PR #${String(pr.number)} published from '${pub}' at ${G}, the newest verified-fix commit passing all final gates, dropping ${String(dropped.length)} fix(es); the author branch stays at ${T}; follow-up: ${followUpCommand(pr.number, input.repoRoot, target)}`,
          },
        };
      }
    }

    /**
     * The probe worktree's check leg, built fresh for its CURRENT checkout:
     * an injected `checkIn`, else makeDevCheck with a secret scanner bound to
     * that root (`scanSecretsFor`). When the author's check leg scans with a
     * configured scanner but none can be bound to the probe root, there is
     * no leg (undefined): a probe must never run under another tree's rules.
     */
    async function probeCheckFor(
      effects: DevEffects,
      root: string,
    ): Promise<((step: DevCheckInput) => Promise<OpResult<DevCheckReport>>) | undefined> {
      if (deps.checkIn !== undefined) return deps.checkIn(effects, root);
      if (deps.scanSecretsFor !== undefined)
        return makeDevCheck(effects, await deps.scanSecretsFor(root, effects));
      if (deps.scanSecrets !== undefined) return undefined;
      return makeDevCheck(effects);
    }

    // -------- the round-cap / not-ready publication (shared) -------------
    // The gaps themselves are pr.open's fresh read (draftWhenNotReady) — the
    // composition never carries them across a state it does not own.
    async function finishNotReady(
      readinessReason: string,
      addressReport: ReviewAddressReport | undefined,
    ): Promise<
      | Extract<OpResult<never>, { status: 'needs-human' }>
      | Extract<OpResult<never>, { status: 'failed' }>
      | Extract<OpResult<never>, { status: 'indeterminate' }>
      | Extract<OpResult<never>, { status: 'budget-exhausted' }>
    > {
      // The branch/head the draft publishes: the CURRENT state, re-read —
      // the address leg's commits are the head the gaps describe.
      const guardedStop =
        addressReport?.stop === 'budget' || addressReport?.stop === 'rereview-blocked';
      const current = await readWorkState(deps.effects, { target });
      if (!current.ok) {
        if (!guardedStop)
          return { status: 'needs-human', reason: `dev.cycle (readiness): ${current.reason}` };
        // Fail closed on the leg's own result — but never SILENTLY: the
        // re-read's infrastructure failure rides the surfaced text, so an
        // unreadable work state is diagnosable instead of masquerading as
        // the leg's budget/blocked stop with the actual error discarded.
        const surfaced = stepResult('review.address', addressResult);
        const cause = ` — the work-state re-read also failed: ${current.reason}`;
        if (surfaced.status === 'failed')
          return { status: 'failed', error: `${surfaced.error}${cause}` };
        if (surfaced.status === 'indeterminate')
          return { status: 'indeterminate', detail: `${surfaced.detail}${cause}` };
        if (surfaced.status === 'budget-exhausted') return surfaced;
        return { status: 'needs-human', reason: `${surfaced.reason}${cause}` };
      }
      const { branch, head } = current.state;
      if (
        guardedStop &&
        (addressReport.verifiedHead !== head || current.state.dirtySha256 !== CLEAN_TREE)
      )
        return stepResult('review.address', addressResult);
      // Pin the verified object too: a later branch move cannot upload another head.
      const publication = await publishHead(branch, head, guardedStop);
      if (!publication.ok)
        return { status: 'needs-human', reason: `dev.cycle (push): ${publication.reason}` };
      const openResult = await open({
        repoRoot: input.repoRoot,
        target,
        draft: true,
        draftWhenNotReady: true,
        ...(input.title === undefined ? {} : { title: input.title }),
      });
      // Publication status is PRESERVED: the same forge failure must produce
      // the same status/exit whether addressing finished cleanly or hit the
      // cap. A `failed` creation (makePrOpen's forge-throw fold) stays
      // failed; an `indeterminate` (outcome uncertain — the PR may exist)
      // stays indeterminate; only a needs-human refusal stays needs-human.
      if (openResult.status !== 'ok') return stepResult('pr.open', openResult);
      const pr = openResult.value;
      // The findings section: composed onto the body AFTER the draft exists
      // (the readiness/gaps section is pr.open's own managed section; the
      // findings ride the same protocol under their own marker). The body
      // update goes through the SAME forge effects the publication leg was
      // built from — when deps.open is injected WITHOUT deps.gh, the
      // injected leg owns the forge and the composition NEVER falls back to
      // production gh (which would edit an unrelated PR). A fault here
      // fails the op — the PR is open, its body is missing the round cap's
      // evidence, and the reason says so.
      if (addressReport !== undefined && gh !== undefined) {
        try {
          const composed = composeSection(
            await gh.getPrBody(pr.number),
            renderFindingsSection(addressReport),
          );
          await gh.editPrBody(pr.number, composed);
        } catch (err) {
          return {
            status: 'needs-human',
            reason: `dev.cycle (pr body): draft PR #${String(pr.number)} is open but the findings section could not be composed — ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      return {
        status: 'needs-human',
        reason: `dev.cycle: NOT READY — ${readinessReason} — draft PR #${String(pr.number)} published with the gaps and the attempt log; follow-up: ${followUpCommand(pr.number, input.repoRoot, target)}`,
      };
    }
  });
}

/**
 * The address report a CLEAN address leg returned as its value (#536 reads
 * its fix chain after red final gates). Structural, never a cast of trust:
 * anything without the report's arrays yields undefined.
 */
function addressReportOf(result: OpResult<unknown>): ReviewAddressReport | undefined {
  if (result.status !== 'ok') return undefined;
  const value = result.value as Partial<ReviewAddressReport> | null;
  return typeof value === 'object' &&
    value !== null &&
    Array.isArray(value.fixes) &&
    Array.isArray(value.rounds)
    ? (value as ReviewAddressReport)
    : undefined;
}

/**
 * Meter a driver factory: every resolved driver reports its run's total
 * tokens (input + output + cache + reasoning) to `spend`, so the cycle can
 * hand each agentic leg what is left of the one run token budget. The Driver
 * seam is `run()` only, so the wrapper is the whole driver.
 *
 * A FAILED run is metered too. A driver run can consume tokens before it
 * fails — and failure is a normal, not exceptional, occurrence here (the
 * transient class the legs retry once, a cancel on the wall budget). The
 * meter wraps the run in try/catch: the resolved result's usage on the
 * success path, and whatever usage the rejection carries on the error path
 * ({@link usageOf}) — spent BEFORE the error propagates, so a failed attempt
 * still shrinks the unspent remainder instead of inflating the next leg's
 * token budget. The error itself is never swallowed or reshaped.
 */
function meterDrivers(factory: DriverFactory, spend: (tokens: number) => void): DriverFactory {
  return {
    resolve: (request) => {
      const resolved = factory.resolve(request);
      return {
        ...resolved,
        driver: {
          run: async (invocation, options) => {
            const meter = (usage: Usage): void => {
              const total =
                usage.input +
                usage.output +
                usage.cacheRead +
                usage.cacheWrite +
                (usage.reasoning ?? 0);
              // Invalid readings must not poison the shared token remainder.
              if (Number.isFinite(total)) spend(total);
            };
            try {
              const result = await resolved.driver.run(invocation, options);
              meter(result.usage);
              return result;
            } catch (err) {
              const partial = usageOf(err);
              if (partial !== undefined) meter(partial);
              throw err;
            }
          },
        },
      };
    },
  };
}

/**
 * The Usage a rejecting driver run attached, if any. The seam's lanes are
 * taught to settle a mid-run failure as a result (stopReason 'error' with the
 * completed steps' usage folded), so a reject is the exceptional path — but a
 * lane that does reject WITH the partial usage it completed must still reach
 * the meter. Structurally checked against the frozen Usage shape (numeric
 * input/output/cacheRead/cacheWrite, optional numeric reasoning); anything
 * else — including a `usage` field of a different shape — contributes zero,
 * never a guess.
 */
function usageOf(err: unknown): Usage | undefined {
  if (typeof err !== 'object' || err === null || !('usage' in err)) return undefined;
  const usage: unknown = (err as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const fields = usage as Record<string, unknown>;
  if (
    typeof fields.input !== 'number' ||
    typeof fields.output !== 'number' ||
    typeof fields.cacheRead !== 'number' ||
    typeof fields.cacheWrite !== 'number' ||
    (fields.reasoning !== undefined && typeof fields.reasoning !== 'number')
  )
    return undefined;
  return usage as Usage;
}
