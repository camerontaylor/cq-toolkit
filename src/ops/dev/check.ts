// Dev lane — `dev.check`: the deterministic gate set composed over the diff
// (strategy §3, dev.check row). A WRAPPER over existing code: it runs the
// focused-checks contract's local duty as commands and records the verdicts
// as data; it adds no gate logic of its own.
//
//   - check:static (the TS7 ratchet + typed Oxlint; lint/typecheck are its
//     aliases — never run separately), format:check,
//   - `pnpm test:narrow` AS-IS — the script re-execs under nice, takes the
//     host-wide heavy lock, rebuilds dist only when stale, and enforces its
//     own refusals; dev.check adds no vitest flag and makes no selection
//     (only the sanctioned `--range a..b` pass-through when the input scoped
//     one), D-G kept intact;
//   - `knip` when its §1 condition holds — the whole-project check runs when
//     the diff ADDS a file, touches entrypoints/configuration/dependencies,
//     or changes import/export lines. The condition is evaluated here as a
//     CONSERVATIVE approximation biased toward running (an unnecessary run
//     is cheap; a skipped required run is a hole) and can be forced with
//     `knip: 'force'`; skipped runs are recorded as skipped with the reason.
//   - `scripts/denylist-scan` (whole-tree today; the diff-scoped mode is the
//     protected script's future, not this wrapper's),
//   - `git diff --check` ×3 — committed (against the pinned base or the
//     explicit range), staged, unstaged.
//
// EVERY gate's verdict is recorded (pass/fail/skipped) with its exit code,
// duration and an evidence tail; the record lands in the branch's dev-record
// whether the run passed or failed (evidence is not deleted by a red gate).
// A red run maps to the `failed` taxonomy (CLI exit 1); green returns the
// report as the ok value. The load stamp (contract §5) is sampled at run
// start; test:narrow's own `result=` line carries its internal stamp.
import { createHash } from 'node:crypto';
import type { Op } from '../../kernel/types.js';
import type { DevEffects, CommandResult } from './effects.js';
import { branchFromRevParse, gitOut, requireGitOut } from './effects.js';
import type { DevCheckGate, DevCheckRecord, DevLoadStamp } from './record.js';
import { DEFAULT_DEV_TARGET, DEV_LEDGER_VERSION, repoRootFault } from './record.js';

/** Wall-clock caps, generous outer bounds (each inner tool enforces its own). */
export const STATIC_GATE_TIMEOUT_MS = 10 * 60 * 1000;
export const TEST_NARROW_TIMEOUT_MS = 30 * 60 * 1000;
export const KNIP_TIMEOUT_MS = 10 * 60 * 1000;
export const DENYLIST_TIMEOUT_MS = 10 * 60 * 1000;
export const GIT_TIMEOUT_MS = 60 * 1000;

/** Input of the `dev.check` op (plain JSON; the registry schema mirrors it). */
export interface DevCheckInput {
  /** Repository the gates run in (the subprocess effects bind to it). */
  repoRoot: string;
  /** The intended PR target branch (default: the documented queue target). */
  target?: string;
  /** Explicit `a..b` commit range replacing the default merge-base pin. */
  range?: string;
  /** The knip condition: 'auto' (default) evaluates §1; 'force' always runs. */
  knip?: 'auto' | 'force';
}

/** The dev.check report — the ok value and the persisted check record's evidence. */
export interface DevCheckReport {
  checkId: string;
  target: string;
  base: string;
  head: string;
  dirtySha256: string;
  range?: string;
  passed: boolean;
  gates: DevCheckGate[];
  loadStamp: DevLoadStamp;
  at: string;
}

/** The `a..b` range shape: two non-empty refs joined by '..'. */
export function rangeFault(range: string): string | null {
  const parts = range.split('..');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return `range '${range}' must be '<ref>..<ref>'`;
  }
  if (parts[0] === parts[1]) {
    return `range '${range}' is empty (identical endpoints)`;
  }
  return null;
}

/** The knip mode: 'auto' (the §1 approximation) or 'force'. */
export type KnipMode = 'auto' | 'force';

/** A gate execution bound to the effects: the runner the op composes. */
type RunGate = (gate: {
  name: string;
  command: string;
  args: readonly string[];
  timeoutMs: number;
}) => Promise<DevCheckGate>;

/** Extract a bounded evidence tail from a gate's captured streams. */
function evidenceTail(result: CommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  if (text === '') return '(no output)';
  const lines = text.split('\n');
  const tail = lines.slice(-20).join('\n');
  return tail.length > 2000 ? `…${tail.slice(-2000)}` : tail;
}

/**
 * Classify one gate result: exit 0 → pass; anything else (non-zero exit,
 * SIGKILL timeout, null code) → fail with the evidence tail. Spawn faults
 * REJECT — a tool that could not run is an environment fault for the whole
 * op, never a green row.
 */
function classifyGate(name: string, result: CommandResult, startedAtMs: number): DevCheckGate {
  const durationMs = Date.now() - startedAtMs;
  if (result.exitCode === 0 && !result.timedOut) {
    return { name, status: 'pass', exitCode: 0, durationMs, evidence: evidenceTail(result) };
  }
  const why = result.timedOut
    ? 'timed out and was SIGKILLed'
    : `exit ${result.exitCode === null ? 'none (killed)' : String(result.exitCode)}`;
  return {
    name,
    status: 'fail',
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    durationMs,
    evidence: `${why} — ${evidenceTail(result)}`,
  };
}

/**
 * Files the diff touches, split into the shapes the knip condition reads:
 * added paths, configuration/dependency paths, and whether any import or
 * export line changed. Untracked non-ignored files count as added — a brand
 * new source file nothing imports yet is knip's orphan class.
 */
async function diffShape(
  effects: DevEffects,
  diffArgs: readonly string[],
): Promise<{ added: number; configTouched: boolean; importChanged: boolean }> {
  const nameStatus = await effects.runCommand('git', ['diff', '--name-status', ...diffArgs], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const names = nameStatus.exitCode === 0 ? nameStatus.stdout : '';
  let added = 0;
  let configTouched = false;
  // FAIL-SAFE toward running: an unreadable diff must never SKIP the
  // whole-project check, so an unreadable read counts as an import change.
  let readsFailed = nameStatus.exitCode !== 0;
  for (const line of names.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    const path = text.slice(text.indexOf('\t') + 1).trim();
    if (text.startsWith('A')) added += 1;
    if (
      path === 'package.json' ||
      path === 'pnpm-lock.yaml' ||
      path === 'knip.json' ||
      path === 'vitest.config.ts' ||
      path.startsWith('tsconfig') ||
      path.startsWith('.github/')
    ) {
      configTouched = true;
    }
  }
  const patch = await effects.runCommand('git', ['diff', ...diffArgs], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  let importChanged = readsFailed;
  if (patch.exitCode === 0) {
    for (const line of patch.stdout.split('\n')) {
      if (/^[+-]/.test(line) && !/^[+-][+-]/.test(line) && /\b(import|export)\b/.test(line)) {
        importChanged = true;
        break;
      }
    }
  } else {
    importChanged = true;
  }
  return { added, configTouched, importChanged };
}

/**
 * Build the `dev.check` op over injected effects. Per call: resolve the
 * diff identity (pin the immutable base), run the gates in sequence,
 * persist the record, and return ok/failed per the verdict.
 */
export function makeDevCheck(effects: DevEffects): Op<DevCheckInput, DevCheckReport> {
  return async (input) => {
    // Library boundary BEFORE any effect (the repoRootFault pattern).
    const rootFault = repoRootFault(input.repoRoot);
    if (rootFault !== null) return { status: 'failed', error: `dev.check: ${rootFault}` };
    if (input.range !== undefined) {
      const fault = rangeFault(input.range);
      if (fault !== null) return { status: 'failed', error: `dev.check: ${fault}` };
    }
    const target = input.target ?? DEFAULT_DEV_TARGET;
    const knipMode: KnipMode = input.knip ?? 'auto';

    // Identity. A detached head has no branch to record evidence under.
    const branchOut = branchFromRevParse(
      await effects.runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );
    if (branchOut === null) {
      return {
        status: 'needs-human',
        reason:
          'dev.check records evidence per branch and HEAD is detached — check out a branch and re-run',
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

    // The committed-diff leg's ref pair: an explicit range, or the pinned
    // merge-base against the intended target (never a moving branch tip).
    // A range is resolved to COMMIT SHAS and its end must BE the recorded
    // HEAD — the record's identity triple describes HEAD, so a check whose
    // committed leg reviewed some other endpoint would be incoherent
    // evidence.
    let base: string;
    let diffArgs: string[];
    if (input.range !== undefined) {
      const [rawStart, rawEnd] = input.range.split('..') as [string, string];
      const resolveRef = async (ref: string): Promise<string | null> =>
        gitOut(
          await effects.runCommand('git', ['rev-parse', `${ref}^{commit}`], {
            timeoutMs: GIT_TIMEOUT_MS,
          }),
        );
      const start = await resolveRef(rawStart);
      const end = await resolveRef(rawEnd);
      if (start === null || end === null) {
        return {
          status: 'needs-human',
          reason: `the range '${input.range}' did not resolve to two commits — pin resolved shas and re-run`,
        };
      }
      if (end !== head) {
        return {
          status: 'needs-human',
          reason: `the range end ${end} is not the current HEAD ${head} — a dev.check record describes HEAD, so the range must end at HEAD`,
        };
      }
      base = start;
      diffArgs = [start, end];
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
      diffArgs = [mergeBase, 'HEAD'];
    }

    // FAIL-CLOSED: a failed dirty-diff read is a refusal, never a
    // fabricated clean-tree identity.
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
      dirtySha256 =
        diffText === '' ? 'clean-tree' : createHash('sha256').update(diffText).digest('hex');
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `the dirty-diff identity could not be read — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const loadStamp = effects.loadStamp();
    const at = effects.nowIso();

    const runGate: RunGate = async ({ name, command, args, timeoutMs }) => {
      const startedAt = Date.now();
      const result = await effects.runCommand(command, args, { timeoutMs });
      return classifyGate(name, result, startedAt);
    };

    const gates: DevCheckGate[] = [];
    gates.push(
      await runGate({
        name: 'check:static',
        command: 'pnpm',
        args: ['run', 'check:static'],
        timeoutMs: STATIC_GATE_TIMEOUT_MS,
      }),
    );
    gates.push(
      await runGate({
        name: 'format:check',
        command: 'pnpm',
        args: ['run', 'format:check'],
        timeoutMs: STATIC_GATE_TIMEOUT_MS,
      }),
    );

    // test:narrow AS-IS: the pass-through flags are only the sanctioned
    // `--range`; the script owns selection, nice, and the heavy lock.
    gates.push(
      await runGate({
        name: 'test:narrow',
        command: 'pnpm',
        args: input.range !== undefined ? ['test:narrow', '--range', input.range] : ['test:narrow'],
        timeoutMs: TEST_NARROW_TIMEOUT_MS,
      }),
    );

    // The knip condition (contract §1), evaluated as a conservative
    // approximation biased toward running. Untracked non-ignored files are
    // added files by definition (a new file nothing imports is itself an
    // orphan).
    let knipSkippedReason: string | undefined;
    if (knipMode === 'auto') {
      const shape = await diffShape(effects, diffArgs);
      const untracked = await effects.runCommand(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      const untrackedCount =
        untracked.exitCode === 0
          ? untracked.stdout.split('\n').filter((l) => l.trim() !== '').length
          : 0;
      if (
        shape.added === 0 &&
        !shape.configTouched &&
        !shape.importChanged &&
        untrackedCount === 0
      ) {
        knipSkippedReason =
          'knip condition not met (no added files, no entrypoint/config/dependency touch, no import/export line change)';
      }
    }
    if (knipMode === 'force' || knipSkippedReason === undefined) {
      gates.push(
        await runGate({
          name: 'knip',
          command: 'pnpm',
          args: ['run', 'knip'],
          timeoutMs: KNIP_TIMEOUT_MS,
        }),
      );
    } else {
      gates.push({ name: 'knip', status: 'skipped', durationMs: 0, evidence: knipSkippedReason });
    }

    gates.push(
      await runGate({
        name: 'denylist-scan',
        command: 'node',
        args: ['scripts/denylist-scan'],
        timeoutMs: DENYLIST_TIMEOUT_MS,
      }),
    );

    // The three whitespace/conflict-marker checks (protocol §5's commands,
    // all three always — a clean worktree alone does not check committed
    // changes).
    gates.push(
      await runGate({
        name: 'diff-check:committed',
        command: 'git',
        args: ['diff', '--check', ...diffArgs],
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );
    gates.push(
      await runGate({
        name: 'diff-check:staged',
        command: 'git',
        args: ['diff', '--check', '--cached'],
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );
    gates.push(
      await runGate({
        name: 'diff-check:unstaged',
        command: 'git',
        args: ['diff', '--check'],
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );

    const red = gates.filter((gate) => gate.status === 'fail');
    const passed = red.length === 0;
    // The record lands whether the run passed or failed (evidence is not
    // deleted by a red gate), and the check id is minted INSIDE the store
    // mutex so two concurrent checks can never mint the same id. The store
    // construction is inside the guarded span: the gates already ran, and a
    // store fault must still report their verdict.
    let persisted: DevCheckRecord;
    try {
      const store = effects.openLedger(branchOut);
      persisted = await store.mutate((ledger) => {
        const checkCount = ledger.records.filter((record) => record.kind === 'check').length;
        const record: DevCheckRecord = {
          kind: 'check',
          checkId: `k${String(checkCount + 1).padStart(3, '0')}-${head.slice(0, 8)}`,
          target,
          base,
          head,
          dirtySha256,
          ...(input.range !== undefined ? { range: input.range } : {}),
          passed,
          gates,
          loadStamp,
          at,
        };
        return {
          ledger: {
            version: DEV_LEDGER_VERSION,
            branch: ledger.branch,
            records: [...ledger.records, record],
          },
          value: record,
        };
      });
    } catch (err) {
      // The gates ran and were classified; losing the record is itself a
      // failure the author must see — the verdict is reported with the
      // store fault, never silently dropped.
      const verdict = passed
        ? 'all gates green'
        : `red gates: ${red.map((g) => g.name).join(', ')}`;
      return {
        status: 'failed',
        error: `dev.check: ${verdict}, but the record could not be persisted — ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const report: DevCheckReport = {
      checkId: persisted.checkId,
      target,
      base,
      head,
      dirtySha256,
      ...(input.range !== undefined ? { range: input.range } : {}),
      passed,
      gates,
      loadStamp,
      at,
    };

    if (passed) return { status: 'ok', value: report };
    return {
      status: 'failed',
      error: `dev.check: ${String(red.length)} gate(s) red (${red
        .map((gate) => gate.name)
        .join(', ')}) — record ${persisted.checkId} is in the branch dev-record`,
    };
  };
}
