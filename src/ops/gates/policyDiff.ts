// gates.policyDiff — the D11 protected-path policy check (W1.9, ADR-0004 D-G).
//
// What `cq-policy.yml` runs from the DEFAULT BRANCH. It judges a subject (a PR
// head, or the merge-queue tip) over the same range `ratchet.verifyRatchet`
// judges — `merge-base(subject, base)..subject` — and decides which changes
// need a human (docs/methods-w1-9.md, "The check", is normative):
//   - LISTS come from the TRUST REF only: the built-in taxonomy
//     (`isProtectedPolicyPath`), the `baselines/ratchets.json` definition set,
//     the tsconfig `extends`/`references` graph, and the project's
//     `policy/protected-paths.json` (`protectedPaths` regex sources and
//     `requiredChecks`). A subject cannot edit the lists that judge it.
//   - THE HEAD IS DATA: every read is a hardened git plumbing call from
//     `../ratchet/git.js` (argv arrays, GIT_HARDEN, scrubbed env, validated
//     revisions, no external diff/textconv/fsmonitor). Nothing is checked
//     out, installed or executed. A changed path that fails
//     `assertRepoRelPath` (#224's `.git` segment and the rest) is reported as
//     `unsafe-path` and never read.
//   - THE POSTURE is resolved by the caller (the registry importer, once per
//     dispatch) and bound into the op; op input never carries it.
//   - THE OVERRIDE LABEL is evaluated from API timeline events and the
//     settle-ledger head epoch, logged in full, and honoured only once the
//     C3 attestation is on the trust ref (D-G.4).
//
// Failure direction (I5): a finding the check cannot rule out is
// needs-human, never a pass; `lint` is always `fail`. `failed` is reserved for
// the check being unable to judge at all (a git fault, the trust manifest or
// policy list unreadable) — the workflow maps it to a failing check run.
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Op } from '../../kernel/types.js';
import { parseSettleState } from '../../selfhost/settle-state.js';
import { SETTLE_STATE_PATH } from '../../selfhost/state-branch.js';
import {
  assertRepoRelPath,
  gitChangedPaths,
  gitDiffText,
  gitListPaths,
  gitMergeBase,
  gitReadBlob,
  gitRevParse,
} from '../ratchet/git.js';
import { normalizeBaselineDiffValues } from '../ratchet/format.js';
import {
  RATCHETS_MANIFEST_PATH,
  isDefinitionPath,
  loadTrustedManifest,
  parseRatchetManifest,
  tsconfigGraphPaths,
  type RatchetManifest,
} from '../ratchet/internal/definitions.js';
import { checkDiffMonotonicity, formatViolations } from '../ratchet/monotonicGuard.js';
import {
  C3_ATTESTATION_PATH,
  evaluateOverrideLabel,
  formatOverride,
  headObservationEpoch,
  parseC3Attestation,
  type OverrideEvaluation,
} from './overrideRecord.js';
import type { ProtectedPathsConfig, ProtectedPathsPosture } from './policyConfig.js';
import { isProtectedPolicyPath } from './protectedPaths.js';
import {
  diffWorkflow,
  hasUnresolvableCheckName,
  isWorkflowPath,
  producersOf,
  scanWorkflow,
  type WorkflowFindingKind,
  type WorkflowScan,
} from './workflowScan.js';

/** The project's policy list, read at the trust ref (and at both range ends for removals). */
export const POLICY_LIST_PATH = 'policy/protected-paths.json';

/** The only directory GitHub reads workflows from. */
const WORKFLOWS_DIR = '.github/workflows';

/** Largest label-events file the check reads (API timeline JSON). */
export const LABEL_EVENTS_MAX_BYTES = 4 * 1024 * 1024;

/** `baselines/<target>--coverage--<digest>.json` — the coverage re-basis selector (as verifyRatchet). */
const COVERAGE_BASELINE_PATH = /^baselines\/[^/]*--coverage--[^/]*\.json$/;

/**
 * A canonical baseline VALUE file (`baselineRelPath`'s shape). These are
 * judged by the monotonic guard, not by the definition rule (methods note,
 * Decision 2); every other `baselines/` path is a definition change.
 */
const CANONICAL_BASELINE_PATH = /^baselines\/[^/]+--[^/]+--[0-9a-f]{12}\.json$/;

export interface PolicyDiffInput {
  /** The TRUSTED checkout (built from the trust ref); the subject is only its git objects. */
  repo: string;
  /** The trust ref (the default-branch SHA the verdict is bound to). */
  trustRef: string;
  /** The commit being judged. */
  subject: string;
  /** `pr`: a PR head judged against its base; `push`: the merge-queue tip judged against main. */
  subjectKind: 'pr' | 'push';
  /** The branch ref whose merge-base with the subject starts the judged range. */
  base: string;
  /** The PR number (the override label record is per PR). */
  pr?: number;
  /** `owner/name`, which the settle ledger must name. */
  repository?: string;
  /** The repository owner's numeric id (the only valid override actor). */
  ownerId?: number;
  /** Path of the fetched timeline label events (API data, JSON array). */
  labelEventsPath?: string;
  /** The fetched settle-ledger ref (`cq-state`), when it exists. */
  settleRef?: string;
}

export type PolicyFindingKind =
  | 'protected-path'
  | 'baseline-loosened'
  | 'target-removed'
  | 'definition-changed'
  | 'entry-removed'
  | 'required-check'
  | 'unsafe-path'
  | WorkflowFindingKind;

/** One policy finding: a kind, the path it concerns, and a one-line reason. */
export interface PolicyFinding {
  kind: PolicyFindingKind;
  path: string;
  reason: string;
}

export interface PolicyDiffOutcome {
  verdict: 'pass' | 'fail' | 'needs-human';
  posture: ProtectedPathsPosture;
  postureLayer: 'default' | 'env' | 'call';
  /** Resolved 40-hex SHAs the verdict is bound to. */
  trustRef: string;
  subject: string;
  /** Start of the judged range: merge-base(subject, base). */
  rangeBase: string;
  findings: PolicyFinding[];
  override: OverrideEvaluation;
  /** The run report: posture, range, findings, the override record, the verdict. */
  report: string[];
}

/** True when `source` compiles as a JS RegExp. */
function compiles(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** `policy/protected-paths.json`: strict, every regex source compiles, every check name non-empty. */
const PolicyListSchema = z
  .object({
    schemaVersion: z.literal(1),
    // Anchored like the definition set's entries, so no source can widen
    // what its text appears to say.
    protectedPaths: z.array(
      z
        .string()
        .min(1)
        .refine((source) => source.startsWith('^') || source.startsWith('(?:^|/)'), {
          message: 'protectedPaths entry must be anchored (start with ^ or (?:^|/))',
        })
        .refine(compiles, { message: 'protectedPaths entry must compile' }),
    ),
    requiredChecks: z.array(z.string().min(1)),
  })
  .strict();

type PolicyList = z.infer<typeof PolicyListSchema>;

/** Parse policy-list text; throws a plain Error on any violation. */
function parsePolicyList(text: string): PolicyList {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${POLICY_LIST_PATH}: not valid JSON — ${messageOf(err)}`, { cause: err });
  }
  const parsed = PolicyListSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${POLICY_LIST_PATH}: schema violation — ${issues}`);
  }
  return parsed.data;
}

/** Error message of an unknown throwable. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A side of the range that may be absent or unreadable, never a throw. */
type Side<T> = { state: 'absent' } | { state: 'bad'; reason: string } | { state: 'ok'; value: T };

/** Read and parse a JSON list file at `rev`; git faults propagate (the caller maps them to failed). */
async function readSide<T>(
  repo: string,
  rev: string,
  path: string,
  parse: (text: string) => T,
): Promise<Side<T>> {
  const text = await gitReadBlob(repo, rev, path);
  if (text === null) return { state: 'absent' };
  try {
    return { state: 'ok', value: parse(text) };
  } catch (err) {
    return { state: 'bad', reason: messageOf(err) };
  }
}

type Flows = Map<string, { text: string; scan: WorkflowScan }>;

/**
 * Every workflow file at `rev`, read and scanned. With `reuse`, a path the
 * range did NOT change is taken from the other end's reading (its blob is
 * identical there), so only changed workflows are read twice.
 */
async function workflowsAt(
  repo: string,
  rev: string,
  reuse?: { changed: ReadonlySet<string>; flows: Flows },
): Promise<Flows> {
  const out: Flows = new Map();
  for (const path of await gitListPaths(repo, rev, WORKFLOWS_DIR)) {
    if (!isWorkflowPath(path)) continue;
    const same =
      reuse !== undefined && !reuse.changed.has(path) ? reuse.flows.get(path) : undefined;
    if (same !== undefined) {
      out.set(path, same);
      continue;
    }
    const text = await gitReadBlob(repo, rev, path);
    if (text === null) continue;
    out.set(path, { text, scan: scanWorkflow(text) });
  }
  return out;
}

/**
 * True when a scanned workflow has a job whose check-run name cannot be
 * decided statically — exactly the jobs `producersOf` refuses to count: a
 * dynamic or non-literal `name:`, a reusable-workflow call, or a matrix
 * (GitHub suffixes matrix check names), per `hasUnresolvableCheckName`.
 */
function hasUnresolvableJob(scan: Extract<WorkflowScan, { ok: true }>): boolean {
  return [...scan.jobs.values()].some(hasUnresolvableCheckName);
}

/** True when `path` is `target` or under it (`.` is the repository root: every path). */
function isUnder(path: string, target: string): boolean {
  return target === '.' || path === target || path.startsWith(`${target}/`);
}

/**
 * The current `cq-override` record. Never throws: an unreadable events file
 * is `invalid` with its reason; a subject the record cannot apply to is
 * `absent` with a `not evaluated` reason. `notes` collects settle-ledger and
 * attestation observations for the report.
 */
async function evaluateOverride(
  input: PolicyDiffInput,
  trust: string,
  subject: string,
  notes: string[],
): Promise<OverrideEvaluation> {
  const skip = (why: string): OverrideEvaluation => ({
    status: 'absent',
    reasons: [`not evaluated: ${why}`],
  });
  if (input.subjectKind !== 'pr') return skip('a push subject carries no PR label record');
  if (input.pr === undefined) return skip('no PR number');
  if (input.ownerId === undefined) return skip('no repository owner id');
  if (input.labelEventsPath === undefined) return skip('no label events');

  const invalid = (why: string): OverrideEvaluation => ({
    status: 'invalid',
    reasons: [`label events unreadable: ${why}`],
  });
  let events: unknown;
  try {
    // lstat BEFORE read: a symlink or other non-regular entry is refused, never followed.
    const stat = await lstat(input.labelEventsPath);
    if (!stat.isFile()) return invalid('not a regular file');
    if (stat.size > LABEL_EVENTS_MAX_BYTES) {
      return invalid(`exceeds ${LABEL_EVENTS_MAX_BYTES} bytes`);
    }
    events = JSON.parse(await readFile(input.labelEventsPath, 'utf8'));
  } catch (err) {
    return invalid(messageOf(err));
  }
  if (!Array.isArray(events)) return invalid('not a JSON array');

  let headObservedAt: string | undefined;
  if (input.settleRef === undefined) {
    notes.push('settle ledger: no settle ref (cq-state absent)');
  } else {
    try {
      const text = await gitReadBlob(input.repo, input.settleRef, SETTLE_STATE_PATH);
      if (text === null) {
        notes.push(`settle ledger: ${SETTLE_STATE_PATH} absent at ${input.settleRef}`);
      } else {
        const { state, discarded } = parseSettleState(JSON.parse(text), input.repository ?? '');
        for (const why of discarded) notes.push(`settle ledger: discarded — ${why}`);
        headObservedAt = headObservationEpoch(state, input.pr, subject);
      }
    } catch (err) {
      notes.push(`settle ledger: unreadable — ${messageOf(err)}`);
    }
  }

  let attested = false;
  try {
    const text = await gitReadBlob(input.repo, trust, C3_ATTESTATION_PATH);
    if (text !== null) {
      const check = parseC3Attestation(text);
      attested = check.armed;
      if (!check.armed) {
        notes.push(
          `attestation: ${C3_ATTESTATION_PATH} present but invalid (${check.reason}) — records stay dormant`,
        );
      }
    }
  } catch (err) {
    notes.push(
      `attestation: ${C3_ATTESTATION_PATH} unreadable at the trust ref — ${messageOf(err)}`,
    );
  }

  return evaluateOverrideLabel({
    events,
    ownerId: input.ownerId,
    subject,
    headObservedAt,
    attested,
  });
}

/** The verdict a posture assigns to a finding list (before any override). */
function judge(
  posture: ProtectedPathsPosture,
  findings: readonly PolicyFinding[],
): PolicyDiffOutcome['verdict'] {
  if (findings.some((f) => f.kind === 'lint')) return 'fail';
  if (posture === 'human') return findings.length > 0 ? 'needs-human' : 'pass';
  return findings.some((f) => f.kind !== 'protected-path') ? 'needs-human' : 'pass';
}

/**
 * The policy-diff op, bound to a resolved posture. See the module header for
 * what is trusted and why.
 */
export function createPolicyDiff(
  config: ProtectedPathsConfig,
): Op<PolicyDiffInput, PolicyDiffOutcome> {
  return async (input) => {
    // Same base rule as verifyRatchet: a push subject is judged against main,
    // so a mislabeled push cannot silently use a PR range.
    const baseBranch = /^(?:refs\/remotes\/origin\/)?(main|merge-queue)$/.exec(input.base)?.[1];
    if (baseBranch === undefined || (input.subjectKind === 'push' && baseBranch !== 'main')) {
      return {
        status: 'failed',
        error: `policy diff: ${input.subjectKind} subject has invalid base '${input.base}'`,
      };
    }
    let trust: string;
    let subject: string;
    let rangeBase: string;
    try {
      trust = await gitRevParse(input.repo, input.trustRef);
      subject = await gitRevParse(input.repo, input.subject);
      rangeBase = await gitMergeBase(input.repo, subject, input.base);
    } catch (err) {
      return { status: 'failed', error: `policy diff: ${messageOf(err)}` };
    }

    const findings: PolicyFinding[] = [];
    const add = (kind: PolicyFindingKind, path: string, reason: string): void => {
      findings.push({ kind, path, reason });
    };

    let manifest: RatchetManifest;
    let graph: Set<string>;
    let policy: PolicyList;
    let changed: string[];
    let diff: string;
    let baseManifest: Side<RatchetManifest>;
    let subjectManifest: Side<RatchetManifest>;
    let basePolicy: Side<PolicyList>;
    let subjectPolicy: Side<PolicyList>;
    let baseFlows: Flows;
    let subjectFlows: Flows;
    let policyAbsent = false;
    try {
      manifest = await loadTrustedManifest(input.repo, trust);
      graph = new Set(await tsconfigGraphPaths(input.repo, trust));
      const trustPolicy = await gitReadBlob(input.repo, trust, POLICY_LIST_PATH);
      // Absent at the trust ref: no project lists. Present but invalid: the
      // check cannot know what it is meant to protect, so it cannot judge.
      policyAbsent = trustPolicy === null;
      policy =
        trustPolicy === null
          ? { schemaVersion: 1, protectedPaths: [], requiredChecks: [] }
          : parsePolicyList(trustPolicy);
      changed = await gitChangedPaths(input.repo, rangeBase, subject);
      const changedSet = new Set(changed);
      // Reads a range end only when the range touches it: an unchanged list
      // file cannot have lost an entry, and unchanged baselines have no diff.
      diff = changed.some((path) => path.startsWith('baselines/'))
        ? await gitDiffText(input.repo, rangeBase, subject, ['baselines/'])
        : '';
      const unchanged: Side<never> = { state: 'absent' };
      const touched = changedSet.has(RATCHETS_MANIFEST_PATH);
      baseManifest = touched
        ? await readSide(input.repo, rangeBase, RATCHETS_MANIFEST_PATH, parseRatchetManifest)
        : unchanged;
      subjectManifest = touched
        ? await readSide(input.repo, subject, RATCHETS_MANIFEST_PATH, parseRatchetManifest)
        : unchanged;
      const policyTouched = changedSet.has(POLICY_LIST_PATH);
      basePolicy = policyTouched
        ? await readSide(input.repo, rangeBase, POLICY_LIST_PATH, parsePolicyList)
        : unchanged;
      subjectPolicy = policyTouched
        ? await readSide(input.repo, subject, POLICY_LIST_PATH, parsePolicyList)
        : unchanged;
      baseFlows = await workflowsAt(input.repo, rangeBase);
      subjectFlows = await workflowsAt(input.repo, subject, {
        changed: changedSet,
        flows: baseFlows,
      });
    } catch (err) {
      return { status: 'failed', error: `policy diff: ${messageOf(err)}` };
    }

    // Unsafe paths are reported and never read (#224 composition).
    const safe: string[] = [];
    for (const path of changed) {
      try {
        assertRepoRelPath(path, 'changed path');
        safe.push(path);
      } catch (err) {
        add('unsafe-path', JSON.stringify(path), messageOf(err));
      }
    }
    const safeSet = new Set(safe);

    // protected-path / definition-changed.
    const projectPatterns = policy.protectedPaths.map((source) => new RegExp(source));
    for (const path of safe) {
      const definition = isDefinitionPath(manifest, path) || graph.has(path);
      if (
        definition ||
        isProtectedPolicyPath(path) ||
        projectPatterns.some((pattern) => pattern.test(path))
      ) {
        add('protected-path', path, 'changes a protected path');
      }
      if (definition && !CANONICAL_BASELINE_PATH.test(path)) {
        add(
          'definition-changed',
          path,
          'changes a ratchet definition (definition set or tsconfig graph)',
        );
      }
    }

    // baseline-loosened: the monotonic guard over the same range.
    const guard = checkDiffMonotonicity(normalizeBaselineDiffValues(diff, COVERAGE_BASELINE_PATH));
    if (!guard.ok) {
      const lines = formatViolations(guard.violations);
      for (const [index, violation] of guard.violations.entries()) {
        add('baseline-loosened', violation.path, lines[index] ?? violation.why);
      }
    }

    // target-removed / entry-removed (definition set).
    if (baseManifest.state === 'ok') {
      if (subjectManifest.state !== 'ok') {
        add(
          'entry-removed',
          RATCHETS_MANIFEST_PATH,
          subjectManifest.state === 'absent'
            ? 'subject manifest unreadable (deleted)'
            : `subject manifest unreadable — ${subjectManifest.reason}`,
        );
      } else {
        const key = (t: string, m: string): string => JSON.stringify([t, m]);
        const present = new Set(subjectManifest.value.ratchets.map((r) => key(r.target, r.metric)));
        for (const r of baseManifest.value.ratchets) {
          if (!present.has(key(r.target, r.metric))) {
            add(
              'target-removed',
              RATCHETS_MANIFEST_PATH,
              `removes ratchet ${r.target}/${r.metric}`,
            );
          }
        }
        const kept = new Set(subjectManifest.value.definitionSet);
        for (const entry of baseManifest.value.definitionSet) {
          if (!kept.has(entry)) {
            add('entry-removed', RATCHETS_MANIFEST_PATH, `removes definitionSet entry ${entry}`);
          }
        }
      }
    }

    // entry-removed (policy list).
    if (basePolicy.state === 'ok') {
      if (subjectPolicy.state !== 'ok') {
        add(
          'entry-removed',
          POLICY_LIST_PATH,
          subjectPolicy.state === 'absent'
            ? 'subject policy list unreadable (deleted)'
            : `subject policy list unreadable — ${subjectPolicy.reason}`,
        );
      } else {
        const keptPaths = new Set(subjectPolicy.value.protectedPaths);
        for (const entry of basePolicy.value.protectedPaths) {
          if (!keptPaths.has(entry)) {
            add('entry-removed', POLICY_LIST_PATH, `removes protectedPaths entry ${entry}`);
          }
        }
        const keptChecks = new Set(subjectPolicy.value.requiredChecks);
        for (const entry of basePolicy.value.requiredChecks) {
          if (!keptChecks.has(entry)) {
            add('entry-removed', POLICY_LIST_PATH, `removes requiredChecks entry ${entry}`);
          }
        }
      }
    }

    // Workflows: per-file diff findings for every changed workflow path.
    for (const path of safe) {
      if (!isWorkflowPath(path)) continue;
      const before = baseFlows.get(path)?.text ?? null;
      const after = subjectFlows.get(path)?.text ?? null;
      if (before === null && after === null) {
        // Changed, yet a regular file at neither end (a symlink or gitlink
        // edit): nothing to scan, so fail closed rather than report nothing.
        add(
          'workflow-unparseable',
          path,
          'changed workflow path is not a regular file at either end',
        );
        continue;
      }
      findings.push(...diffWorkflow(path, before, after));
    }

    // Local `uses: ./` targets of privileged jobs, at either end.
    const localTargets = new Map<string, string>();
    for (const flows of [baseFlows, subjectFlows]) {
      for (const [wf, { scan }] of flows) {
        if (!scan.ok) continue;
        for (const job of scan.jobs.values()) {
          if (!job.privileged) continue;
          for (const target of job.localUses) {
            if (!localTargets.has(target)) localTargets.set(target, `${wf}:${job.id}`);
          }
        }
      }
    }
    for (const path of safe) {
      for (const [target, user] of localTargets) {
        if (isUnder(path, target)) {
          add('privileged-job', path, `changes ${path} used by privileged job ${user}`);
          break;
        }
      }
    }

    // required-check: producers at the range base vs the subject. A
    // producer counts as changed only when what produces the check changed:
    // its job's normalised text (so a comment-only edit is not a change), the
    // workflow-level context, or the file itself (removed or unparseable).
    // A trigger change is already its own `trigger-changed` finding.
    const producers = (flows: Flows, check: string): Map<string, string[]> => {
      const out = new Map<string, string[]>();
      for (const [wf, { scan }] of flows) {
        if (!scan.ok) continue;
        const jobs = producersOf(scan, check);
        if (jobs.length > 0) out.set(wf, jobs);
      }
      return out;
    };
    // Changed workflows (safe paths only) whose check names cannot all be
    // decided statically at either end: unparseable, or carrying a job
    // producersOf never counts (matrix, dynamic name, reusable call).
    const unresolvable: string[] = [];
    for (const path of safe) {
      if (!isWorkflowPath(path)) continue;
      const sides = [baseFlows.get(path)?.scan, subjectFlows.get(path)?.scan];
      if (sides.some((scan) => scan !== undefined && (!scan.ok || hasUnresolvableJob(scan)))) {
        unresolvable.push(path);
      }
    }
    for (const check of policy.requiredChecks) {
      const before = producers(baseFlows, check);
      const after = producers(subjectFlows, check);
      // Phantom producers: a job the range base lacks that produces the
      // check by name would shadow it, whatever it runs.
      for (const [wf, jobs] of after) {
        const had = new Set(before.get(wf) ?? []);
        for (const id of jobs) {
          if (!had.has(id)) {
            add('required-check', wf, `adds a producer of required check ${check} (${wf}:${id})`);
          }
        }
      }
      if (before.size === 0) {
        // No statically resolvable producer at the range base: the check may
        // come from a job whose name the scanner cannot decide. Fail closed
        // when any such workflow changed.
        for (const path of unresolvable) {
          add(
            'required-check',
            path,
            `producer of required check ${check} unresolvable; ${path} changed`,
          );
        }
        continue;
      }
      if (after.size === 0) {
        add('required-check', [...before.keys()].join(', '), `removed required check ${check}`);
      }
      for (const [wf, jobs] of before) {
        if (!safeSet.has(wf)) continue;
        const baseScan = baseFlows.get(wf)?.scan;
        const afterScan = subjectFlows.get(wf)?.scan;
        if (baseScan?.ok !== true) continue;
        const changes: string[] = [];
        if (afterScan === undefined) changes.push('workflow removed');
        else if (!afterScan.ok) changes.push('workflow unparseable at the subject');
        else {
          if (afterScan.context !== baseScan.context) {
            changes.push('workflow-level context changed');
          }
          for (const id of jobs) {
            const job = afterScan.jobs.get(id);
            if (job === undefined) changes.push(`job ${id} removed`);
            else if (job.text !== baseScan.jobs.get(id)?.text) changes.push(`job ${id} changed`);
          }
        }
        if (changes.length > 0) {
          add(
            'required-check',
            wf,
            `changes the producer of required check ${check} (${changes.join('; ')})`,
          );
        }
      }
    }

    // The override record (logged whatever the verdict).
    const notes: string[] = [];
    if (policyAbsent) {
      notes.push(
        `policy list: ${POLICY_LIST_PATH} absent at the trust ref — project protectedPaths and requiredChecks are inactive`,
      );
    }
    const override = await evaluateOverride(input, trust, subject, notes);

    let verdict = judge(config.posture, findings);
    const authorized = verdict === 'needs-human' && override.status === 'honoured';
    if (authorized) verdict = 'pass';

    const report: string[] = [
      `posture: ${config.posture} (layer ${config.layer})`,
      `range: ${rangeBase}..${subject} (trust ${trust})`,
    ];
    if (findings.length === 0) report.push('findings: none');
    for (const f of findings) report.push(`${f.kind}: ${f.path} — ${f.reason}`);
    report.push(...formatOverride(override));
    for (const reason of override.status === 'absent' ? override.reasons : []) {
      report.push(`  ${reason}`);
    }
    report.push(...notes);
    report.push(
      authorized
        ? 'verdict: pass (needs-human authorized by the D11 override record)'
        : `verdict: ${verdict}`,
    );

    return {
      status: 'ok',
      value: {
        verdict,
        posture: config.posture,
        postureLayer: config.layer,
        trustRef: trust,
        subject,
        rangeBase,
        findings,
        override,
        report,
      },
    };
  };
}
