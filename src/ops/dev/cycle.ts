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
//   - round cap: review.address's designed stop ('review round cap reached
//     with open findings') carries its report — open findings with their
//     attempt logs. The findings are PUBLISHED, not buried: the branch is
//     pushed and pr.open (draft + draftWhenNotReady) opens the DRAFT whose
//     managed section carries the readiness GAPS verbatim; the open-findings
//     + attempt-log section is then composed onto the body with the SAME
//     managed-section protocol (composeSection). The op resolves needs-human
//     (CLI exit 3) and the reason carries the follow-up command
//     `cq review.address --source=pr:<n>` verbatim.
//   - any other refusal (a red check, a blocked review source, a budget
//     stop, a push or forge failure) surfaces VERBATIM and stops the cycle —
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
import { readWorkState } from './internal/workState.js';
import { DevCycleCompositionInputSchema } from './registry.js';

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
   * Opt BOTH dev.check legs' test:narrow gate into the integration suite
   * (`--include-integration`); the choice is recorded in each check record.
   * The `--base`/`--range` selector's closure can name gated e2e files for
   * plain src changes, and the wrapper's refusal cannot be satisfied from
   * inside dev.check — the caller opts in explicitly (S7 dogfood attempt A).
   * Default off.
   */
  includeIntegration?: boolean;
  /**
   * Name the EXACT test files BOTH dev.check legs run (the wrapper's own
   * escape for a too-broad automatic selection): replaces their `--base`
   * selection; every check record discloses the narrowing via
   * `testSelection: { mode: 'named', files }`.
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
 * The round cap's public record: the open findings (severity and file, one
 * line each) and every attempt logged against them, markdown-safe. The
 * attempts ARE the spec's "attempt logs" — finding id, tier/invocation,
 * wall time and the worker's own reason — rendered from the address report's
 * run-wide arrays. Round-cap only: a ready PR carries no findings section,
 * because there is nothing open to list.
 */
export function renderFindingsSection(report: ReviewAddressReport): string {
  // #509: the section names the stop it publishes for — the round cap, or a
  // re-review that stayed blocked after its one retry — never the other.
  const blocked = report.stop === 'rereview-blocked';
  const lines: string[] = [
    DEV_FINDINGS_SECTION_MARKER,
    blocked
      ? '<!-- cq-toolkit dev findings (generated by dev.cycle after a blocked re-review; updated in place, never duplicated) -->'
      : '<!-- cq-toolkit dev findings (generated by dev.cycle at the review round cap; updated in place, never duplicated) -->',
    blocked
      ? '## Findings after a blocked re-review — author evidence'
      : '## Open findings at the review round cap — author evidence',
    '',
    blocked
      ? `> review.address made ${String(report.fixesPerRun)} verified fix(es), then its re-review stayed blocked on a network/transient class after one retry, so these findings are UNVERIFIED by a fresh review: ${mdLine(report.reasons.at(-1) ?? 're-review blocked')}. ${String(report.openBlocking.length)} open blocking finding(s); every attempt below was logged by the engine.`
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

/** Build the `dev.cycle` op over the injected steps. */
export function makeDevCycle(deps: DevCycleDeps): Op<DevCycleCompositionInput, DevCycleReport> {
  return guardDevOp('dev.cycle', DevCycleCompositionInputSchema, async (input) => {
    const target = input.target ?? DEFAULT_DEV_TARGET;
    const check =
      deps.check ?? ((step: DevCheckInput) => makeDevCheck(deps.effects, deps.scanSecrets)(step));
    const review =
      deps.review ??
      ((step: ReviewRunInput) =>
        makeReviewRun({ drivers: deps.drivers ?? createDriverFactory() })(step));
    // The default address leg is CONSTRUCTED with the caller's injected
    // driver factory: the whole cycle honours one wiring — test transports
    // injected here must not be replaced by real provider factories inside
    // the address leg's own default construction.
    const address =
      deps.address ??
      ((step: ReviewAddressInput) =>
        deps.drivers === undefined
          ? makeReviewAddress()(step)
          : makeReviewAddress({ drivers: deps.drivers })(step));
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
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      if (!pushed) return { ok: true };
      const result = await git([
        '-C',
        input.repoRoot,
        'push',
        'origin',
        `refs/heads/${branch}:refs/heads/${branch}`,
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
    let policy: { reviewers: readonly string[]; blockingSeverities: readonly string[] } | undefined;
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

    // --------------------------- 2. review.run ---------------------------
    const run = await review({ repoRoot: input.repoRoot, target });
    if (run.status !== 'ok') return stepResult('review.run', run);

    // ------------------ 3. review.address (until clean) ------------------
    // The comparison base is the review's pinned base (the address leg's
    // admission guards the same comparison the producer reviewed); the
    // address leg owns the rounds and its own stop reasons. Its `push`
    // option stays OFF: the composition publishes once, at the end, after
    // the final check — never mid-loop.
    const addressResult = await address({
      repoRoot: input.repoRoot,
      source: 'local',
      target,
      ...(run.value.reviewed === undefined ? {} : { base: run.value.reviewed.base }),
    });
    if (addressResult.status !== 'ok') {
      // ROUND CAP ONLY: the address leg marks its designed stop with the
      // structured `stop: 'round-cap'` marker riding the report envelope
      // (set by its own finish(); the report is the kernel-sanctioned
      // extension, stripped before the strict OpResultSchema parse — a
      // top-level result field would be an unrecognized key). The leg's
      // own finish() appends '; report: <path>' to every needs-human reason
      // — a reason string can never be matched exactly. Budget exhaustion,
      // blocked re-reviews and admission failures ALSO carry a report —
      // publishing over them would turn a failed run into
      // needs-human-with-PR — so report presence is never the trigger;
      // the structured stop is. Any other refusal propagates verbatim and
      // stops the cycle.
      //
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
        (stop !== 'round-cap' && stop !== 'rereview-blocked') ||
        addressResult.report === undefined
      )
        return stepResult('review.address', addressResult);

      // The FINAL deterministic gates run BEFORE the round-cap publication
      // (the same gates the clean path re-runs at the addressed head): a fix
      // that broke format/knip must not publish, even as a draft. A red gate
      // propagates verbatim — no push, no PR.
      const capCheck = await check(checkStep);
      if (capCheck.status !== 'ok') return stepResult('dev.check (final)', capCheck);
      return await finishNotReady(
        stop === 'rereview-blocked'
          ? `the re-review was blocked after verified fixes (retried once on a network/transient class) — ${addressResult.status === 'needs-human' ? addressResult.reason : 're-review blocked'}`
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
      const current = await readWorkState(deps.effects, { target });
      if (!current.ok)
        return { status: 'needs-human', reason: `dev.cycle (readiness): ${current.reason}` };
      const { branch, head } = current.state;
      const publication = await publishHead(branch, head);
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
