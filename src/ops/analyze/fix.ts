// Analyze lane — `analyze.fix` (Lane C, S4): preview → attended apply →
// recheck, for ONE explicitly selected piece of work, composed from the
// family's existing engine ops.
//
// SELECTION — exactly one of:
//   - a CLUSTER: `clusterId` (+ `signature` to disambiguate an FNV id
//     collision) from a sidecar (`sidecarPath`, default the newest
//     `analysis-*.sidecar.json` in `out`, default `<dir>/.cq/analysis`);
//     remediated by `rule` (an ast-grep rule, through
//     `analyze.applyRemediation`) or, when no rule is supplied and `model`
//     is, by an `analyze.agenticRemediation` PROPOSAL whose `patch` becomes
//     the preview;
//   - a RULE over FILES: `rule` + `files`, through `analyze.astGrepCodemod`.
//
// STEPS
//   1. preview — a dry run of the engine op (writes nothing), or the agent's
//      proposal (persisted as `<out>/proposal-<hex>.patch` so a later
//      `--previewDigest=<digest> --apply` applies exactly that patch without
//      asking the model again);
//   2. `apply !== true` → `ok` with `mode: 'preview'` and the preview's
//      `digest`. An AGENT patch is never applied in the call that produced
//      it: `apply: true` on an agent patch requires `previewDigest` naming
//      the stored proposal (else `needs-human` with the digest to pass);
//   3. `apply === true` → run the configured checks (the BEFORE count), then
//      compose the SAME engine op with an ATTENDED authority
//      (./attended.ts) whose `confirm` accepts exactly the subject this
//      preview implies (op, workspace, targets, input digest) — `--apply` is
//      the confirmation of that one edit. A patch is applied with
//      `git apply` under `withApprovedMutation` on the same authority
//      (`git apply --check` as the read-only preflight, targets = every path
//      the patch names, any path outside `dir` refused);
//   4. recheck — re-run the checks through `analyze.run`'s composition (a
//      fresh report pair lands in `out`) and report before/after counts and
//      whether the targeted cluster (or, for a rule, the failure count) went
//      down.
//
// TAXONOMY: a missing approval/confirmation → `needs-human` naming
// `--apply`; a dirty tree → `needs-human` naming the dirty paths (commit or
// stash; `.cq/` is exempt); an agent failure keeps the agent op's status
// (`failed`, `budget-exhausted`, `indeterminate`, `needs-human`); a stale
// sidecar or unknown cluster → `failed`. The recheck never turns an applied
// edit into a failure: the edit happened, so the value reports it with the
// recheck's evidence (or the recheck's own failure as `recheck.detail`).
//
// `apply: true` is the operator-declared attended confirmation, reachable
// from any registry dispatch (ADR-0003 §1 "attended, unsigned"); see
// ./attended.ts for what that does and does not guarantee.
//
// `previewDigest` (optional on the codemod paths): the digest the caller reviewed.
// When given, a recomputed preview with a different digest is refused
// `needs-human` — the strongest form of "apply what I saw".
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { DriverFactory } from '../../driver/factory.js';
import type { Budget, ModelSpec } from '../../driver/types.js';
import type { Op, OpResult } from '../../kernel/types.js';
import { GIT_HARDEN } from '../../shared/gitHarden.js';
import { messageOf } from '../../shared/messageOf.js';
import type { CheckRunnerInput, RunCheck } from '../gates/checkRunner.js';
import { AGENTIC_PROPOSAL_SCHEMA, makeAgenticRemediation } from './agenticRemediation.js';
import { pathAnalysisFileStore } from './analysisStore.js';
import type { ApprovalSubject } from './approval.js';
import { approvalInputDigest, DENY_ALL_APPROVALS, withApprovedMutation } from './approval.js';
import { makeApplyRemediation } from './applyRemediation.js';
import { ATTENDED_DEFAULT_EXEMPT, makeAttendedApprovalAuthority } from './attended.js';
import type { Cluster } from './clusterErrors.js';
import type { CodemodFileDiff } from './codemod/astGrep.js';
import { makeAstGrepCodemod } from './codemod/astGrep.js';
import type { AnalysisSidecar } from './renderAnalysisReport.js';
import { contentDigest, parseAnalysisSidecar, sidecarFileName } from './renderAnalysisReport.js';
import type { AnalysisSnapshot, AnalyzeRunReport } from './run.js';
import {
  canonicalProjectDir,
  makeAnalyzeRun,
  probeAndCluster,
  resolveChecks,
  resolveOutDir,
} from './run.js';

/** JSON-serializable input of the `analyze.fix` op. */
export interface AnalyzeFixInput {
  /** The project directory (a git work tree for `apply`). */
  dir: string;
  /** The sidecar to read the cluster from; default the newest in `out`. */
  sidecarPath?: string;
  /** Select a cluster from the sidecar. Exclusive with `files`. */
  clusterId?: string;
  /** Disambiguates a cluster id shared by distinct signatures. */
  signature?: string;
  /** An ast-grep rule (YAML/JSON text): the mechanical fix for the cluster, or for `files`. */
  rule?: string;
  /** With `rule` and no `clusterId`: the files to rewrite (dir-relative). */
  files?: string[];
  /** Apply the previewed edit (attended approval) and recheck. Default false: preview only. */
  apply?: boolean;
  /** Ask a model for a proposal when the cluster has no `rule`. */
  model?: ModelSpec;
  /** Report directory (inside `dir`); default `.cq/analysis`. */
  out?: string;
  /** The checks for the recheck; default from `configPath` / `<dir>/cq.json`. */
  checks?: CheckRunnerInput[];
  /** The config to read the checks from when `checks` is absent. */
  configPath?: string;
  /** The preview digest the caller reviewed; a different recomputed preview is refused. */
  previewDigest?: string;
  /** Wall-clock cap for the ast-grep scan. */
  timeoutMs?: number;
  /** Budget caps for the agent proposal (`model`); forwarded to `analyze.agenticRemediation`. */
  budget?: Budget;
}

/** What `analyze.fix` previewed. */
export type AnalyzeFixPreview =
  | {
      kind: 'cluster-codemod';
      clusterId: string;
      signature: string;
      sidecarPath: string;
      targets: string[];
      plannedEdits: number;
      unfixedMatches: number;
      files: CodemodFileDiff[];
      note?: string;
      digest: string;
    }
  | {
      kind: 'rule-codemod';
      targets: string[];
      plannedEdits: number;
      unfixedMatches: number;
      files: CodemodFileDiff[];
      note?: string;
      digest: string;
    }
  | {
      kind: 'agent-patch';
      clusterId: string;
      signature: string;
      sidecarPath: string;
      source: 'model' | 'stored-proposal';
      summary?: string;
      patch: string;
      targets: string[];
      proposalPath: string;
      digest: string;
    }
  | {
      kind: 'agent-summary';
      clusterId: string;
      signature: string;
      sidecarPath: string;
      summary: string;
      note: string;
      digest: string;
    };

/** What was written. */
export interface AnalyzeFixApplied {
  files: string[];
  /** Per-file diffs (codemod paths) — the exact edits written. */
  diffs?: CodemodFileDiff[];
  /** The applied patch (agent path). */
  patch?: string;
}

/** The before/after evidence. */
export interface AnalyzeFixRecheck {
  before: number;
  after: number | null;
  /** Cluster work: the targeted cluster is gone. Rule work: the failure count went down. */
  resolved: boolean;
  /** The fresh report pair written by the recheck. */
  sidecarPath?: string;
  markdownPath?: string;
  /** Present when the recheck itself could not complete. */
  detail?: string;
}

/** The `analyze.fix` value. */
export interface AnalyzeFixReport {
  mode: 'preview' | 'applied';
  preview: AnalyzeFixPreview;
  applied?: AnalyzeFixApplied;
  recheck?: AnalyzeFixRecheck;
  /** What to do next, in one line. */
  next?: string;
}

/** The seams `analyze.fix` composes. */
export interface AnalyzeFixDeps {
  /** The check/scan runner (production: `subprocessRunCheck`). */
  run: RunCheck;
  /** The driver factory for the agent path; absent → the agent path refuses `failed`. */
  drivers?: DriverFactory;
  /** Exempt prefixes for the attended clean-tree check. Default `.cq/`. */
  exempt?: readonly string[];
  /**
   * The attended-authority factory composed per apply (default
   * {@link makeAttendedApprovalAuthority}). A seam, not a bypass: whatever it
   * returns still has to admit, exercise and lock like any ADR-0003 authority.
   */
  attended?: typeof makeAttendedApprovalAuthority;
}

/** One selected cluster from a sidecar. */
interface SelectedCluster {
  sidecarPath: string;
  sidecarSha256: string;
  sidecar: AnalysisSidecar;
  cluster: Cluster;
}

const SIDECAR_NAME = /^analysis-[0-9a-f]{16}\.sidecar\.json$/;
const PROPOSAL_PREFIX = 'proposal-';

/** The newest analysis sidecar, or undefined; non-missing metadata faults throw. */
function newestSidecar(out: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(out).filter((name) => SIDECAR_NAME.test(name));
  } catch {
    return undefined;
  }
  let best: { path: string; mtime: number } | undefined;
  for (const name of names.sort()) {
    const path = join(out, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch (err) {
      // Only a confirmed missing entry is safe to omit from newest selection.
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
    if (best === undefined || mtime >= best.mtime) best = { path, mtime };
  }
  return best?.path;
}

/** Strict-descendant test on resolved paths. */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Load the sidecar and select the cluster by id (+ signature). */
function selectCluster(
  dir: string,
  out: string,
  input: AnalyzeFixInput,
): { ok: true; selected: SelectedCluster } | { ok: false; error: string } {
  let sidecarPath: string | undefined;
  try {
    sidecarPath =
      input.sidecarPath === undefined ? newestSidecar(out) : resolve(dir, input.sidecarPath);
  } catch (err) {
    return {
      ok: false,
      error: `analyze.fix: could not select the newest analysis sidecar in '${out}' — ${messageOf(err)}; nothing was written`,
    };
  }
  if (sidecarPath === undefined) {
    return {
      ok: false,
      error: `analyze.fix: no analysis sidecar in '${out}' — run \`cq analyze.run --dir=${dir}\` first, or pass --sidecarPath`,
    };
  }
  if (!inside(dir, sidecarPath)) {
    return {
      ok: false,
      error: `analyze.fix: the sidecar '${sidecarPath}' must lie inside the project directory '${dir}'`,
    };
  }
  // Lexical containment is not enough: a leaf (or intermediate) symlink
  // could point the read outside the project. Resolve, then re-check.
  let realSidecar: string;
  try {
    realSidecar = realpathSync(sidecarPath);
  } catch (err) {
    return {
      ok: false,
      error: `analyze.fix: the analysis sidecar '${sidecarPath}' does not resolve — ${messageOf(err)}; run \`cq analyze.run --dir=${dir}\` again`,
    };
  }
  if (!inside(dir, realSidecar)) {
    return {
      ok: false,
      error: `analyze.fix: the sidecar '${sidecarPath}' resolves outside the project directory ('${realSidecar}') — refusing to read it`,
    };
  }
  let text: string;
  let sidecar: AnalysisSidecar;
  try {
    text = readFileSync(realSidecar, 'utf8');
    sidecar = parseAnalysisSidecar(text);
  } catch (err) {
    return {
      ok: false,
      error: `analyze.fix: the analysis sidecar '${sidecarPath}' is missing, unreadable, or invalid — ${messageOf(err)}; run \`cq analyze.run --dir=${dir}\` again`,
    };
  }
  if (resolve(sidecarPath) === resolve(dir, sidecarFileName(sidecar.reportFingerprint))) {
    return {
      ok: false,
      error: `analyze.fix: the sidecar '${sidecarPath}' sits at the project root — analyze.fix reads the sidecars analyze.run writes under its report directory (default .cq/analysis); run \`cq analyze.run --dir=${dir}\``,
    };
  }
  const matching = sidecar.report.clusters.filter((cluster) => cluster.id === input.clusterId);
  if (matching.length === 0) {
    return {
      ok: false,
      error: `analyze.fix: unknown cluster id '${String(input.clusterId)}' in '${sidecarPath}' — it carries: ${sidecar.report.clusters.map((cluster) => cluster.id).join(', ') || '(no clusters)'}`,
    };
  }
  let cluster = matching[0] as Cluster;
  if (input.signature !== undefined) {
    const bySignature = matching.find((candidate) => candidate.signature === input.signature);
    if (bySignature === undefined) {
      return {
        ok: false,
        error: `analyze.fix: no cluster with id '${String(input.clusterId)}' carries the given signature — the id's signature(s): ${matching.map((candidate) => candidate.signature).join(' | ')}`,
      };
    }
    cluster = bySignature;
  } else if (matching.length > 1) {
    return {
      ok: false,
      error: `analyze.fix: ambiguous cluster id '${String(input.clusterId)}' — ${matching.length} clusters share it; pass --signature. Signature(s): ${matching.map((candidate) => candidate.signature).join(' | ')}`,
    };
  }
  return {
    ok: true,
    selected: {
      sidecarPath,
      sidecarSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      sidecar,
      cluster,
    },
  };
}

/** The distinct files a dry run would rewrite, sorted. */
function editedFiles(files: readonly CodemodFileDiff[]): string[] {
  return files
    .filter((file) => file.edits > 0)
    .map((file) => file.file)
    .sort();
}

/** Sorted-set equality of two target lists. */
function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// ---------------------------------------------------------------- patches

/** One hardened git invocation with optional stdin; never rejects. */
function runGit(
  cwd: string,
  args: readonly string[],
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_CONFIG',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
  ]) {
    delete env[key];
  }
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_TERMINAL_PROMPT'] = '0';
  return new Promise((resolvePromise) => {
    const child = spawn('git', [...GIT_HARDEN, '-C', cwd, ...args], {
      env,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err) => resolvePromise({ code: null, stdout, stderr: messageOf(err) }));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    if (stdin !== undefined && child.stdin !== null) {
      // A child that exits before reading its input (a refused patch) closes
      // the pipe: an EPIPE here is not a fault — the exit code reports it.
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    }
  });
}

/** Strip a `-p1` prefix and any trailing tab-separated timestamp from a header path. */
function headerPath(raw: string, prefix: 'a/' | 'b/'): string | null {
  const path = raw.split('\t')[0]?.trim() ?? '';
  if (path === '/dev/null') return null;
  return path.startsWith(prefix) ? path.slice(2) : path;
}

/**
 * The workspace-relative files a unified/git patch touches, or a refusal.
 * Refused: quoted (escaped) paths, binary hunks, symlink/submodule modes,
 * absolute or `..` paths, `.git/`, and the exempt report prefixes.
 */
export function patchTargets(
  patch: string,
  exempt: readonly string[] = ATTENDED_DEFAULT_EXEMPT,
): { ok: true; targets: string[] } | { ok: false; reason: string } {
  const paths = new Set<string>();
  // Hunk BODY lines are content, never headers: a removed `-- comment` line
  // reads `--- comment`. Track the `@@ -a,b +c,d @@` counts and skip the body.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      if (line.startsWith('-')) oldLeft -= 1;
      else if (line.startsWith('+')) newLeft -= 1;
      else {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk !== null) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    let candidate: string | null | undefined;
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (match === null) return { ok: false, reason: `unsupported diff header '${line}'` };
      paths.add(match[1] as string);
      paths.add(match[2] as string);
      continue;
    }
    if (line.startsWith('--- ')) candidate = headerPath(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) candidate = headerPath(line.slice(4), 'b/');
    else if (/^(rename|copy) (from|to) /.test(line)) candidate = line.replace(/^\S+ \S+ /, '');
    else if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      return { ok: false, reason: 'binary patches are not applied' };
    } else if (
      /^(new file mode|new mode|old mode|deleted file mode) 1[26]0000/.test(line) ||
      /^index \S+\.\.\S+ 1[26]0000$/.test(line)
    ) {
      return { ok: false, reason: 'symlink and submodule entries are not applied' };
    }
    if (candidate === undefined || candidate === null) continue;
    if (candidate.startsWith('"')) {
      return { ok: false, reason: `quoted (escaped) path ${candidate} is not supported` };
    }
    paths.add(candidate);
  }
  if (paths.size === 0) return { ok: false, reason: 'the patch names no files' };
  for (const path of paths) {
    const normalized = posix.normalize(path);
    if (
      isAbsolute(path) ||
      normalized.startsWith('../') ||
      normalized === '..' ||
      normalized.split('/').includes('..') ||
      normalized === '.git' ||
      normalized.startsWith('.git/')
    ) {
      return { ok: false, reason: `path '${path}' escapes the project directory` };
    }
    const under = exempt.find((prefix) => {
      const base = prefix.replace(/\/+$/, '');
      return normalized === base || normalized.startsWith(`${base}/`);
    });
    if (under !== undefined) {
      return { ok: false, reason: `path '${path}' lies under the report area '${under}'` };
    }
  }
  return { ok: true, targets: [...paths].map((path) => posix.normalize(path)).sort() };
}

/** `git apply --check` the patch; confirm git touches exactly the parsed targets. */
async function checkPatch(
  dir: string,
  patch: string,
  targets: readonly string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const prefixed = await runGit(dir, ['rev-parse', '--show-prefix']);
  if (prefixed.code !== 0) {
    return { ok: false, reason: `'${dir}' is not a git work tree (${prefixed.stderr.trim()})` };
  }
  const prefix = prefixed.stdout.trim();
  const args = [
    'apply',
    '--check',
    '--verbose',
    ...(prefix === '' ? [] : [`--directory=${prefix}`]),
    '-',
  ];
  const checked = await runGit(dir, args, patch);
  const output = `${checked.stdout}\n${checked.stderr}`;
  if (checked.code !== 0) {
    return { ok: false, reason: `git apply --check refused the patch: ${output.trim()}` };
  }
  if (/^Skipped patch/m.test(output)) {
    return { ok: false, reason: `git apply would skip part of the patch: ${output.trim()}` };
  }
  const allowed = new Set(targets.map((target) => `${prefix}${target}`));
  const touched = new Set<string>();
  for (const match of output.matchAll(/^Checking patch (.+)\.\.\.$/gm)) {
    const named = match[1] as string;
    // A rename is reported as `old => new`.
    for (const part of named.split(' => ')) {
      if (!allowed.has(part)) {
        return {
          ok: false,
          reason: `git would touch '${part}', which the patch header parse did not name`,
        };
      }
      touched.add(part);
    }
  }
  // The cross-check must PROVE coverage, not merely find no contradiction:
  // git has to report every parsed target (and so at least one).
  const unreported = [...allowed].filter((path) => !touched.has(path));
  if (touched.size === 0 || unreported.length > 0) {
    return {
      ok: false,
      reason: `git apply --check did not report the files the patch names (unreported: ${unreported.join(', ') || '(all)'}) — refusing a patch whose write set cannot be confirmed`,
    };
  }
  return { ok: true };
}

/** Apply the (already checked) patch. Throws on failure (inside the approved write). */
async function applyPatch(dir: string, patch: string): Promise<void> {
  const prefixed = await runGit(dir, ['rev-parse', '--show-prefix']);
  const prefix = prefixed.stdout.trim();
  const applied = await runGit(
    dir,
    ['apply', ...(prefix === '' ? [] : [`--directory=${prefix}`]), '-'],
    patch,
  );
  if (applied.code !== 0) {
    throw new Error(`git apply failed after the check passed: ${applied.stderr.trim()}`);
  }
}

// ------------------------------------------------------------------- op

/** Prefix a non-ok result's message with the fix context. */
function relay<T>(result: OpResult<unknown>, context: string): OpResult<T> {
  switch (result.status) {
    case 'failed':
      return { status: 'failed', error: `${context}: ${result.error}` };
    case 'needs-human':
      return { status: 'needs-human', reason: `${context}: ${result.reason}` };
    case 'indeterminate':
      return { status: 'indeterminate', detail: `${context}: ${result.detail}` };
    case 'budget-exhausted':
      return { status: 'budget-exhausted' };
    case 'ok':
      return { status: 'failed', error: `${context}: unexpected ok relay` };
  }
}

/** A stale-sidecar hint, appended to the engine's own wording. */
function withRunHint(error: string, dir: string): string {
  return /stale sidecar|changed during remediation planning/.test(error)
    ? `${error} (run \`cq analyze.run --dir=${dir}\` to refresh the analysis)`
    : error;
}

/** Build the `analyze.fix` op over its seams. */
export function makeAnalyzeFix(deps: AnalyzeFixDeps): Op<AnalyzeFixInput, AnalyzeFixReport> {
  const baseExempt = deps.exempt ?? ATTENDED_DEFAULT_EXEMPT;
  return async (input) => {
    const project = canonicalProjectDir(input.dir, 'analyze.fix');
    if (!project.ok) return { status: 'failed', error: project.error };
    const dir = project.dir;
    const byCluster = input.clusterId !== undefined;
    if (byCluster && input.files !== undefined) {
      return {
        status: 'failed',
        error:
          'analyze.fix: pass exactly one of --clusterId (a cluster from the analysis) or --rule with --files (a rule over files), not both',
      };
    }
    if (!byCluster && (input.rule === undefined || input.files === undefined)) {
      return {
        status: 'failed',
        error:
          'analyze.fix: nothing selected — pass --clusterId=<id> (from `cq analyze.run`), or --rule=<ast-grep rule> with --files=["<path>", ...]',
      };
    }
    if (!byCluster && (input.files ?? []).length === 0) {
      return { status: 'failed', error: 'analyze.fix: --files is empty — name at least one file' };
    }
    const outDir = resolveOutDir(dir, input.out);
    if (!outDir.ok)
      return { status: 'failed', error: outDir.error.replace('analyze.run', 'analyze.fix') };
    const out = outDir.out;
    const exempt = withReportArea(baseExempt, dir, out);
    const store = pathAnalysisFileStore(dir);
    const timeout = input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs };

    // ------------------------------------------------------- 1. preview
    let preview: AnalyzeFixPreview;
    let selected: SelectedCluster | undefined;
    let note: string | undefined;
    if (byCluster) {
      const chosen = selectCluster(dir, out, input);
      if (!chosen.ok) return { status: 'failed', error: chosen.error };
      selected = chosen.selected;
      const { cluster, sidecarPath } = selected;
      if (input.rule !== undefined) {
        if (input.model !== undefined) note = 'model ignored: a mechanical rule was supplied';
        const dry = await makeApplyRemediation(
          () => store,
          deps.run,
          DENY_ALL_APPROVALS,
        )({
          sidecarPath,
          dir,
          clusterId: cluster.id,
          ...(input.signature === undefined ? {} : { signature: input.signature }),
          approved: true,
          rule: input.rule,
          dryRun: true,
          ...timeout,
        });
        if (dry.status !== 'ok') {
          if (dry.status === 'failed') {
            return {
              status: 'failed',
              error: `analyze.fix: preview failed — ${withRunHint(dry.error, dir)}`,
            };
          }
          return relay(dry, 'analyze.fix: preview');
        }
        const files = dry.value.files;
        preview = {
          kind: 'cluster-codemod',
          clusterId: cluster.id,
          signature: cluster.signature,
          sidecarPath,
          targets: dry.value.targets,
          plannedEdits: dry.value.plannedEdits,
          unfixedMatches: dry.value.unfixedMatches,
          files,
          ...(dry.value.note === undefined ? {} : { note: dry.value.note }),
          digest: approvalInputDigest({
            kind: 'cluster-codemod',
            targets: dry.value.targets,
            files,
          }),
        };
      } else if (input.model !== undefined || input.previewDigest !== undefined) {
        const proposal = await agentPreview(deps, dir, out, exempt, selected, input);
        if (proposal.status !== 'ok') return proposal;
        preview = proposal.value;
      } else {
        return {
          status: 'failed',
          error: `analyze.fix: cluster '${cluster.id}' (${cluster.tool} ${cluster.ruleId ?? '-'}) has no mechanical rule — pass --rule=<ast-grep rule> for a codemod, or --model='{"provider":"…","model":"…"}' to ask an agent for a proposal`,
        };
      }
    } else {
      const dry = await makeAstGrepCodemod(
        deps.run,
        () => store,
        DENY_ALL_APPROVALS,
      )({
        dir,
        rule: input.rule as string,
        files: input.files as string[],
        dryRun: true,
        ...timeout,
      });
      if (dry.status !== 'ok') return relay(dry, 'analyze.fix: preview');
      const files = dry.value.files;
      const targets = [...(input.files as string[])].sort();
      preview = {
        kind: 'rule-codemod',
        targets,
        plannedEdits: dry.value.plannedEdits,
        unfixedMatches: dry.value.unfixedMatches,
        files,
        ...(dry.value.note === undefined ? {} : { note: dry.value.note }),
        digest: approvalInputDigest({ kind: 'rule-codemod', targets, files }),
      };
    }

    if (input.previewDigest !== undefined && input.previewDigest !== preview.digest) {
      return {
        status: 'needs-human',
        reason: `analyze.fix: the preview changed since it was reviewed (reviewed ${input.previewDigest}, now ${preview.digest}) — nothing was written; review the new preview and re-run with --previewDigest=${preview.digest} --apply`,
      };
    }

    // An AGENT patch is never applied unseen: the model is not deterministic,
    // so the apply must name the stored proposal the human reviewed.
    if (
      input.apply === true &&
      preview.kind === 'agent-patch' &&
      input.previewDigest === undefined
    ) {
      return {
        status: 'needs-human',
        reason: `analyze.fix: an agent proposal is applied only after review — nothing was written; the proposal is stored at '${preview.proposalPath}'; review it, then re-run with --previewDigest=${preview.digest} --apply`,
      };
    }

    const nothingToApply =
      preview.kind === 'agent-summary' ||
      ((preview.kind === 'cluster-codemod' || preview.kind === 'rule-codemod') &&
        editedFiles(preview.files).length === 0);
    if (input.apply !== true || nothingToApply) {
      return {
        status: 'ok',
        value: {
          mode: 'preview',
          preview,
          next: nothingToApply
            ? 'nothing to apply: the preview plans no edit'
            : `review the preview, then re-run with --apply (add --previewDigest=${preview.digest} to bind the apply to exactly this preview); the work tree must be clean apart from ${exempt.join(', ')}${note === undefined ? '' : `; ${note}`}`,
        },
      };
    }

    // The approval binds to HEAD: a repository without a commit (or no
    // repository at all) cannot be approved against — say so plainly
    // instead of surfacing git's rev-parse error.
    const head = await runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.code !== 0) {
      return {
        status: 'needs-human',
        reason: `analyze.fix: --apply needs '${dir}' to be a git work tree with at least one commit (the attended approval binds to HEAD and a clean tree) — commit your work first; nothing was written`,
      };
    }

    // --------------------------------------------- 2. before (the checks)
    const checks = resolveChecks(dir, input);
    if (!checks.ok) {
      return {
        status: 'failed',
        error: `${checks.error.replace('analyze.run', 'analyze.fix')} — --apply rechecks after writing, so it needs the project's checks; nothing was written`,
      };
    }
    const before = await probeAndCluster(deps.run, dir, checks.checks);
    if (before.status !== 'ok')
      return relay(before, 'analyze.fix: the before-check did not complete; nothing was written');

    // ------------------------------------------- 3. the attended apply
    let expected: Pick<ApprovalSubject, 'op' | 'workspace' | 'targets' | 'inputDigest'>;
    let confirmAsked = false;
    let confirmMatched = false;
    const sidecarSha = selected?.sidecarSha256;
    const confirmFor = (subject: ApprovalSubject): boolean => {
      confirmAsked = true;
      confirmMatched =
        subject.op === expected.op &&
        subject.workspace === expected.workspace &&
        subject.inputDigest === expected.inputDigest &&
        sameTargets(subject.targets, expected.targets) &&
        (selected === undefined || sidecarDigest(selected.sidecarPath) === sidecarSha);
      return confirmMatched;
    };
    const authority = (deps.attended ?? makeAttendedApprovalAuthority)({
      confirm: confirmFor,
      exempt,
    });
    const refusal = (reason: string): OpResult<AnalyzeFixReport> => ({
      status: 'needs-human',
      reason:
        confirmAsked && !confirmMatched
          ? `analyze.fix: the write the engine planned is not the one previewed (op, targets, inputs or sidecar changed), so --apply does not confirm it; nothing was written — re-run the preview and pass --apply again (${reason})`
          : `analyze.fix: the attended apply was refused — ${reason}`,
    });
    let applied: AnalyzeFixApplied;
    if (preview.kind === 'cluster-codemod' && selected !== undefined) {
      const applyInput = {
        sidecarPath: selected.sidecarPath,
        dir,
        clusterId: selected.cluster.id,
        ...(input.signature === undefined ? {} : { signature: input.signature }),
        approved: true,
        rule: input.rule as string,
        dryRun: false,
        ...timeout,
      };
      expected = {
        op: 'analyze.applyRemediation',
        workspace: dir,
        targets: editedFiles(preview.files),
        inputDigest: approvalInputDigest({
          sidecarPath: applyInput.sidecarPath,
          dir,
          clusterId: applyInput.clusterId,
          signature: input.signature,
          rule: applyInput.rule,
          dryRun: false,
          timeoutMs: input.timeoutMs,
        }),
      };
      const result = await makeApplyRemediation(() => store, deps.run, authority)(applyInput);
      if (result.status === 'needs-human') return refusal(result.reason);
      if (result.status !== 'ok') {
        if (result.status === 'failed') {
          return {
            status: 'failed',
            error: `analyze.fix: apply failed — ${withRunHint(result.error, dir)}`,
          };
        }
        return relay(result, 'analyze.fix: apply');
      }
      applied = {
        files: result.value.files.map((file) => file.file),
        diffs: result.value.files.map(({ file, edits, diff }) => ({ file, edits, diff })),
      };
    } else if (preview.kind === 'rule-codemod') {
      const expectedPreviewDigest = approvalInputDigest(preview.files);
      const applyInput = {
        dir,
        rule: input.rule as string,
        files: input.files as string[],
        dryRun: false,
        approved: true,
        ...timeout,
      };
      expected = {
        op: 'analyze.astGrepCodemod',
        workspace: dir,
        targets: editedFiles(preview.files),
        inputDigest: approvalInputDigest({
          dir,
          rule: applyInput.rule,
          files: applyInput.files,
          dryRun: false,
          timeoutMs: input.timeoutMs,
          expectedPreviewDigest,
        }),
      };
      const result = await makeAstGrepCodemod(
        deps.run,
        () => store,
        authority,
        undefined,
        expectedPreviewDigest,
      )(applyInput);
      if (result.status === 'needs-human') return refusal(result.reason);
      if (result.status !== 'ok') return relay(result, 'analyze.fix: apply');
      applied = {
        files: result.value.files.map((file) => file.file),
        diffs: result.value.files.map(({ file, edits, diff }) => ({ file, edits, diff })),
      };
    } else if (preview.kind === 'agent-patch') {
      const patch = preview.patch;
      const subject: ApprovalSubject = {
        op: 'analyze.fix',
        workspace: dir,
        targets: preview.targets,
        inputDigest: approvalInputDigest({ kind: 'agent-patch', dir, patch }),
      };
      expected = subject;
      let mutation;
      try {
        mutation = await withApprovedMutation(
          authority,
          subject,
          () => applyPatch(dir, patch),
          async () => {
            const verdict = await checkPatch(dir, patch, preview.targets);
            return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
          },
        );
      } catch (err) {
        return {
          status: 'failed',
          error: `analyze.fix: applying the patch faulted — ${messageOf(err)}; inspect \`git status\` before re-running`,
        };
      }
      if (mutation.status === 'needs-human') return refusal(mutation.reason);
      applied = { files: preview.targets, patch };
    } else {
      return { status: 'failed', error: 'analyze.fix: internal — no applicable preview kind' };
    }

    // ------------------------------------------------- 4. the recheck
    const recheck = await recheckAfter(deps.run, dir, input, checks.checks, before.value, preview);
    return {
      status: 'ok',
      value: {
        mode: 'applied',
        preview,
        applied,
        recheck,
        next: recheck.resolved
          ? 'review `git diff`, then commit'
          : 'the targeted diagnostics did not go away — review `git diff` (revert with `git restore`) and the fresh report',
      },
    };
  };
}

/** The current sha256 of a sidecar file, or undefined when unreadable. */
function sidecarDigest(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path, 'utf8'), 'utf8').digest('hex');
  } catch {
    return undefined;
  }
}

/** Re-run the analysis (fresh report pair) and compare with the before snapshot. */
async function recheckAfter(
  run: RunCheck,
  dir: string,
  input: AnalyzeFixInput,
  checks: CheckRunnerInput[],
  before: AnalysisSnapshot,
  preview: AnalyzeFixPreview,
): Promise<AnalyzeFixRecheck> {
  const after = await makeAnalyzeRun(run)({
    dir,
    checks,
    ...(input.out === undefined ? {} : { out: input.out }),
  });
  if (after.status !== 'ok') {
    const detail =
      after.status === 'failed'
        ? after.error
        : after.status === 'needs-human'
          ? after.reason
          : after.status === 'indeterminate'
            ? after.detail
            : 'budget exhausted';
    return { before: before.failureCount, after: null, resolved: false, detail };
  }
  const report: AnalyzeRunReport = after.value;
  const resolved =
    preview.kind === 'rule-codemod'
      ? report.failureCount < before.failureCount
      : !report.clusters.some(
          (cluster) => cluster.id === preview.clusterId && cluster.signature === preview.signature,
        );
  return {
    before: before.failureCount,
    after: report.failureCount,
    resolved,
    sidecarPath: report.sidecarPath,
    markdownPath: report.markdownPath,
  };
}

/** The agent path's preview: a stored proposal (by digest) or a fresh model proposal. */
async function agentPreview(
  deps: AnalyzeFixDeps,
  dir: string,
  out: string,
  exempt: readonly string[],
  selected: SelectedCluster,
  input: AnalyzeFixInput,
): Promise<OpResult<AnalyzeFixPreview>> {
  const { cluster, sidecarPath } = selected;
  const outStore = pathAnalysisFileStore(out);
  // The mechanical path's staleness rule, applied here too: a proposal for a
  // snapshot whose evidenced files moved is a proposal for a diagnostic that
  // may no longer exist.
  const stale = await staleEvidence(pathAnalysisFileStore(dir), selected.sidecar);
  if (stale !== null) {
    return {
      status: 'failed',
      error: `analyze.fix: ${stale} (run \`cq analyze.run --dir=${dir}\` to refresh the analysis)`,
    };
  }
  const digestHex = /^sha256:([0-9a-f]{64})$/.exec(input.previewDigest ?? '')?.[1];
  // A STORED proposal, addressed by the digest the caller reviewed.
  if (digestHex !== undefined) {
    const name = `${PROPOSAL_PREFIX}${digestHex}.patch`;
    let patch: string | undefined;
    try {
      patch = await outStore.readText(name);
    } catch {
      patch = undefined;
    }
    if (patch !== undefined) {
      const parsed = patchTargets(patch, exempt);
      if (!parsed.ok) {
        return {
          status: 'failed',
          error: `analyze.fix: the stored proposal '${join(out, name)}' is not applicable — ${parsed.reason}`,
        };
      }
      return {
        status: 'ok',
        value: {
          kind: 'agent-patch',
          clusterId: cluster.id,
          signature: cluster.signature,
          sidecarPath,
          source: 'stored-proposal',
          patch,
          targets: parsed.targets,
          proposalPath: join(out, name),
          digest: proposalDigest(selected, parsed.targets, patch),
        },
      };
    }
  }
  if (input.model === undefined) {
    return {
      status: 'failed',
      error: `analyze.fix: no stored proposal matches --previewDigest in '${out}', and no --model was given to ask for one — pass --rule, or --model='{"provider":"…","model":"…"}'`,
    };
  }
  const agent = await makeAgenticRemediation(deps.drivers)({
    clusterId: cluster.id,
    cluster,
    modelSpec: input.model,
    ...(input.budget === undefined ? {} : { budget: input.budget }),
  });
  if (agent.status !== 'ok') return relay(agent, 'analyze.fix: the agent proposal');
  const proposal = AGENTIC_PROPOSAL_SCHEMA.safeParse(agent.value.structuredOutput);
  if (!proposal.success) {
    return {
      status: 'failed',
      error: 'analyze.fix: the agent returned no valid proposal (summary/patch)',
    };
  }
  const { summary, patch } = proposal.data;
  if (patch === undefined) {
    return {
      status: 'ok',
      value: {
        kind: 'agent-summary',
        clusterId: cluster.id,
        signature: cluster.signature,
        sidecarPath,
        summary,
        note: 'the proposal carries no patch — nothing mechanical to apply; read the summary',
        digest: approvalInputDigest({
          kind: 'agent-summary',
          clusterId: cluster.id,
          signature: cluster.signature,
          summary,
        }),
      },
    };
  }
  const parsed = patchTargets(patch, exempt);
  if (!parsed.ok) {
    return {
      status: 'failed',
      error: `analyze.fix: the agent's patch is not applicable — ${parsed.reason}`,
    };
  }
  const digest = proposalDigest(selected, parsed.targets, patch);
  const name = `${PROPOSAL_PREFIX}${digest.slice('sha256:'.length)}.patch`;
  try {
    await outStore.writeBytes(name, Buffer.from(patch, 'utf8'));
  } catch (err) {
    return {
      status: 'failed',
      error: `analyze.fix: could not store the proposal — ${messageOf(err)}`,
    };
  }
  const checked = await checkPatch(dir, patch, parsed.targets);
  if (!checked.ok) {
    return {
      status: 'failed',
      error: `analyze.fix: the agent's patch does not apply cleanly (${checked.reason}); it is kept at '${join(out, name)}' for inspection`,
    };
  }
  return {
    status: 'ok',
    value: {
      kind: 'agent-patch',
      clusterId: cluster.id,
      signature: cluster.signature,
      sidecarPath,
      source: 'model',
      summary,
      patch,
      targets: parsed.targets,
      proposalPath: join(out, name),
      digest,
    },
  };
}

/**
 * The stored-proposal binding: the patch, its targets, AND the work it was
 * proposed for (cluster id, signature, sidecar bytes) — so a digest reviewed
 * for one cluster cannot be replayed against another, or against a newer
 * analysis.
 */
function proposalDigest(
  selected: SelectedCluster,
  targets: readonly string[],
  patch: string,
): string {
  return approvalInputDigest({
    kind: 'agent-patch',
    clusterId: selected.cluster.id,
    signature: selected.cluster.signature,
    sidecarSha256: selected.sidecarSha256,
    targets,
    patch,
  });
}

/** The first evidenced target whose current bytes differ from the analysis digest, as a reason; or null. */
async function staleEvidence(
  store: ReturnType<typeof pathAnalysisFileStore>,
  sidecar: AnalysisSidecar,
): Promise<string | null> {
  for (const evidence of sidecar.evidence) {
    for (const target of evidence.targets) {
      let digest: string;
      try {
        digest = contentDigest(Buffer.from(await store.readBytes(target.file)).toString('utf8'));
      } catch (err) {
        return `stale sidecar: target '${target.file}' is no longer readable — ${messageOf(err)}`;
      }
      if (digest !== target.digest) {
        return `stale sidecar: '${target.file}' changed since analysis (analysis digest ${target.digest}, current ${digest})`;
      }
    }
  }
  return null;
}

/**
 * The exempt prefixes for one call: the configured ones plus the report
 * directory `out` (strictly inside `dir`), so a custom report area holding
 * this run's untracked sidecar and proposals is not workspace dirt. Targets
 * under any exempt prefix stay refused.
 */
function withReportArea(exempt: readonly string[], dir: string, out: string): readonly string[] {
  const rel = relative(dir, out).split(sep).join('/');
  const covered = exempt.some((prefix) => {
    const base = prefix.replace(/\/+$/, '');
    return rel === base || rel.startsWith(`${base}/`);
  });
  return covered ? exempt : [...exempt, `${rel}/`];
}
