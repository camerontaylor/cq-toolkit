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
// the final head; only the deterministic gates need re-running. A red final
// check is surfaced verbatim — the draft path below exists for the review
// pipeline's honest stops, never for red gates.
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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults } from '../analyze/cqConfigDefaults.js';
import { createDriverFactory, type DriverFactory } from '../../driver/factory.js';
import type { Usage, WorkerResult } from '../../driver/types.js';
import { composeSection, mdSafe, type PrEffects } from '../pr/assemblePrs.js';
import { makeSubprocessPrEffects } from '../../adapters/forge-github/ghEffects.js';
import type { PrOpenInput, PrOpenReport } from '../pr/open.js';
import { makePrOpen } from '../pr/open.js';
import type { ReviewAddressInput, ReviewAddressReport } from '../review/address.js';
import { makeReviewAddress } from '../review/address.js';
import type { FindingsRecord } from '../review/findings.js';
import type { ReviewRunInput } from '../review/run.js';
import { makeReviewRun } from '../review/run.js';
import type { DiffSecretScanner } from './denylist.js';
import type { DevCheckInput, DevCheckReport } from './check.js';
import { makeDevCheck } from './check.js';
import type { DevEffects } from './effects.js';
import { guardDevOp } from './effects.js';
import { DEFAULT_DEV_TARGET } from './record.js';
import { readReadinessWithGaps } from './ready.js';
import { CLEAN_TREE, readWorkState } from './internal/workState.js';
import { DevCycleCompositionInputSchema } from './registry.js';
import {
  createKnownUsageLedger,
  normalizeUsageObservation,
  type KnownUsageSummary,
  type UsageObservation,
} from '../../shared/knownUsage.js';

/**
 * Wall time held back from the review and address legs for the publication
 * leg: the final dev.check (observed 1–2 min on the dev VM in the S7
 * dogfood), the verified push, pr.open and the findings-section compose.
 * Ten minutes is ~5× the observed gates, headroom for a loaded host, and
 * ~4% of the dogfood's 4 h run budget. A run budget under 40 min reserves a
 * quarter of itself instead, so short budgets still leave the legs time.
 */
export const DEV_CYCLE_PUBLICATION_RESERVE_MS = 10 * 60 * 1000;

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
  usageSummary: KnownUsageSummary;
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
type DevCycleCoreReport = Omit<DevCycleReport, 'usageSummary'>;

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
export function renderFindingsSection(report: ReviewAddressReport): string {
  // Name the structured stop that triggered this draft publication.
  const blocked = report.stop === 'rereview-blocked';
  const budget = report.stop === 'budget';
  const lines: string[] = [
    DEV_FINDINGS_SECTION_MARKER,
    blocked
      ? '<!-- cq-toolkit dev findings (generated by dev.cycle after a blocked re-review; updated in place, never duplicated) -->'
      : budget
        ? '<!-- cq-toolkit dev findings (generated by dev.cycle after a run budget stop; updated in place, never duplicated) -->'
        : '<!-- cq-toolkit dev findings (generated by dev.cycle at the review round cap; updated in place, never duplicated) -->',
    blocked
      ? '## Findings after a blocked re-review — author evidence'
      : budget
        ? '## Open findings after a run budget stop — author evidence'
        : '## Open findings at the review round cap — author evidence',
    '',
    blocked
      ? `> review.address made ${String(report.fixesPerRun)} verified fix(es), then its re-review stayed blocked on a network/transient class after one retry, so these findings are UNVERIFIED by a fresh review: ${mdLine(report.reasons.at(-1) ?? 're-review blocked')}. ${String(report.openBlocking.length)} open blocking finding(s); every attempt below was logged by the engine.`
      : budget
        ? `> review.address stopped on the run budget with ${String(report.openBlocking.length)} open blocking finding(s); every attempt below was logged by the engine.`
        : `> review.address stopped at its round cap with ${String(report.openBlocking.length)} open blocking finding(s); every attempt below was logged by the engine.`,
    '',
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
}

function makeDevCycleCore(
  deps: DevCycleDeps,
  observe: DriverUsageObserver,
): Op<DevCycleCompositionInput, DevCycleCoreReport> {
  return guardDevOp('dev.cycle', DevCycleCompositionInputSchema, async (input) => {
    // ONE run budget across the legs (S7 attempt H): the run started here,
    // and every token a default leg's driver spends is metered here.
    const cycleStarted = Date.now();
    let spentTokens = 0;
    const drivers = meterDrivers(
      deps.drivers ?? createDriverFactory(),
      (tokens) => {
        spentTokens += tokens;
      },
      observe,
    );
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
      const capCheck = await check(checkStep);
      if (capCheck.status !== 'ok') return stepResult('dev.check (final)', capCheck);
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
    const finalCheck = await check(checkStep);
    if (finalCheck.status !== 'ok') return stepResult('dev.check (final)', finalCheck);

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

/** Build the `dev.cycle` op over the injected steps. */
export function makeDevCycle(deps: DevCycleDeps): Op<DevCycleCompositionInput, DevCycleReport> {
  return async (input) => {
    const usageLedger = createKnownUsageLedger();
    let open = true;
    const pending = new Set<string>();
    const observe: DriverUsageObserver = {
      start: (id) => {
        if (open) pending.add(id);
      },
      settle: (id, observation) => {
        if (!open) return;
        usageLedger.record(id, observation);
        pending.delete(id);
      },
    };
    const result = await makeDevCycleCore(deps, observe)(input);
    open = false;
    for (const id of pending) usageLedger.record(id, {});
    const usageSummary = usageLedger.snapshot();
    if (result.status === 'ok') return { ...result, value: { ...result.value, usageSummary } };
    const previous =
      'report' in result && typeof result.report === 'object' && result.report !== null
        ? result.report
        : {};
    return { ...result, report: { ...previous, usageSummary } };
  };
}

export interface DriverUsageObserver {
  start(id: string): void;
  settle(id: string, observation: UsageObservation): void;
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
export function meterDrivers(
  factory: DriverFactory,
  spend: (tokens: number) => void,
  observe: DriverUsageObserver,
): DriverFactory {
  let dispatch = 0;
  return {
    resolve: (request) => {
      const resolved = factory.resolve(request);
      return {
        ...resolved,
        driver: {
          run: async (invocation, options) => {
            const id = `cycle:${String(dispatch++)}`;
            try {
              observe.start(id);
            } catch {
              // Telemetry cannot prevent a driver invocation.
            }
            const settle = (observation: UsageObservation): void => {
              try {
                observe.settle(id, normalizeUsageObservation(observation));
              } catch {
                // Telemetry cannot replace the driver result or error.
              }
            };
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
            let result: WorkerResult;
            try {
              result = await resolved.driver.run.call(resolved.driver, invocation, options);
            } catch (err) {
              let partial: Usage | undefined;
              try {
                partial = usageOf(err);
              } catch {
                // A malformed error's usage accessor cannot replace that error.
              }
              if (partial !== undefined) meter(partial);
              settle(partial === undefined ? {} : { usage: partial });
              throw err;
            }
            let measured: Usage | undefined;
            try {
              measured = normalizeUsageObservation({ usage: result.usage }).usage;
            } catch {
              // A malformed usage accessor cannot replace the driver result.
            }
            let costUSD: number | undefined;
            try {
              const reportedCost = result.costUSD;
              costUSD = normalizeUsageObservation(
                reportedCost === undefined ? {} : { costUSD: reportedCost },
              ).costUSD;
            } catch {
              // Cost remains independent of malformed usage telemetry.
            }
            if (measured !== undefined) meter(measured);
            settle({
              ...(measured === undefined ? {} : { usage: measured }),
              ...(costUSD === undefined ? {} : { costUSD }),
            });
            return result;
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
  const { input, output, cacheRead, cacheWrite, reasoning } = fields;
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    typeof cacheRead !== 'number' ||
    typeof cacheWrite !== 'number' ||
    (reasoning !== undefined && typeof reasoning !== 'number')
  )
    return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}
