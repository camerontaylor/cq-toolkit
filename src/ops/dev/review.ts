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
// default) or `agent:<provider/model>`, the vendor-down fallback. This build
// ships no agent runner, so an `agent:` request is a needs-human refusal and
// can never stand in for the CLI cycle.
//
// ONE OP, TWO ACTIONS: no action (or `cycle`) runs this module's review
// cycle; `enroll | status | fallback` runs the author-admission transport
// (review-transport.ts, unchanged from #332 — same wire shapes, same crq
// invocation `cq dev.review --action=enroll …`).
import type { Op, OpResult } from '../../kernel/types.js';
import { HARDENED_DIFF_FLAGS } from '../../shared/gitHarden.js';
import {
  CODERABBIT_REVIEWER,
  coderabbitReviewArgv,
  decideCompletion,
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

/**
 * The authoritative scanner's own intentional corpus (its tree allowlist
 * entry in scripts/denylist-scan): the rule samples are published by
 * design, so neither scanner layer reads this one path.
 */
const PATTERNS_FILE = 'policy/denylist/patterns.yml';

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
  /** The reviewer choice: `coderabbit` (default) or `agent:<provider/model>`. */
  reviewer?: string;
  /** Review only staged+unstaged work (the protocol's --uncommitted scope). */
  uncommitted?: boolean;
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
  /** The composed pre-upload secret scanner (cycle action only). */
  scanSecrets: DiffSecretScanner;
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
  const cycle = makeReviewCycle(deps.effects, deps.scanSecrets);
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
): Op<DevCycleInput, DevReviewReport> {
  return guardDevOp('dev.review', DevCycleInputSchema, async (input) => {
    const target = input.target ?? DEFAULT_DEV_TARGET;
    const scope = input.uncommitted === true ? 'uncommitted' : 'full';
    const reviewer = input.reviewer ?? CODERABBIT_REVIEWER;
    if (reviewer !== CODERABBIT_REVIEWER) {
      return needsHuman(
        'the agent reviewer is the vendor-down fallback (D-J) and this build ships no agent runner — the pre-PR reviewer is the CodeRabbit CLI; a fallback never substitutes for a real CLI cycle',
      );
    }

    const read = await readWorkState(effects, {
      target,
      ...(input.base !== undefined ? { base: input.base } : {}),
    });
    if (!read.ok) return needsHuman(read.reason);
    const state = read.state;

    const collected = await collectScanComponents(effects, state, scope);
    if (!collected.ok) return needsHuman(`review refused — ${collected.reason}`);
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
    };
    try {
      span = await effects.withHostLock(async () => {
        await refuseDrift('while waiting for the review lock');
        const raw = await runReviewer(effects, argv, DEFAULT_REVIEWER_TIMEOUT_MS);
        await refuseDrift(
          'during the review run (content the scan never saw may have been uploaded)',
        );
        // A killed run is blocked, but whatever findings it emitted before
        // the kill are still recorded: they stay open until dispositioned.
        const parsed = parseReviewerStream(raw.stdout);
        const completion: DevReviewCompletion =
          raw.exitCode === null
            ? {
                kind: 'blocked',
                reason: raw.timedOut
                  ? `the reviewer CLI timed out after ${String(DEFAULT_REVIEWER_TIMEOUT_MS)}ms and was stopped — no review completed`
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
        return { completion, logPath, findings: parsed.findings };
      });
    } catch (err) {
      // A host-lock, drift, or log-write fault: nothing is recorded, and
      // the author re-runs. The message names the cause.
      return needsHuman(`the review cycle could not run to a recorded outcome — ${faultText(err)}`);
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
      return needsHuman(
        `review cycle ${record.cycleId} was BLOCKED (${record.completion.reason}) — the cycle is recorded with ${String(record.findings.length)} finding(s); log: ${record.logPath}`,
      );
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
): Promise<
  { ok: true; components: ScanComponentInput[]; paths: number } | { ok: false; reason: string }
> {
  const legs: { name: string; args: string[] }[] = [
    ...(scope === 'full' ? [{ name: 'committed', args: [state.base, state.head] }] : []),
    { name: 'staged', args: ['--cached'] },
    { name: 'unstaged', args: [] },
  ];
  const components: ScanComponentInput[] = [];
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
      if (path === PATTERNS_FILE) continue;
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
  return { ok: true, components, paths };
}

/** Run one reviewer invocation; a spawn fault becomes a synthetic killed result. */
async function runReviewer(
  effects: DevEffects,
  argv: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return effects
    .runCommand(CODERABBIT_REVIEWER, argv, { timeoutMs })
    .catch((err: unknown): CommandResult => ({
      exitCode: null,
      stdout: '',
      stderr: `spawn fault: ${faultText(err)}`,
      timedOut: false,
    }));
}
