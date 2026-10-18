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
//   - `scripts/denylist-scan` over the tracked content being checked — the
//     HEAD archive with the staged/unstaged patch applied over it, so a
//     green row means the CURRENT identity was scanned, not the previous
//     commit (the protected script's diff-scoped mode stays its future),
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
import { join } from 'node:path';
import type { Op } from '../../kernel/types.js';
import type { DevEffects, CommandResult } from './effects.js';
import { branchFromRevParse, gitOut, requireGitOut } from './effects.js';
import type { DevCheckGate, DevCheckRecord, DevLoadStamp } from './record.js';
import {
  DEFAULT_DEV_TARGET,
  DEV_LEDGER_VERSION,
  objectInputFault,
  repoRootFault,
} from './record.js';

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
 * Minimal glob → RegExp for knip.json's `entry`/`project` path patterns:
 * LITERAL paths and single-segment `*` only. Everything micromatch models
 * richer than that is rejected as UNMODELABLE and the caller FAILS SAFE
 * toward running knip rather than silently missing a configured
 * entrypoint: `**` (real micromatch also matches the zero-segment form —
 * `src/**` + `/x` matches `src/x` — which a literal `.*` translation
 * misrepresents), `?`, character classes, braces, extglobs, negation
 * leaders, and backslash escapes. The shipped knip.json entries need only
 * literals and single-segment `*`.
 */
function compileGlob(pattern: string): RegExp | null {
  if (pattern.includes('**') || pattern.includes('\\')) return null;
  if (/[?[\]{}!]/.test(pattern)) return null;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Read knip.json's entry patterns (bounded read; a malformed or unreadable
 * file yields null and the caller FAILS SAFE toward running knip).
 */
async function knipEntryPatterns(effects: DevEffects): Promise<readonly string[] | null> {
  const read = await effects.readWorktreeFile('knip.json', 256 * 1024);
  if (!read.ok) return null;
  try {
    const parsed: unknown = JSON.parse(read.text);
    const entry = (parsed as { entry?: unknown }).entry;
    if (!Array.isArray(entry)) return null;
    const patterns = entry.filter((item): item is string => typeof item === 'string');
    return patterns.length > 0 ? patterns : null;
  } catch {
    return null;
  }
}

/**
 * Files the diff touches, split into the shapes the knip condition reads:
 * added paths, configuration/dependency paths, whether any import or export
 * line changed, and whether a CONFIGURED ENTRYPOINT changed (knip.json's
 * entry set — editing src/cli.ts without touching an import line is still
 * the whole-project check's business). Untracked non-ignored files count as
 * added — a brand new source file nothing imports yet is knip's orphan
 * class.
 */
async function diffShape(
  effects: DevEffects,
  diffArgs: readonly string[],
): Promise<{
  added: number;
  configTouched: boolean;
  importChanged: boolean;
  entryTouched: boolean;
}> {
  const nameStatus = await effects.runCommand('git', ['diff', '--name-status', ...diffArgs], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const names = nameStatus.exitCode === 0 ? nameStatus.stdout : '';
  let added = 0;
  let configTouched = false;
  // FAIL-SAFE toward running: an unreadable diff must never SKIP the
  // whole-project check, so an unreadable read counts as an import change.
  let readsFailed = nameStatus.exitCode !== 0;
  const paths: string[] = [];
  for (const line of names.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    // A status row can carry TWO paths (R/C renames: `R100\told\tnew`) —
    // both are inspected, and neither is collapsed into a bogus combined
    // name. Row-local name is `rowPaths` so the family-wide `paths`
    // accumulator (the entrypoint matcher's input) actually accumulates.
    const rowPaths = text
      .split('\t')
      .slice(1)
      .map((entry) => entry.trim());
    paths.push(...rowPaths);
    if (text.startsWith('A')) added += 1;
    for (const path of rowPaths) {
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
  }
  let entryTouched = false;
  const entryPatterns = await knipEntryPatterns(effects);
  if (entryPatterns === null) {
    // FAIL-SAFE toward running: an unreadable entry set cannot license a
    // skip.
    entryTouched = true;
  } else {
    const matchers: RegExp[] = [];
    let unmodelable = false;
    for (const pattern of entryPatterns) {
      const compiled = compileGlob(pattern);
      if (compiled === null) {
        unmodelable = true;
        break;
      }
      matchers.push(compiled);
    }
    // FAIL-SAFE toward running: a pattern this minimal glob cannot model
    // EXACTLY (braces, extglobs, classes, negation) makes the whole entry
    // set unmodelable — skipping could silently miss a configured
    // entrypoint edit.
    if (unmodelable) {
      entryTouched = true;
    } else {
      for (const path of paths) {
        if (matchers.some((matcher) => matcher.test(path))) {
          entryTouched = true;
          break;
        }
      }
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
  return { added, configTouched, importChanged, entryTouched };
}

/**
 * Build the `dev.check` op over injected effects. Per call: resolve the
 * diff identity (pin the immutable base), run the gates in sequence,
 * persist the record, and return ok/failed per the verdict.
 */
export function makeDevCheck(effects: DevEffects): Op<DevCheckInput, DevCheckReport> {
  return async (input) => {
    // Library boundary BEFORE any effect: the input itself, then repoRoot
    // (a null/undefined input maps to the failed taxonomy, never a
    // TypeError outside it).
    const objectFault = objectInputFault(input);
    if (objectFault !== null) return { status: 'failed', error: `dev.check: ${objectFault}` };
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
      // A REJECTED runner (spawn fault, maxBuffer) is a FAILED GATE ROW, not
      // an op crash — the earlier gates' verdicts survive and the record
      // still lands.
      try {
        const result = await effects.runCommand(command, args, { timeoutMs });
        return classifyGate(name, result, startedAt);
      } catch (err) {
        return {
          name,
          status: 'fail',
          durationMs: Date.now() - startedAt,
          evidence: `could not run — ${err instanceof Error ? err.message : String(err)}`,
        };
      }
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
    // `--range` and the runner's own `--base <ref>` — both given RESOLVED
    // commits, never a moving ref. The selection's merge-base is computed
    // at invocation time (scripts/lib/test-narrow.mjs), so a named branch
    // could move during the earlier gates and select a diff other than the
    // identity this record pins; the immutable shas make the selection the
    // recorded one.
    gates.push(
      await runGate({
        name: 'test:narrow',
        command: 'pnpm',
        args:
          input.range !== undefined
            ? ['test:narrow', '--range', `${base}..${head}`]
            : ['test:narrow', '--base', base],
        timeoutMs: TEST_NARROW_TIMEOUT_MS,
      }),
    );

    // The knip condition (contract §1), evaluated as a conservative
    // approximation biased toward running. Untracked non-ignored files are
    // added files by definition (a new file nothing imports is itself an
    // orphan).
    let knipSkippedReason: string | undefined;
    if (knipMode === 'auto') {
      // The condition reads the diff from the base to the WORKING TREE
      // (base-only, not base..HEAD): staged and unstaged tracked edits are
      // exactly where a new import/export or a dependency touch appears
      // before the first commit.
      const shape = await diffShape(effects, [base]);
      const untracked = await effects.runCommand(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      // FAIL-SAFE toward running: a failed read must never SKIP the
      // whole-project check.
      const untrackedCount =
        untracked.exitCode === 0
          ? untracked.stdout.split('\n').filter((l) => l.trim() !== '').length
          : 1;
      if (
        shape.added === 0 &&
        !shape.configTouched &&
        !shape.importChanged &&
        !shape.entryTouched &&
        untrackedCount === 0
      ) {
        knipSkippedReason =
          'knip condition not met (no added files, no configured-entrypoint/config/dependency touch, no import/export line change)';
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

    // THE TRACKED-CONTENT DENYLIST SCAN VIA ARCHIVE + WORKING PATCH: the
    // (protected, invoked read-only) scripts/denylist-scan scans the tree
    // it lives in, so run it over an extraction of `git archive HEAD` in a
    // scratch dir OUTSIDE the worktree, with the staged and unstaged edits
    // applied over it — the scan then sees exactly the tracked content the
    // run is checking (a newly staged .env included), and gitignored agent
    // scratch is excluded by construction instead of by allowlist.
    {
      const startedAt = Date.now();
      let gate: DevCheckGate;
      let scratch: string | undefined;
      try {
        scratch = await effects.makeScratchDir('denylist-tree');
        const archive = join(scratch, 'tree.tar');
        const tree = join(scratch, 'tree');
        const archiveResult = await effects.runCommand(
          'git',
          ['archive', '--format=tar', '--output', archive, 'HEAD'],
          { timeoutMs: GIT_TIMEOUT_MS },
        );
        if (archiveResult.exitCode !== 0) {
          throw new Error(`git archive failed — ${archiveResult.stderr.trim().slice(0, 200)}`);
        }
        // The extraction dir comes through the fs SEAM (node:fs), never an
        // external mkdir — a Windows PATH with node+git but no Unix
        // userland must still pass this gate. `tar` itself is
        // platform-bundled (bsdtar ships in Windows; GNU tar on Linux); a
        // missing tar faults the gate visibly rather than silently skipping
        // the scan.
        await effects.ensureDir(tree);
        const extract = await effects.runCommand('tar', ['-x', '-f', archive, '-C', tree], {
          timeoutMs: GIT_TIMEOUT_MS,
        });
        if (extract.exitCode !== 0) {
          throw new Error(`archive extraction failed — ${extract.stderr.trim().slice(0, 200)}`);
        }
        // THE STAGED/UNSTAGED LEG: archiving HEAD alone would scan the
        // PREVIOUS committed tree and record a green row while the current
        // identity holds forbidden content. The exact `git diff HEAD`
        // patch (binaries included) is applied over the archive before the
        // scan; the patch file is written by GIT itself into the scratch
        // dir (one `--output` read — no patch text round-trips through this
        // process), `--allow-empty` makes the clean-tree case an explicit
        // no-op, and an unreadable diff or failed apply faults the gate
        // (fail-closed, never a silently green scan).
        const workPatch = join(scratch, 'work.patch');
        const diffResult = await effects.runCommand(
          'git',
          ['diff', '--binary', '--full-index', '--output', workPatch, 'HEAD'],
          { timeoutMs: GIT_TIMEOUT_MS },
        );
        if (diffResult.exitCode !== 0) {
          throw new Error(
            `the staged/unstaged patch could not be read — ${diffResult.stderr.trim().slice(0, 200)}`,
          );
        }
        const apply = await effects.runCommand(
          'git',
          ['-C', tree, 'apply', '--whitespace=nowarn', '--allow-empty', workPatch],
          { timeoutMs: GIT_TIMEOUT_MS },
        );
        if (apply.exitCode !== 0) {
          throw new Error(
            `the staged/unstaged patch could not be applied over the archived tree — ${apply.stderr.trim().slice(0, 200)}`,
          );
        }
        const result = await effects.runCommand('node', [join(tree, 'scripts', 'denylist-scan')], {
          timeoutMs: DENYLIST_TIMEOUT_MS,
        });
        gate = classifyGate('denylist-scan', result, startedAt);
      } catch (err) {
        gate = {
          name: 'denylist-scan',
          status: 'fail',
          durationMs: Date.now() - startedAt,
          evidence: `${err instanceof Error ? err.message : String(err)} — the tracked-tree scan could not run`,
        };
      } finally {
        if (scratch !== undefined) {
          await effects.removeScratchDir(scratch).catch(() => undefined);
        }
      }
      gates.push(gate);
    }

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
