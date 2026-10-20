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
//     dispatch) and bound into the op; op input never carries it. A D-P
//     revision window in the trust ref's list may relax a default-layer
//     posture to `diff-check` until its explicit expiry (policyConfig.ts).
//     Under `advisory` (development posture, 2026-10-20) only a
//     `privileged-path` (a path the trust ref's project `protectedPaths`
//     list names), `baseline-loosened`, `target-removed` or `entry-removed`
//     finding needs a human; every other finding is a report annotation
//     prefixed `advisory:`.
//   - THE OVERRIDE LABEL is evaluated from API timeline events and the
//     settle-ledger head epoch, logged in full, and honoured only once the
//     C3 attestation is on the trust ref and only when applied after its
//     `attestedAt` (D-G.4).
//   - A PUSH SUBJECT carries no label of its own: the promotion gate binds
//     a per-admitted-PR authorization (./d11Authorization.ts) in-process,
//     and a needs-human range passes only when every path needing a human
//     is authorized by every PR that changed it (D-C.3).
//
// Failure direction (I5): a finding the check cannot rule out is
// needs-human, never a pass; `lint` is always `fail`. `failed` is reserved for
// the check being unable to judge at all (a git fault, the trust manifest or
// policy list unreadable) — the workflow maps it to a failing check run.
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Op } from '../../kernel/types.js';
import { parseSettleState } from '../../policy/queue/settle-state.js';
import { messageOf } from '../../shared/messageOf.js';
import {
  assertRepoRelPath,
  gitChangedPaths,
  gitDiffText,
  gitListPaths,
  gitMergeBase,
  gitReadBlob,
  gitRevParse,
} from '../../adapters/git/ratchetGit.js';
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
import { authorizePaths, type D11Authorization, type D11Decision } from './d11Authorization.js';
import {
  C3_ATTESTATION_PATH,
  evaluateOverrideLabel,
  formatOverride,
  headObservationEpoch,
  parseC3Attestation,
  type OverrideEvaluation,
} from './overrideRecord.js';
import {
  RevisionWindowSchema,
  applyRevisionWindow,
  type EffectivePosture,
  type ProtectedPathsConfig,
  type ProtectedPathsPosture,
} from './policyConfig.js';
import { isProtectedPolicyPath } from './protectedPaths.js';
import {
  diffWorkflow,
  hasNonLiteralUses,
  hasUnresolvableCheckName,
  isWorkflowPath,
  producersOf,
  scanWorkflow,
  type WorkflowFindingKind,
  type WorkflowScan,
} from './workflowScan.js';

/** The project's policy list, read at the trust ref (and at both range ends for removals). */
export const POLICY_LIST_PATH = 'policy/protected-paths.json';

/**
 * The settle ledger's path on the settle ref, as the deployed automation
 * writes it (selfhost config's `SETTLE_STATE_PATH` — the same wire path the
 * self-host templates document). The path is COMPOSITION-OWNED, never op
 * input: the head observation epoch read here decides whether an override
 * record is honoured, so the bytes that supply that epoch must not be
 * selectable through dispatch data — a crafted ledger at a caller-chosen
 * path could fabricate the anchor. Callers bind the location once at
 * composition (`createPolicyDiff`'s options); the default keeps the
 * deployed wire semantics for the registry-composed workflow path.
 */
const DEFAULT_SETTLE_STATE_PATH = '.cq/settle-state.json';

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
  /**
   * Push subjects only: the per-admitted-PR D11 authorization the gate
   * bound. In-process only — the strict CLI schema cannot carry it.
   */
  authorization?: D11Authorization;
}

export type PolicyFindingKind =
  | 'protected-path'
  | 'privileged-path'
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
  /** The EFFECTIVE posture: the resolved one after the trust ref's revision window. */
  posture: ProtectedPathsPosture;
  postureLayer: EffectivePosture['layer'];
  /** The trust ref's `requiredJobs` (empty when none): what the promotion gate requires by name. */
  requiredJobs: Readonly<Record<string, readonly string[]>>;
  /** Resolved 40-hex SHAs the verdict is bound to. */
  trustRef: string;
  subject: string;
  /** Start of the judged range: merge-base(subject, base). */
  rangeBase: string;
  findings: PolicyFinding[];
  override: OverrideEvaluation;
  /** Push subjects with a bound authorization: the D11 decision over the needs-human paths. */
  d11?: D11Decision;
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

/** A workflow file name under `.github/workflows/` (no directory part). */
const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;

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
    // Jobs the promotion gate requires BY NAME in each verified workflow's
    // run (D-F.2): every job green is not enough when a job can be deleted.
    requiredJobs: z
      .record(z.string().regex(WORKFLOW_FILE), z.array(z.string().min(1)).min(1))
      .exactOptional(),
    // The D-P revision window (policyConfig.ts `applyRevisionWindow`).
    revisionWindow: RevisionWindowSchema.exactOptional(),
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

/** Longest chain of nested local actions followed before failing closed. */
const LOCAL_ACTION_MAX_DEPTH = 8;

/** The metadata files a local action may carry; both are read when both exist. */
const ACTION_METADATA = ['action.yml', 'action.yaml'] as const;

/**
 * The one `uses:` line shape the metadata scan reads: an optional `- `, the
 * plain lowercase key, then one plain or quoted value with no `#`, `\`, quote
 * or space in it, then an optional comment (whitespace before `#`, as YAML
 * requires).
 */
const STRICT_USES = /^\s*(?:-\s+)?uses\s*:\s*(['"]?)([\w.][^\s'"#\\]*)\1(?:\s+#.*)?\s*$/;

/** YAML line breaks: CRLF, a lone CR or LF, NEL, LS and PS. */
const YAML_LINE_BREAK = /\r\n?|[\n\u0085\u2028\u2029]/;

/**
 * Lines that may carry a `uses` key {@link STRICT_USES} does not read: the
 * word `uses` in any case (a quoted or capitalised key; `causes` and
 * `statuses` do not match), a double-quoted escape that can spell one (`\x`, `\u`, `\U`), an explicit
 * key (`?`), or an alias used as a key (`*name :`).
 */
const SUSPECT_USES = /\buses\b|\\[xu]|(?:^|[\s{[,])(?:\?(?:\s|$)|\*[^\s,[\]{}]+\s*:)/i;

/**
 * The `uses: ./` targets in one local action's metadata at `rev` (normalised
 * as `WorkflowJob.localUses`), or why they cannot be known. Never throws: a
 * target that is not a canonical repo-relative path (a `..` escape, a `.` or
 * empty segment), metadata absent or not a regular file, or a line that may
 * name a `uses` key ({@link SUSPECT_USES}) but is not one {@link STRICT_USES}
 * value all return a reason. Prose mentioning `uses` fails closed too: the
 * scan may over-flag, never under-flag.
 */
async function nestedLocalUses(
  repo: string,
  rev: string,
  target: string,
): Promise<string[] | string> {
  if (target !== '.') {
    try {
      assertRepoRelPath(target, 'local action');
    } catch (err) {
      return messageOf(err);
    }
  }
  const out: string[] = [];
  let found = false;
  for (const name of ACTION_METADATA) {
    const path = target === '.' ? name : `${target}/${name}`;
    let text: string | null;
    try {
      text = await gitReadBlob(repo, rev, path);
    } catch (err) {
      return messageOf(err);
    }
    if (text === null) continue;
    found = true;
    // Every YAML line break, not just `\n`: a lone `\r`, NEL, LS or PS can hide a `uses:`.
    const rows = text.split(YAML_LINE_BREAK);
    for (const [i, line] of rows.entries()) {
      if (/^\s*#/.test(line)) continue;
      const value = STRICT_USES.exec(line)?.[2];
      if (value === undefined) {
        if (SUSPECT_USES.test(line)) {
          return `${path}: unreadable uses line ${JSON.stringify(line.trim())}`;
        }
        continue;
      }
      // A plain value continuing onto a deeper line is a different value to GitHub.
      const column = /^\s*(?:-\s+)?/.exec(line)![0].length;
      const next = rows.slice(i + 1).find((r) => r.trim() !== '' && !/^\s*#/.test(r));
      if (next !== undefined && /^\s*/.exec(next)![0].length > column) {
        return `${path}: uses value continues onto the next line ${JSON.stringify(next.trim())}`;
      }
      if (value.startsWith('./')) out.push(value.slice(2).replace(/\/+$/, '') || '.');
    }
  }
  return found ? out : `no ${ACTION_METADATA.join(' or ')}`;
}

/**
 * Every local action `roots` (target → the producer job using it) reach at
 * `rev`, following nested `uses: ./` transitively: a visited set stops
 * cycles, and a chain longer than {@link LOCAL_ACTION_MAX_DEPTH} is
 * undecidable. Never throws; each target {@link nestedLocalUses} cannot
 * resolve is an `undecidable` entry, so the caller fails closed.
 */
async function localActionsAt(
  repo: string,
  rev: string,
  roots: ReadonlyMap<string, string>,
): Promise<{ targets: Map<string, string>; undecidable: { target: string; why: string }[] }> {
  const targets = new Map<string, string>();
  const undecidable: { target: string; why: string }[] = [];
  let frontier = [...roots];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth > LOCAL_ACTION_MAX_DEPTH) {
      for (const [target, user] of frontier) {
        if (targets.has(target)) continue;
        undecidable.push({
          target,
          why: `${user} nests local actions deeper than ${LOCAL_ACTION_MAX_DEPTH}`,
        });
      }
      break;
    }
    // Keyed by target, so a target two actions nest is one frontier entry.
    const next = new Map<string, string>();
    for (const [target, user] of frontier) {
      if (targets.has(target)) continue;
      targets.set(target, user);
      const nested = await nestedLocalUses(repo, rev, target);
      if (typeof nested === 'string') {
        undecidable.push({ target, why: `${user}: ${nested}` });
        continue;
      }
      for (const inner of nested) {
        if (!targets.has(inner) && !next.has(inner)) next.set(inner, user);
      }
    }
    frontier = [...next];
  }
  return { targets, undecidable };
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
  settlePath: string,
  notes: string[],
): Promise<OverrideEvaluation> {
  const skip = (why: string): OverrideEvaluation => ({
    status: 'absent',
    reasons: [`not evaluated: ${why}`],
  });
  if (input.subjectKind !== 'pr') {
    return skip('a push subject is authorized per admitted PR (D11 authorization)');
  }
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
      const text = await gitReadBlob(input.repo, input.settleRef, settlePath);
      if (text === null) {
        notes.push(`settle ledger: ${settlePath} absent at ${input.settleRef}`);
      } else {
        const { state, discarded } = parseSettleState(JSON.parse(text), input.repository ?? '');
        for (const why of discarded) notes.push(`settle ledger: discarded — ${why}`);
        headObservedAt = headObservationEpoch(state, input.pr, subject);
      }
    } catch (err) {
      notes.push(`settle ledger: unreadable — ${messageOf(err)}`);
    }
  }

  let attestedAt: string | undefined;
  try {
    const text = await gitReadBlob(input.repo, trust, C3_ATTESTATION_PATH);
    if (text !== null) {
      const check = parseC3Attestation(text);
      if (check.armed) {
        attestedAt = check.attestedAt;
      } else {
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
    attestedAt,
  });
}

/** The finding kinds that still need a human under `advisory`. */
const ADVISORY_HUMAN_KINDS: ReadonlySet<PolicyFindingKind> = new Set<PolicyFindingKind>([
  'privileged-path',
  'baseline-loosened',
  'target-removed',
  'entry-removed',
]);

/**
 * The findings that make a posture's verdict needs-human: every finding
 * under `human`; all but plain protected-path edits under `diff-check` (a
 * `privileged-path` finding is the same edit seen through the project list,
 * so it relaxes with its `protected-path` twin and diff-check verdicts are
 * unchanged); only {@link ADVISORY_HUMAN_KINDS} under `advisory`. `lint` is
 * judged before this (always `fail`).
 */
function humanFindings(
  posture: ProtectedPathsPosture,
  findings: readonly PolicyFinding[],
): PolicyFinding[] {
  switch (posture) {
    case 'human':
      return [...findings];
    case 'diff-check':
      return findings.filter((f) => f.kind !== 'protected-path' && f.kind !== 'privileged-path');
    case 'advisory':
      return findings.filter((f) => ADVISORY_HUMAN_KINDS.has(f.kind));
  }
}

/** The verdict a posture assigns to a finding list (before any override). */
function judge(
  posture: ProtectedPathsPosture,
  findings: readonly PolicyFinding[],
): PolicyDiffOutcome['verdict'] {
  if (findings.some((f) => f.kind === 'lint')) return 'fail';
  return humanFindings(posture, findings).length > 0 ? 'needs-human' : 'pass';
}

/**
 * The policy-diff op, bound to a resolved posture. See the module header for
 * what is trusted and why. `now` is the clock the trust ref's revision
 * window is judged by (injected for tests). `options.settleStatePath` binds
 * where the settle ledger is read from on the settle ref — composition-owned
 * configuration (selfhost passes its configured path; never op input, see
 * {@link DEFAULT_SETTLE_STATE_PATH}), defaulting to the deployed wire path.
 */
export function createPolicyDiff(
  config: ProtectedPathsConfig,
  options: { now?: () => number; settleStatePath?: string } = {},
): Op<PolicyDiffInput, PolicyDiffOutcome> {
  const now = options.now ?? Date.now;
  const settlePath = options.settleStatePath ?? DEFAULT_SETTLE_STATE_PATH;
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

    // protected-path / privileged-path / definition-changed. A path the
    // trust ref's project list names is BOTH: protected (every posture's
    // taxonomy) and privileged (what still needs a human under `advisory`).
    const projectPatterns = policy.protectedPaths.map((source) => new RegExp(source));
    for (const path of safe) {
      const definition = isDefinitionPath(manifest, path) || graph.has(path);
      const privileged = projectPatterns.some((pattern) => pattern.test(path));
      if (definition || isProtectedPolicyPath(path) || privileged) {
        add('protected-path', path, 'changes a protected path');
      }
      if (privileged) {
        add('privileged-path', path, `changes a privileged path (${POLICY_LIST_PATH})`);
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
        const subjectJobs = subjectPolicy.value.requiredJobs ?? {};
        for (const [file, jobs] of Object.entries(basePolicy.value.requiredJobs ?? {})) {
          const keptJobs = new Set(Object.hasOwn(subjectJobs, file) ? subjectJobs[file] : []);
          for (const job of jobs) {
            if (!keptJobs.has(job)) {
              add('entry-removed', POLICY_LIST_PATH, `removes requiredJobs entry ${file}:${job}`);
            }
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
    // workflow-level context, the file itself (removed or unparseable), or
    // any path under a local action the job runs.
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
      // Local actions a producer runs (`uses: ./`, nested ones followed), at
      // the end that runs them: a change under one changes what produces the
      // check though no job text changed. One that cannot be resolved at
      // either end fails closed, as does a producer `uses:` whose value is
      // not a literal (a block scalar): it may name one.
      const actions = new Map<string, string>();
      for (const [rev, side, flows, jobs] of [
        [rangeBase, 'range base', baseFlows, before],
        [subject, 'subject', subjectFlows, after],
      ] as const) {
        const roots = new Map<string, string>();
        for (const [wf, ids] of jobs) {
          const scan = flows.get(wf)?.scan;
          if (scan?.ok !== true) continue;
          for (const id of ids) {
            const job = scan.jobs.get(id);
            if (job === undefined) continue;
            if (hasNonLiteralUses(job)) {
              add(
                'required-check',
                wf,
                `local action of required check ${check} unresolvable at the ${side} (${wf}:${id}: a uses: value is not a literal)`,
              );
            }
            for (const target of job.localUses) {
              if (!roots.has(target)) roots.set(target, `${wf}:${id}`);
            }
          }
        }
        const resolved = await localActionsAt(input.repo, rev, roots);
        for (const [target, user] of resolved.targets) {
          if (!actions.has(target)) actions.set(target, user);
        }
        for (const { target, why } of resolved.undecidable) {
          add(
            'required-check',
            `./${target}`,
            `local action of required check ${check} unresolvable at the ${side} (${why})`,
          );
        }
      }
      for (const path of safe) {
        for (const [target, user] of actions) {
          if (isUnder(path, target)) {
            add(
              'required-check',
              path,
              `changes ${path} in local action ./${target} run by ${user}, a producer of required check ${check}`,
            );
            break;
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

    // required-check (required jobs): the gate requires the trust ref's
    // `requiredJobs` by display name in each verified workflow's run, so a
    // changed workflow that no longer statically names one would block every
    // promotion. That is a definition change: needs-human under `human` and
    // `diff-check` (never a revision-window pass), an `advisory:` annotation
    // under `advisory`.
    for (const [file, jobs] of Object.entries(policy.requiredJobs ?? {})) {
      const wf = `${WORKFLOWS_DIR}/${file}`;
      if (!safeSet.has(wf)) continue;
      const scan = subjectFlows.get(wf)?.scan;
      if (scan?.ok !== true) {
        add(
          'required-check',
          wf,
          `required jobs of ${file} unresolvable at the subject (${scan === undefined ? 'workflow removed' : 'unparseable'})`,
        );
        continue;
      }
      for (const required of jobs) {
        const named = [...scan.jobs.values()].some(
          (job) => !hasUnresolvableCheckName(job) && (job.name ?? job.id) === required,
        );
        if (!named) add('required-check', wf, `no statically named required job ${required}`);
      }
    }

    // The override record (logged whatever the verdict).
    const notes: string[] = [];
    if (policyAbsent) {
      notes.push(
        `policy list: ${POLICY_LIST_PATH} absent at the trust ref — project protectedPaths and requiredChecks are inactive`,
      );
    }
    const override = await evaluateOverride(input, trust, subject, settlePath, notes);

    // The window comes from the TRUST REF's list only (never the subject's).
    const effective = applyRevisionWindow(config, policy.revisionWindow, now());
    let verdict = judge(effective.posture, findings);
    let d11: D11Decision | undefined;
    if (input.subjectKind === 'push' && verdict === 'needs-human') {
      if (input.authorization === undefined) {
        notes.push('d11: no authorization bound for this push subject — needs-human stands');
      } else {
        const paths = humanFindings(effective.posture, findings).map((f) => f.path);
        d11 = authorizePaths(input.authorization, paths);
      }
    }
    const authorized =
      verdict === 'needs-human' &&
      (input.subjectKind === 'push' ? d11?.authorized === true : override.status === 'honoured');
    if (authorized) verdict = 'pass';

    const report: string[] = [
      `posture: ${effective.posture} (layer ${effective.layer})`,
      ...effective.lines,
      `range: ${rangeBase}..${subject} (trust ${trust})`,
    ];
    if (findings.length === 0) report.push('findings: none');
    // Under `advisory` a finding that needs no human is an annotation: still
    // listed, prefixed so the run report says it did not decide the verdict.
    const needsHuman = new Set(humanFindings(effective.posture, findings));
    for (const f of findings) {
      const note =
        effective.posture === 'advisory' && f.kind !== 'lint' && !needsHuman.has(f)
          ? 'advisory: '
          : '';
      report.push(`${note}${f.kind}: ${f.path} — ${f.reason}`);
    }
    report.push(...formatOverride(override));
    for (const reason of override.status === 'absent' ? override.reasons : []) {
      report.push(`  ${reason}`);
    }
    report.push(...notes);
    if (d11 !== undefined) report.push(...d11.lines);
    report.push(
      authorized
        ? input.subjectKind === 'push'
          ? "verdict: pass (needs-human authorized by every changing PR's D11 record)"
          : 'verdict: pass (needs-human authorized by the D11 override record)'
        : `verdict: ${verdict}`,
    );

    return {
      status: 'ok',
      value: {
        verdict,
        posture: effective.posture,
        postureLayer: effective.layer,
        requiredJobs: policy.requiredJobs ?? {},
        trustRef: trust,
        subject,
        rangeBase,
        findings,
        override,
        ...(d11 === undefined ? {} : { d11 }),
        report,
      },
    };
  };
}
