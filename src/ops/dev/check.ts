// Dev lane — `dev.check`: the deterministic gate set composed over the diff
// (strategy §3, dev.check row). A WRAPPER over existing code: it runs the
// focused-checks contract's local duty as commands and records the verdicts
// as data; it adds no gate logic of its own.
//
//   - check:static (lint/typecheck are its aliases — never run separately),
//     format:check;
//   - `pnpm test:narrow` AS-IS (nice re-exec, heavy lock and refusals are
//     the script's, D-G), given the RESOLVED base sha (or the resolved
//     `--range`), so its selection is the diff this record pins;
//   - `knip` when its condition can hold (focused-checks contract §1),
//     decided from PATH CLASSES, biased toward running: any added, deleted
//     or untracked file, or any touched JS/TS source, package manifest,
//     lockfile, knip or tsconfig file runs it; a diff of only modified
//     non-code files (docs, workflows, data) skips it, recorded as skipped
//     with the reason. No import line is parsed: an unnecessary knip run is
//     cheap, a skipped required run is a hole;
//   - `scripts/denylist-scan` over the tracked content being checked — the
//     HEAD archive with the staged/unstaged patch applied, so a green row
//     means the CURRENT identity was scanned (the protected script's
//     diff-scoped mode stays its future);
//   - `git diff --check` ×3 — committed (against the pinned base or the
//     range), staged, unstaged.
//
// EVERY gate's verdict is recorded (pass/fail/skipped) with its exit code,
// duration and an evidence tail; the record lands in the branch dev-record
// whether the run passed or failed. A red run maps to `failed` (CLI exit 1);
// green returns the report. The gates run in the live worktree; the record
// is bound to the identity read before them (author tier, strategy §2.4).
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readdir, readFile, readlink } from 'node:fs/promises';
import type { Op } from '../../kernel/types.js';
import { adapterByName, parseCheckOutput } from '../gates/checkRunner.js';
import type { AdapterName } from '../gates/checkRunner.js';
import { parseCqConfig } from '../analyze/cqConfig.js';
import type { ComponentScan, DiffSecretScanner, ScanComponentInput } from './denylist.js';
import type { CommandResult, DevEffects } from './effects.js';
import { faultText, guardDevOp } from './effects.js';
import type { DevCheckGate, DevCheckRecord, DevLoadStamp } from './record.js';
import { DEFAULT_DEV_TARGET, DEV_LEDGER_VERSION } from './record.js';
import { DevCheckInputSchema } from './registry.js';
import { git, gitStdout, IDENTITY_DIFF_FLAGS, readWorkState, zList } from './internal/workState.js';

/** Wall-clock caps, generous outer bounds (each inner tool enforces its own). */
export const STATIC_GATE_TIMEOUT_MS = 10 * 60 * 1000;
export const TEST_NARROW_TIMEOUT_MS = 30 * 60 * 1000;
export const KNIP_TIMEOUT_MS = 10 * 60 * 1000;
export const DENYLIST_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_GATE_TIMEOUT_MS = 60 * 1000;

/** Input of the `dev.check` op (plain JSON; the registry schema mirrors it). */
export interface DevCheckInput {
  /** Repository the gates run in (the subprocess effects bind to it). */
  repoRoot: string;
  /** The intended PR target branch (default: the documented queue target). */
  target?: string;
  /** Explicit `a..b` commit range replacing the default merge-base pin; `b` must be HEAD. */
  range?: string;
  /**
   * Opt the automated test:narrow gate INTO the integration suite
   * (`--include-integration`), for both the --base and --range forms. The
   * selector's closure can name e2e files for plain src changes, and the
   * gate refusal can never be satisfied from inside dev.check — the caller
   * must opt in (S7 dogfood attempt A). Default off; the record carries the
   * choice (includeIntegration: true) so readers can see the opt-in.
   */
  includeIntegration?: boolean;
  /**
   * Name the EXACT test files the gate runs (the wrapper's own escape for
   * a too-broad automatic selection, S7 dogfood attempt B): replaces the
   * `--base`/`--range` selection entirely, so a `range` supplied alongside
   * is refused — the record must never pair a range with the
   * named-selection disclosure. The names ride argv positionals
   * after the flags, so a dash-prefixed value is refused here (option
   * injection); the record discloses the narrowing as
   * `testSelection: { mode: 'named', files }` — a reader must be able to
   * tell a named gate from an automatic one.
   */
  testFiles?: string[];
}

/** The dev.check report — the ok value and the persisted check record's evidence. */
export type DevCheckReport = Omit<DevCheckRecord, 'kind'>;

/** The `a..b` range shape: two non-empty refs joined by '..', neither spelled as an option. */
export function rangeFault(range: string): string | null {
  const parts = range.split('..');
  if (parts.length !== 2 || parts.some((part) => part === '' || part.startsWith('-'))) {
    return `range '${range}' must be '<ref>..<ref>'`;
  }
  if (parts[0] === parts[1]) return `range '${range}' is empty (identical endpoints)`;
  return null;
}

/**
 * Paths whose change can move knip's verdict when merely MODIFIED: JS/TS
 * sources (imports, exports, entrypoints) and the dependency/config files
 * knip reads.
 */
const KNIP_RELEVANT_PATH =
  /\.[cm]?[jt]sx?$|(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|knip\.jsonc?|tsconfig[^/]*\.json)$/;

/**
 * Whether knip must run for a `--name-status -z` listing plus the untracked
 * paths: the reason it runs, or null when the diff only modifies non-code
 * files.
 */
export function knipTrigger(nameStatusZ: string, untracked: readonly string[]): string | null {
  if (untracked.length > 0) return `untracked file ${untracked[0] ?? ''}`;
  const entries = zList(nameStatusZ);
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const status = entries[index] ?? '';
    const path = entries[index + 1] ?? '';
    if (status.startsWith('A') || status.startsWith('D')) return `${status} ${path}`;
    if (KNIP_RELEVANT_PATH.test(path)) return `modified ${path}`;
  }
  return null;
}

/** Extract a bounded evidence tail from a gate's captured streams. */
function evidenceTail(result: CommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  if (text === '') return '(no output)';
  const tail = text.split('\n').slice(-20).join('\n');
  return tail.length > 2000 ? `…${tail.slice(-2000)}` : tail;
}

/**
 * Classify one gate result: exit 0 → pass; anything else (non-zero exit,
 * SIGKILL timeout) → fail with the evidence tail.
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
 * Run one gate; a runner that REJECTS (spawn fault, output overflow) is a
 * failed row, never an op crash — earlier verdicts survive and the record
 * still lands.
 */
async function runGate(
  effects: DevEffects,
  name: string,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  cwd?: string,
  adapter?: AdapterName,
): Promise<DevCheckGate> {
  const startedAt = Date.now();
  try {
    const resolvedCwd = cwd === undefined ? undefined : resolve(cwd);
    const resolvedExe =
      resolvedCwd !== undefined && !isAbsolute(command) && /[\\/]/.test(command)
        ? resolve(resolvedCwd, command)
        : command;
    const result = await effects.runCommand(resolvedExe, args, {
      timeoutMs,
      ...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
    });
    if (adapter !== undefined) {
      const parsed = parseCheckOutput(adapterByName(adapter), {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
      if (parsed.verdict === 'indeterminate') {
        return {
          name,
          status: 'fail',
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
          durationMs: Date.now() - startedAt,
          evidence: `no trustworthy adapter result — ${parsed.reason}; ${evidenceTail(result)}`,
        };
      }
      if (parsed.set.failures.length > 0) {
        return {
          name,
          status: 'fail',
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
          durationMs: Date.now() - startedAt,
          evidence: `${String(parsed.set.failures.length)} failure(s) reported by ${adapter}; ${evidenceTail(result)}`,
        };
      }
    }
    return classifyGate(name, result, startedAt);
  } catch (err) {
    return {
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      evidence: `could not run — ${faultText(err)}`,
    };
  }
}

/**
 * The tracked-content denylist scan: the (protected, invoked read-only)
 * script scans the tree it lives in, so run it over an extraction of
 * `git archive HEAD` in a scratch dir OUTSIDE the worktree with the exact
 * staged+unstaged patch applied — gitignored scratch is excluded by
 * construction, and a newly staged file is included. Any step failing
 * faults the gate (never a silently green scan).
 */
async function treeComponents(
  tree: string,
  excludedPaths: readonly string[] = [],
): Promise<ScanComponentInput[]> {
  const excluded = new Set(excludedPaths);
  const components: ScanComponentInput[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (excluded.has(path)) continue;
      if (entry.isDirectory()) {
        await visit(absolute, path);
      } else if (entry.isFile()) {
        components.push({
          component: `tracked:${path}`,
          path,
          text: await readFile(absolute, 'utf8'),
        });
      } else if (entry.isSymbolicLink()) {
        components.push({ component: `tracked:${path}`, path, text: await readlink(absolute) });
      } else {
        throw new Error(`denylist: unsupported tracked tree entry '${path}'`);
      }
    }
  };
  await visit(tree, '');
  return components;
}

function scanVerdict(scans: readonly ComponentScan[], startedAt: number): DevCheckGate {
  const hits = scans.flatMap((scan) =>
    scan.hits.map((hit) => `${scan.component}:${hit.ruleId}:${hit.lines.join(',')}`),
  );
  return {
    name: 'denylist-scan',
    status: hits.length === 0 ? 'pass' : 'fail',
    durationMs: Date.now() - startedAt,
    evidence: hits.length === 0 ? 'tracked tree clean' : `secret findings: ${hits.join('; ')}`,
  };
}

async function denylistGate(
  effects: DevEffects,
  scanSecrets?: DiffSecretScanner,
  excludedPaths: readonly string[] = [],
): Promise<DevCheckGate> {
  const startedAt = Date.now();
  let scratch: string | undefined;
  try {
    scratch = await effects.makeScratchDir('denylist-tree');
    const archive = join(scratch, 'tree.tar');
    const tree = join(scratch, 'tree');
    const workPatch = join(scratch, 'work.patch');
    gitStdout(
      await git(effects, ['archive', '--format=tar', '--output', archive, 'HEAD']),
      'archive HEAD',
    );
    await effects.ensureDir(tree);
    const extract = await effects.runCommand('tar', ['-x', '-f', archive, '-C', tree], {
      timeoutMs: GIT_GATE_TIMEOUT_MS,
    });
    if (extract.exitCode !== 0) {
      throw new Error(`archive extraction failed — ${extract.stderr.trim().slice(0, 200)}`);
    }
    gitStdout(
      await git(effects, ['diff', ...IDENTITY_DIFF_FLAGS, `--output=${workPatch}`, 'HEAD']),
      'diff HEAD (staged+unstaged patch)',
    );
    gitStdout(
      await git(effects, ['-C', tree, 'apply', '--whitespace=nowarn', '--allow-empty', workPatch]),
      'apply the staged+unstaged patch over the archived tree',
    );
    if (scanSecrets !== undefined) {
      return scanVerdict(await scanSecrets(await treeComponents(tree, excludedPaths)), startedAt);
    }
    const result = await effects.runCommand(
      'node',
      [join(tree, 'scripts', 'denylist-scan'), '--tree'],
      {
        timeoutMs: DENYLIST_TIMEOUT_MS,
      },
    );
    return classifyGate('denylist-scan', result, startedAt);
  } catch (err) {
    return {
      name: 'denylist-scan',
      status: 'fail',
      durationMs: Date.now() - startedAt,
      evidence: `${faultText(err)} — the tracked-tree scan could not run`,
    };
  } finally {
    if (scratch !== undefined) await effects.removeScratchDir(scratch).catch(() => undefined);
  }
}

/**
 * Build the `dev.check` op over injected effects. Per call: read the
 * identity (pin the immutable base), run the gates in sequence, persist the
 * record, and return ok/failed per the verdict.
 */
export function makeDevCheck(
  effects: DevEffects,
  scanSecrets?: DiffSecretScanner,
): Op<DevCheckInput, DevCheckReport> {
  return guardDevOp('dev.check', DevCheckInputSchema, async (input) => {
    const fault = input.range === undefined ? null : rangeFault(input.range);
    if (fault !== null) return { status: 'failed', error: `dev.check: ${fault}` };
    // A named selection REPLACES the `--base`/`--range` selection entirely,
    // so a range supplied alongside it would run no `--range` gate while the
    // record still carried `range` next to `testSelection: { mode: 'named' }`
    // — a reader could not tell which selection actually ran. The two
    // selection inputs are mutually exclusive; refused BEFORE any gate runs,
    // like the named-selection checks below.
    if (input.range !== undefined && input.testFiles !== undefined)
      return {
        status: 'failed',
        error:
          'dev.check: range and testFiles are conflicting selections — testFiles replaces the range entirely; supply the range or the named files, not both',
      };
    // Named files ride argv as positionals AFTER the flags, so any
    // dash-leading segment ("-x" or "test/-evil.test.ts" — a basename
    // starting with '-' reaches getopt once the shell expands it) could be
    // read as an option there. The wrapper refuses option-shaped values for
    // the same reason. Refused BEFORE any gate runs.
    const dashNamed = input.testFiles?.find((file) => /(^|\/)\-/.test(file));
    if (dashNamed !== undefined)
      return {
        status: 'failed',
        error: `dev.check: testFiles entries are file names, not options — refused: ${dashNamed}`,
      };
    // An empty named selection spreads to zero positionals, so the test:narrow
    // gate would carry no --base/--range and no files (the wrapper's default
    // selection runs) while the record still claims { mode: 'named', files:
    // [] }. Refused BEFORE any gate runs, like the dash check above.
    if (input.testFiles !== undefined && input.testFiles.length === 0)
      return {
        status: 'failed',
        error:
          'dev.check: testFiles is empty — a named selection must name at least one file, or omit testFiles to use the range/default selection',
      };
    const target = input.target ?? DEFAULT_DEV_TARGET;

    // A range is resolved to commit shas; its end must BE HEAD, because the
    // record's identity describes HEAD.
    let rangeBase: string | undefined;
    if (input.range !== undefined) {
      const [start, end] = input.range.split('..') as [string, string];
      const resolveRef = async (ref: string): Promise<string | null> => {
        const result = await git(effects, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        return result.exitCode === 0 ? result.stdout.trim() : null;
      };
      const [startSha, endSha, headSha] = [
        await resolveRef(start),
        await resolveRef(end),
        await resolveRef('HEAD'),
      ];
      if (startSha === null || endSha === null) {
        return {
          status: 'needs-human',
          reason: `dev.check: the range '${input.range}' did not resolve to two commits`,
        };
      }
      if (endSha !== headSha) {
        return {
          status: 'needs-human',
          reason: `dev.check: the range end ${endSha} is not HEAD ${String(headSha)} — a dev.check record describes HEAD, so the range must end there`,
        };
      }
      rangeBase = startSha;
    }
    const read = await readWorkState(effects, {
      target,
      ...(rangeBase !== undefined ? { base: rangeBase } : {}),
    });
    if (!read.ok) return { status: 'needs-human', reason: `dev.check: ${read.reason}` };
    const state = read.state;

    const loadStamp: DevLoadStamp = effects.loadStamp();
    const at = effects.nowIso();
    const gates: DevCheckGate[] = [];
    const configText = await readFile(join(input.repoRoot, 'cq.json'), 'utf8').catch(() => null);
    const packageText = await readFile(join(input.repoRoot, 'package.json'), 'utf8').catch(
      () => '{}',
    );
    let packageName = '';
    try {
      const packageData: unknown = JSON.parse(packageText);
      if (
        typeof packageData === 'object' &&
        packageData !== null &&
        'name' in packageData &&
        typeof packageData.name === 'string'
      )
        packageName = packageData.name;
    } catch {
      /* absent package metadata retains the legacy gate set */
    }
    const config = configText === null ? null : parseCqConfig(configText, input.repoRoot);
    if (config?.ok === false) {
      return { status: 'needs-human', reason: `dev.check: cq.json — ${config.reason}` };
    }
    // Owner decision 12: configured checks are authoritative for adopters.
    // cq-toolkit keeps the legacy set until #411 adds its test check.
    const configuredChecks =
      config?.ok === true &&
      config.config.checks.length > 0 &&
      packageName !== '@camerontaylor/cq-toolkit'
        ? config.config.checks.filter((check) => check.addressOnly !== true)
        : null;
    if (configuredChecks?.length === 0) {
      return {
        status: 'needs-human',
        reason:
          'dev.check: no repository checks configured (address-only checks require finding-file scope)',
      };
    }
    const configuredPatternsFile =
      configuredChecks !== null ? config?.config.review?.denylistPatternsFile : undefined;
    const configuredPatternsPath =
      configuredPatternsFile === undefined
        ? undefined
        : relative(resolve(input.repoRoot), resolve(input.repoRoot, configuredPatternsFile))
            .split(sep)
            .join('/');
    const excludedScanPaths =
      configuredPatternsPath === undefined ||
      configuredPatternsPath === '..' ||
      configuredPatternsPath.startsWith('../') ||
      isAbsolute(configuredPatternsPath)
        ? []
        : [configuredPatternsPath];
    if (configuredChecks !== null) {
      for (const [index, check] of configuredChecks.entries()) {
        gates.push(
          await runGate(
            effects,
            `cq.json:${String(index + 1)}:${check.adapter}`,
            check.command.command,
            check.command.args,
            check.command.timeoutMs ?? STATIC_GATE_TIMEOUT_MS,
            resolve(input.repoRoot, check.command.cwd ?? '.'),
            check.adapter,
          ),
        );
      }
    } else {
      gates.push(
        await runGate(
          effects,
          'check:static',
          'pnpm',
          ['run', 'check:static'],
          STATIC_GATE_TIMEOUT_MS,
        ),
      );
      gates.push(
        await runGate(
          effects,
          'format:check',
          'pnpm',
          ['run', 'format:check'],
          STATIC_GATE_TIMEOUT_MS,
        ),
      );
      gates.push(
        await runGate(
          effects,
          'test:narrow',
          'pnpm',
          [
            'test:narrow',
            ...(input.includeIntegration === true ? ['--include-integration'] : []),
            ...(input.testFiles !== undefined
              ? input.testFiles
              : input.range !== undefined
                ? ['--range', `${state.base}..${state.head}`]
                : ['--base', state.base]),
          ],
          TEST_NARROW_TIMEOUT_MS,
        ),
      );

      // The knip condition reads base → WORKING TREE (committed, staged and
      // unstaged together) plus the untracked list. An unreadable listing
      // runs knip (fail-safe toward running).
      const nameStatus = await git(effects, [
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        state.base,
      ]);
      const trigger =
        nameStatus.exitCode === 0
          ? knipTrigger(nameStatus.stdout, state.untracked)
          : 'the diff listing could not be read';
      gates.push(
        trigger !== null
          ? await runGate(effects, 'knip', 'pnpm', ['run', 'knip'], KNIP_TIMEOUT_MS)
          : {
              name: 'knip',
              status: 'skipped',
              durationMs: 0,
              evidence:
                'knip condition not met: the diff only modifies non-code files (no added, deleted or untracked file; no JS/TS, manifest, lockfile, knip or tsconfig change)',
            },
      );
    }

    gates.push(
      await denylistGate(
        effects,
        configuredChecks === null ? undefined : scanSecrets,
        excludedScanPaths,
      ),
    );

    const committedLeg = [state.base, state.head];
    for (const [name, args] of [
      ['diff-check:committed', ['diff', '--check', ...committedLeg]],
      ['diff-check:staged', ['diff', '--check', '--cached']],
      ['diff-check:unstaged', ['diff', '--check']],
    ] as const) {
      gates.push(await runGate(effects, name, 'git', args, GIT_GATE_TIMEOUT_MS));
    }

    const red = gates.filter((gate) => gate.status === 'fail').map((gate) => gate.name);
    const passed = red.length === 0;
    // The record lands whether the run passed or failed; the check id is
    // minted INSIDE the store mutex, and a store fault still reports the
    // verdict.
    let record: DevCheckRecord;
    try {
      record = await effects.openLedger(state.branch).mutate((ledger) => {
        const checkCount = ledger.records.filter((entry) => entry.kind === 'check').length;
        const entry: DevCheckRecord = {
          kind: 'check',
          checkId: `k${String(checkCount + 1).padStart(3, '0')}-${state.head.slice(0, 8)}`,
          target,
          base: state.base,
          head: state.head,
          dirtySha256: state.dirtySha256,
          ...(input.range !== undefined ? { range: input.range } : {}),
          // Only the legacy test:narrow gate consumes these inputs; with
          // configured checks (cq.json) no test gate runs, so the record
          // must not claim a test scope it never had.
          ...(configuredChecks === null && input.includeIntegration === true
            ? { includeIntegration: true }
            : {}),
          ...(configuredChecks === null
            ? {
                testSelection:
                  input.testFiles !== undefined
                    ? { mode: 'named', files: [...input.testFiles] }
                    : input.range !== undefined
                      ? { mode: 'range' }
                      : { mode: 'base' },
              }
            : {}),
          passed,
          gates,
          loadStamp,
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
      const verdict = passed ? 'all gates green' : `red gates: ${red.join(', ')}`;
      return {
        status: 'failed',
        error: `dev.check: ${verdict}, but the record could not be persisted — ${faultText(err)}`,
      };
    }
    const { kind: _kind, ...report } = record;
    if (passed) return { status: 'ok', value: report };
    return {
      status: 'failed',
      error: `dev.check: ${String(red.length)} gate(s) red (${red.join(', ')}) — record ${record.checkId} is in the branch dev-record`,
    };
  });
}
