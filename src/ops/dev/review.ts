// Dev lane — `dev.review`: ONE pre-PR review cycle with recorded evidence
// (strategy §3, dev.review row; docs/coderabbit-review.md is the protocol
// this op mechanizes). NEW logic, but the rules are the protocol's:
//
//   1. THE BASE PIN: BASE is the merge-base of `origin/<target>` and HEAD —
//      an immutable sha, never a moving branch tip — unless the input pins
//      an explicit base (resolved to a full sha once, then immutable).
//   2. THE SECRET SCAN GATES THE UPLOAD: every diff component — the
//      base-to-HEAD patch, the staged patch, the unstaged patch, and the
//      full content of every untracked non-ignored file — is scanned against
//      the repo's denylist classes BEFORE the reviewer runs. Any hit refuses
//      the review (needs-human naming the rule and component); a scan fault
//      refuses it too. Nothing that failed the scan is ever uploaded.
//   3. THE HOST LOCK: the CLI reviewer is the scarce quota; cycles serialize
//      host-wide (one lock per host, not per worktree).
//   4. THE COMPLETION HONESTY: the recorded completion is what ACTUALLY
//      happened — terminal, or blocked with the reason (CLI exit, error /
//      action_required stream events, review_skipped, missing terminal
//      event). A blocked cycle is still recorded (findings, log, identity)
//      but never counts toward readiness.
//   5. THE EVIDENCE: the raw stream log is saved OUTSIDE the repository;
//      the cycle record carries the log path, the pinned base, the HEAD,
//      the dirty-diff sha256, and the normalized findings.
//
// THE REVIEWER CHOICE IS CONFIGURATION, NEVER A CONSTANT (strategy §2.7):
// `--reviewer coderabbit` (the shipped default — the CodeRabbit CLI is the
// pre-PR reviewer, D-J) or `--reviewer agent:<provider/model>`. The agent
// route is the vendor-down FALLBACK and this build ships no agent runner —
// an `agent:` request is refused naming exactly that, so no SDK consumer
// can mistake a fallback for the required CLI cycle.
//
// ONE OP, TWO ACTIONS (the dev.review composition ruling): `dev.review` is
// a single registry op discriminated on `action`. No action — or
// `action: 'cycle'` — runs THIS module's CodeRabbit review cycle (the
// contract below); `action: 'enroll' | 'status' | 'fallback'` runs the
// author-admission transport (review-transport.js, carried over unchanged
// from the merged worker-transport PR — same wire shapes, same crq
// invocation). The transport adapter lives in its own module; this factory
// is the single dispatcher.
import { createHash } from 'node:crypto';
import type { Op } from '../../kernel/types.js';
import type { CommandResult, DevEffects } from './effects.js';
import { branchFromRevParse, gitOut, requireGitOut } from './effects.js';
import {
  makeAuthorAdmission,
  AUTHOR_TRANSPORT_HINT,
  type AuthorDecision,
  type AuthorTransport,
} from './review-transport.js';
import type { DevTransportInput } from './registry.js';
import {
  CODERABBIT_REVIEWER,
  coderabbitReviewArgv,
  decideCompletion,
  parseReviewerStream,
} from './coderabbit.js';
import {
  DEFAULT_DEV_TARGET,
  objectInputFault,
  repoRootFault,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  DEV_LEDGER_VERSION,
  type DevCycleRecord,
  type DevFinding,
  type DevIdentity,
} from './record.js';
import type { ComponentScan, DiffSecretScanner, ScanComponentInput } from './denylist.js';

/** Per-file cap for reading untracked content into the scan (huge scratch files are truncated, visibly). */
export const UNTRACKED_SCAN_FILE_CAP_BYTES = 1024 * 1024;

/** Git read wall-clock cap. */
export const GIT_TIMEOUT_MS = 60 * 1000;

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
  /** The reviewer choice: the shipped CLI reviewer (default) or `agent:<provider/model>`. */
  reviewer?: string;
  /** Review only staged+unstaged work (the protocol's --uncommitted scope). */
  uncommitted?: boolean;
}

/**
 * Input of the ONE `dev.review` op: the review cycle above, or the
 * author-admission transport (`enroll | status | fallback` — the shape is
 * pinned by `DevTransportInputSchema`, unchanged from the merged
 * worker-transport PR). The registry schema mirrors this union.
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
   * admission actions report the configuration gap — the cycle itself never
   * needs a transport and never reads the ambient alias.
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
  findings: DevFinding[];
  logPath: string;
  untracked: string[];
  at: string;
}

/** One diff component prepared for the secret scan. */
type ScanComponent = ScanComponentInput;

/**
 * Build the ONE `dev.review` op over its injected deps. THE DISPATCH: an
 * admission action (`enroll | status | fallback`) routes to the
 * author-admission transport (review-transport.js) and never touches the
 * repo; any other action — none, or `'cycle'` — runs the review cycle. The
 * object boundary comes first, so a schema-bypassing null input maps to the
 * `failed` taxonomy whatever action was meant.
 */
export function makeDevReview(
  deps: DevReviewDeps,
): Op<DevReviewInput, DevReviewReport | AuthorDecision> {
  const cycle = runCycleReview(deps.effects, deps.scanSecrets);
  return async (input) => {
    const objectFault = objectInputFault(input);
    if (objectFault !== null) return { status: 'failed', error: `dev.review: ${objectFault}` };
    if (isAdmissionInput(input)) {
      if (deps.transport === undefined) {
        return { status: 'needs-human', reason: AUTHOR_TRANSPORT_HINT };
      }
      return makeAuthorAdmission(deps.transport)(input);
    }
    return cycle(input);
  };
}

/** The admission branch of the union — every other spelling is the cycle contract. */
function isAdmissionInput(input: DevReviewInput): input is DevTransportInput {
  return input.action === 'enroll' || input.action === 'status' || input.action === 'fallback';
}

/**
 * Build the review-cycle action over injected effects and the injected
 * secret scanner (the denylist classes are the repo's own; tests inject a
 * stub).
 */
function runCycleReview(
  effects: DevEffects,
  scanSecrets: DiffSecretScanner,
): Op<DevCycleInput, DevReviewReport> {
  return async (input) => {
    // Library boundary BEFORE any effect: the input itself, then the action
    // spelling, then repoRoot (a null/undefined input maps to the failed
    // taxonomy, never a TypeError outside it; an unknown action is a
    // `failed` input fault, never a silently rerun cycle).
    const objectFault = objectInputFault(input);
    if (objectFault !== null) return { status: 'failed', error: `dev.review: ${objectFault}` };
    if (input.action !== undefined && input.action !== 'cycle') {
      return {
        status: 'failed',
        error: `dev.review: unknown action '${String(
          input.action,
        )}' — the review cycle takes no action or 'cycle'; the author-admission transport takes 'enroll' | 'status' | 'fallback'`,
      };
    }
    const rootFault = repoRootFault(input.repoRoot);
    if (rootFault !== null) return { status: 'failed', error: `dev.review: ${rootFault}` };
    const target = input.target ?? DEFAULT_DEV_TARGET;
    const scope: 'full' | 'uncommitted' = input.uncommitted === true ? 'uncommitted' : 'full';
    const reviewer = input.reviewer ?? CODERABBIT_REVIEWER;

    if (reviewer.startsWith('agent:')) {
      return {
        status: 'needs-human',
        reason:
          'the agent reviewer is the vendor-down fallback and this build ships no agent runner — the pre-PR reviewer is the CodeRabbit CLI (D-J); never a substitute for a real CLI cycle',
      };
    }
    if (reviewer !== CODERABBIT_REVIEWER) {
      return {
        status: 'failed',
        error: `dev.review: unknown reviewer '${reviewer}' — the shipped choice is '${CODERABBIT_REVIEWER}' (or agent:<provider/model>, unconfigured here)`,
      };
    }

    // Identity: branch, HEAD, pinned base, dirty-diff sha256.
    const branch = branchFromRevParse(
      await effects.runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );
    if (branch === null) {
      return {
        status: 'needs-human',
        reason:
          'dev.review records evidence per branch and HEAD is detached — check out a branch and re-run',
      };
    }
    const head = gitOut(
      await effects.runCommand('git', ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS }),
    );
    if (head === null) {
      return {
        status: 'needs-human',
        reason: 'git rev-parse HEAD failed — is this a git worktree?',
      };
    }
    let base: string;
    if (input.base !== undefined) {
      const resolved = gitOut(
        await effects.runCommand('git', ['rev-parse', `${input.base}^{commit}`], {
          timeoutMs: GIT_TIMEOUT_MS,
        }),
      );
      if (resolved === null) {
        return {
          status: 'needs-human',
          reason: `the explicit base '${input.base}' did not resolve to a commit — pin an immutable sha`,
        };
      }
      base = resolved;
    } else {
      const mergeBase = gitOut(
        await effects.runCommand('git', ['merge-base', `origin/${target}`, 'HEAD'], {
          timeoutMs: GIT_TIMEOUT_MS,
        }),
      );
      if (mergeBase === null) {
        return {
          status: 'needs-human',
          reason: `cannot pin the merge-base: 'origin/${target}' did not resolve — fetch the target and re-run`,
        };
      }
      base = mergeBase;
    }
    // FAIL-CLOSED identity reads: a failed read is a refusal, never a
    // fabricated clean tree (requireGitOut throws; mapped below).
    let dirtySha256: string;
    try {
      const dirtyDiff = await effects.runCommand(
        'git',
        ['diff', '--binary', '--full-index', 'HEAD'],
        {
          timeoutMs: GIT_TIMEOUT_MS,
        },
      );
      const diffText = requireGitOut(dirtyDiff, 'diff --binary --full-index HEAD');
      dirtySha256 = diffText === '' ? 'clean-tree' : createDirtyHash(diffText);
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `the dirty-diff identity could not be read — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const identity: DevIdentity = { base, head, dirtySha256 };

    // Untracked non-ignored files: outside the CLI's default scope and the
    // dirty-diff hash; their CONTENT still gets scanned (a secret there
    // would reach a later commit), and their names are recorded in the
    // cycle so dev.ready can hold the line until they are staged/committed.
    let untracked: string[];
    try {
      const untrackedOut = requireGitOut(
        await effects.runCommand('git', ['ls-files', '--others', '--exclude-standard'], {
          timeoutMs: GIT_TIMEOUT_MS,
        }),
        'ls-files --others',
      );
      untracked = untrackedOut.split('\n').filter((line) => line.trim() !== '');
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `the untracked file list could not be read — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // The diff components, per scope (protocol §1's component list).
    const components: ScanComponent[] = [];
    if (scope === 'full') {
      const committed = await effects.runCommand(
        'git',
        ['diff', '--binary', '--full-index', base, 'HEAD'],
        {
          timeoutMs: GIT_TIMEOUT_MS,
        },
      );
      if (committed.exitCode !== 0) {
        return {
          status: 'needs-human',
          reason: `the committed patch against the pinned base could not be read — ${committed.stderr.trim().slice(0, 400)}`,
        };
      }
      if (committed.stdout !== '') {
        components.push({ component: 'committed', text: committed.stdout, kind: 'patch' });
      }
    }
    // The scanned components are BOUND AT CAPTURE TIME: the staged and
    // unstaged texts hash exactly as they enter the scan — NEVER from a
    // post-scan re-read, which would let a split change during scanner
    // execution crown the NEW (unscanned) content as the trusted baseline.
    // Absent components hash the empty string, so a recheck that finds
    // content where the scan saw none diverges too.
    let stagedSha = createHash('sha256').update('').digest('hex');
    let unstagedSha = createHash('sha256').update('').digest('hex');
    for (const [name, args] of [
      ['staged', ['diff', '--cached']],
      ['unstaged', ['diff']],
    ] as const) {
      const result = await effects.runCommand('git', args, { timeoutMs: GIT_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        return {
          status: 'needs-human',
          reason: `the ${name} patch could not be read — ${result.stderr.trim().slice(0, 400)}`,
        };
      }
      // THE SCAN-INPUT BINDING: the hash of the EXACT text that enters the
      // scan — captured here, before scanSecrets runs. (An empty patch
      // hashes the empty string; the in-lock recheck compares against
      // THESE hashes.)
      if (name === 'staged') stagedSha = createHash('sha256').update(result.stdout).digest('hex');
      else unstagedSha = createHash('sha256').update(result.stdout).digest('hex');
      if (result.stdout !== '') {
        components.push({ component: name, text: result.stdout, kind: 'patch' });
      }
    }
    for (const path of untracked) {
      const read = await effects.readWorktreeFile(path, UNTRACKED_SCAN_FILE_CAP_BYTES);
      if (!read.ok) {
        return {
          status: 'needs-human',
          reason: `the untracked file '${path}' was refused by the secret scan — ${read.reason}`,
        };
      }
      // The file's own path rides as path context so path-scoped classes
      // (the *.env rule, the scratch-dir class) apply to untracked content
      // exactly as they would after commit.
      components.push({ component: `untracked:${path}`, text: read.text, kind: 'file', path });
    }
    if (components.length === 0) {
      return {
        status: 'needs-human',
        reason:
          'no diff to review — the selected scope is empty (stage or commit the work first, or pass the right scope)',
      };
    }

    // THE SCAN BEFORE THE UPLOAD: any hit (or a scanner fault) refuses the
    // review — the components are never sent anywhere once flagged.
    let scans: ComponentScan[];
    try {
      scans = await scanSecrets(components);
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `the secret scan faulted — review refused: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const flagged = scans.flatMap((scan) =>
      scan.hits.map((hit) => `${hit.ruleId} in ${scan.component} (lines ${hit.lines.join(', ')})`),
    );
    if (flagged.length > 0) {
      return {
        status: 'needs-human',
        reason: `secret scan found denylist-class content — review refused, remove it and re-run: ${flagged.join('; ')}`,
      };
    }

    // The cycle under the HOST lock: the scarce reviewer is serialized
    // host-wide. The completion is decided and the log written inside this
    // span; the record append follows under the store mutex. The identity
    // is RE-VERIFIED inside the lock span — the wait for a contended
    // reviewer can be long, and a worktree that changed meanwhile would
    // make the record's identity describe a state the reviewer never saw.
    const at = effects.nowIso();
    let span: {
      completion: DevCycleRecord['completion'];
      logPath: string;
      findings: Omit<DevFinding, 'id'>[];
    };
    try {
      span = await effects.withHostLock(async () => {
        // The rechecks are FAIL-CLOSED too: a failed read THROWS through
        // requireGitOut — a failed recheck can never compare as equal.
        const [recheckHead, recheckDirty, recheckUntracked] = await Promise.all([
          effects.runCommand('git', ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS }),
          effects.runCommand('git', ['diff', '--binary', '--full-index', 'HEAD'], {
            timeoutMs: GIT_TIMEOUT_MS,
          }),
          effects.runCommand('git', ['ls-files', '--others', '--exclude-standard'], {
            timeoutMs: GIT_TIMEOUT_MS,
          }),
        ]);
        const drifted: string[] = [];
        if (requireGitOut(recheckHead, 'rev-parse HEAD (recheck)') !== head)
          drifted.push('HEAD moved');
        const recheckDiff = requireGitOut(recheckDirty, 'dirty diff (recheck)');
        const recheckSha = recheckDiff === '' ? 'clean-tree' : createDirtyHash(recheckDiff);
        if (recheckSha !== dirtySha256) drifted.push('the working-tree diff changed');
        // The scanned PATCH COMPONENTS are re-bound here too: the staged
        // and unstaged patches must be byte-identical to what passed the
        // secret scan before the lock — the aggregate hash above cannot see
        // an index/worktree split move (a scan-restore would otherwise
        // upload content that never passed the scan).
        const recheckStaged = await effects.runCommand('git', ['diff', '--cached'], {
          timeoutMs: GIT_TIMEOUT_MS,
        });
        const recheckUnstaged = await effects.runCommand('git', ['diff'], {
          timeoutMs: GIT_TIMEOUT_MS,
        });
        const recheckStagedSha = createHash('sha256')
          .update(recheckStaged.exitCode === 0 ? recheckStaged.stdout : '\u0000read-failed-2')
          .digest('hex');
        const recheckUnstagedSha = createHash('sha256')
          .update(recheckUnstaged.exitCode === 0 ? recheckUnstaged.stdout : '\u0000read-failed-3')
          .digest('hex');
        if (recheckStagedSha !== stagedSha) drifted.push('the staged patch changed since the scan');
        if (recheckUnstagedSha !== unstagedSha) {
          drifted.push('the unstaged patch changed since the scan');
        }
        const recheckUntrackedList = requireGitOut(recheckUntracked, 'ls-files --others (recheck)')
          .split('\n')
          .filter((line) => line.trim() !== '');
        const sameUntracked =
          recheckUntrackedList.length === untracked.length &&
          recheckUntrackedList.every((path, index) => path === untracked[index]);
        if (!sameUntracked) {
          drifted.push('the untracked file set changed');
        }
        if (drifted.length > 0) {
          throw new Error(
            `${drifted.join('; ')} while waiting for the review lock — the recorded identity would not match what the reviewer saw; re-run dev.review`,
          );
        }
        const raw = await runReviewer(
          effects,
          coderabbitReviewArgv(base, scope),
          DEFAULT_REVIEWER_TIMEOUT_MS,
        );
        // A run that produced no exit (SIGKILLed on the timeout, or a spawn
        // fault) is a BLOCKED cycle naming WHICH — never a completion and
        // never a crash.
        const parsed = raw.exitCode === null ? null : parseReviewerStream(raw.stdout);
        const completion =
          raw.exitCode === null || parsed === null
            ? ({
                kind: 'blocked',
                reason: raw.timedOut
                  ? `the reviewer CLI timed out after ${String(DEFAULT_REVIEWER_TIMEOUT_MS)}ms and was stopped — no review completed`
                  : `the reviewer CLI did not run — ${raw.stderr.trim().slice(0, 300)}`,
              } as const)
            : decideCompletion(raw.exitCode, parsed);
        const logPath = await effects.writeReviewLog(
          branch,
          `${Date.now()}`,
          [
            `# dev.review cycle log`,
            `reviewer: ${reviewer}`,
            `argv: ${CODERABBIT_REVIEWER} ${coderabbitReviewArgv(base, scope).join(' ')}`,
            `base: ${base}`,
            `head: ${head}`,
            `dirtySha256: ${dirtySha256}`,
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
        return { raw, parsed, completion, logPath, findings: parsed?.findings ?? [] };
      });
    } catch (err) {
      // A host-lock, identity-drift, or log-write fault: the reviewer never
      // ran (or its outcome could not be captured) — nothing is recorded,
      // and the author re-runs. The message names the cause.
      return {
        status: 'needs-human',
        reason: `the review cycle could not run to a recorded outcome — ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    // Mint the cycle id and append the record under the store mutex. The
    // reviewer quota is ALREADY spent at this point, so a store fault must
    // still report the verdict and the log path — a thrown fault would bury
    // a finished (or blocked) cycle the author paid for.
    let cycleRecord: DevCycleRecord;
    try {
      const store = effects.openLedger(branch);
      cycleRecord = await store.mutate((ledger) => {
        const cycleCount = ledger.records.filter((entry) => entry.kind === 'cycle').length;
        const cycleId = `c${String(cycleCount + 1).padStart(3, '0')}-${head.slice(0, 8)}`;
        const entry: DevCycleRecord = {
          kind: 'cycle',
          cycleId,
          reviewer,
          scope,
          target,
          base: identity.base,
          head: identity.head,
          dirtySha256: identity.dirtySha256,
          completion: span.completion,
          findings: span.findings.map((finding, index) => ({
            id: `${cycleId}#f${String(index + 1)}`,
            severity: finding.severity,
            ...(finding.fileName !== undefined ? { fileName: finding.fileName } : {}),
            ...(finding.excerpt !== undefined ? { excerpt: finding.excerpt } : {}),
          })),
          logPath: span.logPath,
          untracked,
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
          : `the cycle BLOCKED (${span.completion.kind === 'blocked' ? span.completion.reason : 'unknown'})`;
      return {
        status: 'failed',
        error: `dev.review: ${verdict} with ${String(span.findings.length)} finding(s), but the record could not be persisted — ${
          err instanceof Error ? err.message : String(err)
        }; log: ${span.logPath}`,
      };
    }

    if (cycleRecord.completion.kind === 'terminal') {
      return {
        status: 'ok',
        value: {
          cycleId: cycleRecord.cycleId,
          reviewer,
          scope,
          target,
          base,
          head,
          dirtySha256,
          findings: cycleRecord.findings,
          logPath: cycleRecord.logPath,
          untracked,
          at,
        },
      };
    }
    return {
      status: 'needs-human',
      reason: `review cycle ${cycleRecord.cycleId} was BLOCKED (${cycleRecord.completion.kind === 'blocked' ? cycleRecord.completion.reason : 'unknown'}) — the cycle is recorded with ${String(cycleRecord.findings.length)} finding(s); log: ${cycleRecord.logPath}`,
    };
  };
}

/** sha256 of the dirty diff (the protocol's dirty-diff identity). */
function createDirtyHash(diffText: string): string {
  return createHash('sha256').update(diffText).digest('hex');
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
      stderr: `spawn fault: ${err instanceof Error ? err.message : String(err)}`,
      timedOut: false,
    }));
}
