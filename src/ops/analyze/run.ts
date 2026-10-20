// Analyze lane — `analyze.run` (Lane C, S2): the analyze pipeline with REAL
// dataflow — probe → collect → cluster → report — as one sequential SDK
// composition of the family's own ops.
//
// WHY AN OP AND NOT THE PLAN. The kernel plan runner wires ORDER, never
// dataflow (src/plans/analyze.ts header): a plan job's input is static data,
// so the shipped four-job plan cannot hand the probe's FailureSet to collect.
// This op is the composition an adopter would otherwise write by hand: each
// stage's OUTPUT becomes the next stage's INPUT, in-process.
//
// Stages, each mapped onto the frozen taxonomy:
//   0. checks — `input.checks`, else `<dir>/cq.json` (or `configPath`); a
//      missing or invalid config is `failed`, naming `analyze.init`;
//   1. probe — every check through the injected `RunCheck` (production:
//      `subprocessRunCheck`) and its named adapter, with the gates family's
//      central I5 guard (`parseCheckOutput`): an unparsable capture or an
//      empty set behind a non-zero exit is `indeterminate`, never clean;
//      failure paths are normalized to `dir`-relative POSIX paths so the
//      report's evidence and the remediation store agree on file names;
//   2. collect — `analyze.collectFailures` per TOOL (it refuses mixed tools);
//   3. cluster — `analyze.clusterErrors` per tool, merged into one report
//      (clusters sorted by id, then signature);
//   4. report — `analyze.renderAnalysisReport`'s op over a split store that
//      READS target files under `dir` (the staleness digests) and WRITES the
//      pair into `out` (default `<dir>/.cq/analysis`, created when missing).
//      `out` must be a strict descendant of `dir`: `analyze.applyRemediation`
//      reads the sidecar through a store rooted at `dir`, and the attended
//      approval exempts `.cq/` from the clean-tree predicate.
// A failure whose file lies OUTSIDE `dir` (a monorepo `paths` mapping, a
// sibling package) stays counted in its check's `failures` but is excluded
// from the clustered and rendered set — the report's evidence store is rooted
// at `dir` — and is surfaced as `skippedOutsideDir` with the paths, so
// nothing is silently hidden.
// An empty failure set is an honest `ok` with `failureCount: 0` (and an empty
// report pair), because every check parsed behind exit code 0.
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Op, OpResult } from '../../kernel/types.js';
import { messageOf } from '../../shared/messageOf.js';
import type { CheckFailure, CheckRunnerInput, FailureSet, RunCheck } from '../gates/checkRunner.js';
import { adapterByName, parseCheckOutput, subprocessRunCheck } from '../gates/checkRunner.js';
import type { AnalyzeFileStore } from './analysisStore.js';
import { pathAnalysisFileStore } from './analysisStore.js';
import type { Cluster, ClusterConfidence, ClusterErrorsReport } from './clusterErrors.js';
import { clusterErrorsOp } from './clusterErrors.js';
import { collectFailuresOp } from './collectFailures.js';
import { CQ_CONFIG_FILE, parseCqConfig } from './cqConfig.js';
import { makeRenderAnalysisReport } from './renderAnalysisReport.js';

/** The default report directory, relative to the project directory. */
export const ANALYZE_DEFAULT_OUT = join('.cq', 'analysis');

/** JSON-serializable input of the `analyze.run` op. */
export interface AnalyzeRunInput {
  /** The project directory: checks run relative to it, failure paths are reported relative to it. */
  dir: string;
  /** The checks to run; when absent, read from `configPath` (default `<dir>/cq.json`). */
  checks?: CheckRunnerInput[];
  /** The config to read when `checks` is absent (relative paths resolve against `dir`). */
  configPath?: string;
  /** Report directory (relative paths resolve against `dir`); must lie inside `dir`. Default `.cq/analysis`. */
  out?: string;
}

/** One check's outcome in the run summary. */
export interface AnalyzeRunCheckSummary {
  adapter: CheckRunnerInput['adapter'];
  tool: string;
  exitCode: number | null;
  failures: number;
}

/** One cluster, summarized for the caller (the sidecar carries the full members). */
export interface AnalyzeRunCluster {
  id: string;
  signature: string;
  tool: string;
  ruleId: string | null;
  count: number;
  confidence: ClusterConfidence;
  /** The distinct member files, sorted (dir-relative). */
  files: string[];
}

/** The `analyze.run` value. */
export interface AnalyzeRunReport {
  /** Per-check outcomes, in check order. */
  checks: AnalyzeRunCheckSummary[];
  /** Distinct failures inside `dir` across every tool (the clustered set). */
  failureCount: number;
  /** Failures whose file lies outside `dir`: counted per check, not clustered. */
  skippedOutsideDir: number;
  /** The distinct outside-`dir` files behind {@link skippedOutsideDir}, sorted. */
  outsideDirFiles: string[];
  clusters: AnalyzeRunCluster[];
  markdownPath: string;
  sidecarPath: string;
  reportFingerprint: string;
  /** The config read, when the checks came from one. */
  configPath?: string;
}

/** Probe → collect → cluster, without rendering: what `analyze.fix`'s recheck needs. */
export interface AnalysisSnapshot {
  checks: AnalyzeRunCheckSummary[];
  /** One collected set per tool, in first-seen order. */
  sets: FailureSet[];
  report: ClusterErrorsReport;
  failureCount: number;
  skippedOutsideDir: number;
  outsideDirFiles: string[];
}

/**
 * Resolve the checks for a run: the explicit list, else the config file.
 * A missing or invalid config is a `failed` reason naming `analyze.init`.
 */
export function resolveChecks(
  dir: string,
  input: { checks?: CheckRunnerInput[]; configPath?: string },
): { ok: true; checks: CheckRunnerInput[]; configPath?: string } | { ok: false; error: string } {
  if (input.checks !== undefined) {
    if (input.checks.length === 0) {
      return { ok: false, error: 'analyze.run: `checks` is empty — pass at least one check' };
    }
    return { ok: true, checks: input.checks };
  }
  const configPath = resolve(dir, input.configPath ?? CQ_CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: `analyze.run: no checks configured — could not read '${configPath}' (${messageOf(err)}); run \`cq analyze.init --dir=${dir}\` to write one, or pass checks explicitly`,
    };
  }
  const parsed = parseCqConfig(text);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `analyze.run: '${configPath}' ${parsed.reason}; fix it, or regenerate it with \`cq analyze.init --dir=${dir} --force\``,
    };
  }
  return { ok: true, checks: parsed.config.checks, configPath };
}

/** The check's command with cwd and relative command paths resolved against `dir`. */
function resolvedCommand(dir: string, check: CheckRunnerInput): CheckRunnerInput['command'] {
  const cwd = resolve(dir, check.command.cwd ?? '.');
  const command =
    !isAbsolute(check.command.command) && /[\\/]/.test(check.command.command)
      ? resolve(cwd, check.command.command)
      : check.command.command;
  return { ...check.command, command, cwd };
}

/** A failure's file, re-expressed relative to `dir` (POSIX separators) when it lies inside it. */
function normalizeFile(dir: string, cwd: string, file: string | null): string | null {
  if (file === null) return null;
  const absolute = resolve(cwd, file);
  const rel = relative(dir, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return absolute;
  return rel.split(sep).join('/');
}

/** A short, single-line stderr excerpt for a refusal message. */
function excerpt(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

/** A human label for one check. */
function checkLabel(index: number, check: CheckRunnerInput): string {
  return `check ${index + 1} (${check.adapter}: ${[check.command.command, ...check.command.args].join(' ')})`;
}

/**
 * Probe → collect → cluster with real dataflow. `dir` must already be the
 * canonical project directory.
 */
export async function probeAndCluster(
  run: RunCheck,
  dir: string,
  checks: readonly CheckRunnerInput[],
): Promise<OpResult<AnalysisSnapshot>> {
  const summaries: AnalyzeRunCheckSummary[] = [];
  let skippedOutsideDir = 0;
  const outsideDirFiles = new Set<string>();
  const byTool = new Map<string, FailureSet[]>();
  for (const [index, check] of checks.entries()) {
    const command = resolvedCommand(dir, check);
    let raw;
    try {
      raw = await run(command);
    } catch (err) {
      return {
        status: 'failed',
        error: `analyze.run: ${checkLabel(index, check)} could not run — ${messageOf(err)}`,
      };
    }
    const parsed = parseCheckOutput(adapterByName(check.adapter), raw);
    if (parsed.verdict !== 'parsed') {
      const hint =
        raw.exitCode === null
          ? ' — the exit code was unobservable (is the command installed and on PATH? did it time out?)'
          : '';
      const stderr = excerpt(raw.stderr);
      return {
        status: 'indeterminate',
        detail: `analyze.run: ${checkLabel(index, check)} produced no trustworthy result — ${parsed.reason}${hint}${stderr === '' ? '' : `; stderr: ${stderr}`}`,
      };
    }
    const cwd = command.cwd ?? dir;
    const normalized: CheckFailure[] = parsed.set.failures.map((failure) => ({
      ...failure,
      file: normalizeFile(dir, cwd, failure.file),
    }));
    // Inside-`dir` failures are dir-relative (or file-less); an absolute
    // path is one normalizeFile left outside `dir`.
    const failures = normalized.filter((failure) => {
      if (failure.file === null || !isAbsolute(failure.file)) return true;
      skippedOutsideDir += 1;
      outsideDirFiles.add(failure.file);
      return false;
    });
    const set: FailureSet = { tool: parsed.set.tool, failures, exitCode: parsed.set.exitCode };
    summaries.push({
      adapter: check.adapter,
      tool: set.tool,
      exitCode: set.exitCode,
      failures: normalized.length,
    });
    byTool.set(set.tool, [...(byTool.get(set.tool) ?? []), set]);
  }
  const sets: FailureSet[] = [];
  const clusters: Cluster[] = [];
  const noise: CheckFailure[] = [];
  for (const toolSets of byTool.values()) {
    const collected = await collectFailuresOp({ sets: toolSets });
    if (collected.status !== 'ok') return collected;
    sets.push(collected.value);
    const clustered = await clusterErrorsOp({ set: collected.value });
    if (clustered.status !== 'ok') return clustered;
    clusters.push(...clustered.value.clusters);
    noise.push(...clustered.value.noise);
  }
  clusters.sort((a, b) =>
    a.id === b.id
      ? a.signature < b.signature
        ? -1
        : a.signature > b.signature
          ? 1
          : 0
      : a.id < b.id
        ? -1
        : 1,
  );
  const failureCount = sets.reduce((total, set) => total + set.failures.length, 0);
  return {
    status: 'ok',
    value: {
      checks: summaries,
      sets,
      report: { clusters, noise },
      failureCount,
      skippedOutsideDir,
      outsideDirFiles: [...outsideDirFiles].sort(),
    },
  };
}

/** Summarize one cluster for the run value. */
export function summarizeCluster(cluster: Cluster): AnalyzeRunCluster {
  return {
    id: cluster.id,
    signature: cluster.signature,
    tool: cluster.tool,
    ruleId: cluster.ruleId,
    count: cluster.size,
    confidence: cluster.confidence,
    files: [
      ...new Set(cluster.failures.map((f) => f.file).filter((f): f is string => f !== null)),
    ].sort(),
  };
}

/**
 * Resolve and validate the report directory: inside `dir` (strictly), created
 * when missing. Returns the absolute path or a refusal.
 */
export function resolveOutDir(
  dir: string,
  out: string | undefined,
): { ok: true; out: string } | { ok: false; error: string } {
  const target = resolve(dir, out ?? ANALYZE_DEFAULT_OUT);
  const rel = relative(dir, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return {
      ok: false,
      error: `analyze.run: report directory '${target}' must lie strictly inside the project directory '${dir}' (the remediation store and the attended approval both assume it); the default is '${ANALYZE_DEFAULT_OUT}'`,
    };
  }
  // Containment BEFORE creation: realpath the deepest EXISTING ancestor and
  // require it inside `dir`, so a symlinked component cannot make mkdir -p
  // create directories outside the project before the check refuses.
  // lstat, not exists: a dangling symlink component counts as existing, and
  // its realpath then fails — a refusal, never a mkdir through it.
  let ancestor = target;
  while (!entryExists(ancestor)) ancestor = dirname(ancestor);
  try {
    const realAncestor = realpathSync(ancestor);
    const ancestorRel = relative(dir, realAncestor);
    if (ancestorRel.startsWith('..') || isAbsolute(ancestorRel)) {
      return {
        ok: false,
        error: `analyze.run: report directory '${target}' resolves outside the project directory through '${ancestor}' (a symlink?) — refusing to create or write reports there`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: `analyze.run: could not resolve the report directory '${target}' — ${messageOf(err)}`,
    };
  }
  try {
    mkdirSync(target, { recursive: true });
    const real = realpathSync(target);
    const realRel = relative(dir, real);
    if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
      return {
        ok: false,
        error: `analyze.run: report directory '${target}' resolves outside the project directory (a symlink?) — refusing to write reports there`,
      };
    }
    return { ok: true, out: real };
  } catch (err) {
    return {
      ok: false,
      error: `analyze.run: could not create the report directory '${target}' — ${messageOf(err)}`,
    };
  }
}

/** True when a directory entry (of any type, a dangling symlink included) exists at `path`. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Canonicalize an existing project directory, or explain why it is not one. */
export function canonicalProjectDir(
  dir: string,
  op: string,
): { ok: true; dir: string } | { ok: false; error: string } {
  try {
    const real = realpathSync(dir);
    if (!statSync(real).isDirectory()) {
      return { ok: false, error: `${op}: '${dir}' is not a directory` };
    }
    return { ok: true, dir: real };
  } catch (err) {
    return { ok: false, error: `${op}: directory does not exist: '${dir}' (${messageOf(err)})` };
  }
}

/**
 * The split store the render stage uses: target-file READS resolve under the
 * project directory (the evidence digests), report WRITES land in `out`.
 */
function splitStore(dir: string, out: string): AnalyzeFileStore {
  const source = pathAnalysisFileStore(dir);
  const sink = pathAnalysisFileStore(out);
  return {
    readText: (path) => source.readText(path),
    readBytes: (path) => source.readBytes(path),
    writeBytes: (path, bytes) => sink.writeBytes(path, bytes),
    isDirectory: (path) => sink.isDirectory(path),
  };
}

/** Build the `analyze.run` op over an injected check runner. */
export function makeAnalyzeRun(run: RunCheck): Op<AnalyzeRunInput, AnalyzeRunReport> {
  return async (input) => {
    const project = canonicalProjectDir(input.dir, 'analyze.run');
    if (!project.ok) return { status: 'failed', error: project.error };
    const dir = project.dir;
    const resolved = resolveChecks(dir, input);
    if (!resolved.ok) return { status: 'failed', error: resolved.error };
    const outDir = resolveOutDir(dir, input.out);
    if (!outDir.ok) return { status: 'failed', error: outDir.error };
    const snapshot = await probeAndCluster(run, dir, resolved.checks);
    if (snapshot.status !== 'ok') return snapshot;
    const rendered = await makeRenderAnalysisReport(() => splitStore(dir, outDir.out))({
      report: snapshot.value.report,
      dir: outDir.out,
    });
    if (rendered.status !== 'ok') return rendered;
    return {
      status: 'ok',
      value: {
        checks: snapshot.value.checks,
        failureCount: snapshot.value.failureCount,
        skippedOutsideDir: snapshot.value.skippedOutsideDir,
        outsideDirFiles: snapshot.value.outsideDirFiles,
        clusters: snapshot.value.report.clusters.map(summarizeCluster),
        markdownPath: rendered.value.markdownPath,
        sidecarPath: rendered.value.sidecarPath,
        reportFingerprint: rendered.value.reportFingerprint,
        ...(resolved.configPath === undefined ? {} : { configPath: resolved.configPath }),
      },
    };
  };
}

/** The registry importer's `.default` resolution: the subprocess-backed op. */
const analyzeRun: Op<AnalyzeRunInput, AnalyzeRunReport> = makeAnalyzeRun(subprocessRunCheck);
export default analyzeRun;
