// proposeBaselineUpdate — lane H slice 3 (goal H3, ws-h scope item 7; UC §6 row 64).
//
// createProposeBaselineUpdate is a kernel Op factory (data-in/data-out,
// OpResult taxonomy): after a merge IMPROVES a metric, it proposes the
// corresponding baseline tightening as exactly ONE pull request — and is
// IDEMPOTENT on re-run: the same improvement set always computes the same
// head branch, an open PR on that head is UPDATED in place (same PR number),
// so re-running can never open a second proposal.
//
// THE gh SEAM (injectable effects): the op NEVER shells out, never writes to
// the workspace, and never talks to a forge itself. Everything impure —
// finding the open PR for a head, committing files and upserting the PR —
// lives behind BaselinePrEffects, injected at composition time (tests use an
// in-memory fake; the real gh-backed implementation lands in H4's workflow
// wiring). The op input carries only plain data (structuredClone-safe — the
// kernel's makeManifest clones Job.input); the effects object is runtime-only
// wiring, exactly like captureBaseline's SourceCatalog.
//
// TOKEN DOCTRINE (load-bearing): the effects implementation MUST
// authenticate with CQ_AUTOMATION_TOKEN and MUST NOT accept GITHUB_TOKEN.
// GitHub suppresses workflow runs on pull requests created with GITHUB_TOKEN,
// so a GITHUB_TOKEN-authored proposal PR would never run the required I4
// check (checkDiffMonotonicity) — an uncheckable ratchet bypass. The op
// itself never carries tokens; DEFAULT_PR_TOKEN is exported as the doctrine
// marker and the H4 runner resolves the env var.
//
// ONE PR PER IMPROVEMENT SET: every improvement that is a genuine TIGHTEN is
// grouped into a single proposal. The head branch is deterministic —
// `<headPrefix ?? 'ratchet/propose'>-<hash8>` where hash8 is the first 8 hex
// of sha256 over JSON.stringify(sorted [target, metric] pairs of the applied
// set), the canonical-JSON convention format.ts uses for baseline paths —
// so identical inputs collide onto one head and one PR, while a different
// set necessarily gets a different head. Idempotency is find-then-upsert:
// effects.findOpenPrByHead(head) hit → effects.commitAndUpsertPr on the SAME
// head (created:false expected from the impl) → proposal 'updated' with the
// FOUND PR's number; miss → proposal 'created'.
//
// I5 — never fabricate (the propose-side corollary): a proposal can only be
// built from a USABLE committed baseline. A missing baseline, an unparsable
// one, a non-regular leaf (lstat BEFORE read — symlink/fifo/dir, mirroring
// checkRatchet), a baselines dir that escapes the workspace (shared
// resolveBaselinesDir strict-descendant containment), or a file whose
// identity disagrees with the requested (target, metric) — every such
// improvement is SKIPPED with a reason naming it ('no usable baseline —
// refusing to propose from nothing'), never turned into a PR from nothing.
// Remaining usable improvements still propose.
//
// DIRECTION comes ALWAYS from the committed baseline file: this op has no
// readings — the improvement IS the reading — and the baseline's recorded
// direction is the ratchet's semantics (a committed direction that disagrees
// with a current adapter is H2's identity-check business, not a reason to
// guess here). Only tightens(baselineValue, improvementValue,
// baseline.direction) is proposed; equal or looser is skipped ('not a
// tightening').
//
// Failure direction at the op-seam level: input validation failures (null
// input, non-string ws/base/headPrefix, malformed improvements) are `failed`
// with arg-error wording; a findOpenPrByHead rejection is `failed` (nothing
// happened); a commitAndUpsertPr rejection is `indeterminate` (the commit may
// or may not have landed) — and NO throw ever crosses the op seam.
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Op } from '../../kernel/types.js';
import { resolveBaselinesDir } from './captureBaseline.js';
import { baselineRelPath, isIso8601Instant, parseBaseline, renderBaseline, tightens } from './format.js';
import type { BaselineFile, Direction } from './format.js';

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Any thrown value → a message string (the same containment helper
 * captureBaseline/checkRatchet use, copied locally rather than refactored
 * out this slice): rejections are not assumed to be Errors.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
    return 'unknown error';
  }
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/**
 * The gh effects seam — the ONLY impure surface of this op. The real
 * gh-backed implementation lands in H4's workflow wiring; tests inject
 * fakes. TOKEN DOCTRINE applies to every implementation of this interface:
 * authenticate with CQ_AUTOMATION_TOKEN, never GITHUB_TOKEN (workflow
 * suppression on GITHUB_TOKEN-created PRs would drop the required I4 check).
 */
export interface BaselinePrEffects {
  /** The open PR whose head branch equals `head`, or null when none is open. */
  findOpenPrByHead(head: string): Promise<{ number: number; url: string } | null>;
  /**
   * Commit `files` (full file contents — renderBaseline bytes) on branch
   * `head` and create the PR against `base` — or update the existing open PR
   * for that head in place (created:false, same number).
   */
  commitAndUpsertPr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
    commitMessage: string;
    files: Array<{ path: string; content: string }>;
  }): Promise<{ created: boolean; number: number; url: string }>;
}

/** Fully serializable op input: survives structuredClone. */
export interface ProposeInput {
  /** The workspace whose committed baselines ground the proposal. */
  ws: string;
  /** Branch the proposal PR targets (e.g. 'main'). */
  base: string;
  /** Head-branch prefix; default 'ratchet/propose'. */
  headPrefix?: string;
  /** Post-merge improvements (the readings): one entry per (target, metric). */
  improvements: Array<{ target: string; metric: string; value: number; capturedAt?: string }>;
}

export interface ProposeOutcome {
  /** 'created' | 'updated' for the single proposal PR; 'none' when nothing qualified. */
  proposal: 'created' | 'updated' | 'none';
  prNumber: number | null;
  prUrl: string | null;
  /** The deterministic head branch, e.g. 'ratchet/propose-1a2b3c4d'; null when 'none'. */
  head: string | null;
  /** The tightenings that went into the proposal (deterministic sorted order). */
  applied: Array<{ path: string; target: string; metric: string; oldValue: number; newValue: number }>;
  /** Improvements that produced no proposal, each with the reason naming why. */
  skipped: Array<{ target: string; metric: string; reason: string }>;
}

/** Doctrine marker: the env var the effects layer MUST resolve (see the header's TOKEN DOCTRINE). */
export const DEFAULT_PR_TOKEN = 'CQ_AUTOMATION_TOKEN' as const;

/** The exact commit message every proposal PR carries. */
const COMMIT_MESSAGE = 'chore(ratchet): tighten baselines (proposeBaselineUpdate)';

/** Default head-branch prefix. */
const DEFAULT_HEAD_PREFIX = 'ratchet/propose';

/** One tighten going into the proposal (superset of the outcome's applied row). */
interface AppliedEntry {
  path: string;
  target: string;
  metric: string;
  oldValue: number;
  newValue: number;
  direction: Direction;
  /** Full file content: byte-deterministic renderBaseline output. */
  content: string;
}

/** Deterministic (target, metric) ordering for the applied set and its hash. */
function byPair(
  a: { target: string; metric: string },
  b: { target: string; metric: string },
): number {
  if (a.target < b.target) return -1;
  if (a.target > b.target) return 1;
  if (a.metric < b.metric) return -1;
  if (a.metric > b.metric) return 1;
  return 0;
}

/** I5 wording shared by the missing-file and missing-dir skip paths. */
function noUsableBaseline(relPath: string, metric: string): string {
  return (
    `ratchet: baseline '${relPath}' for metric '${metric}' not found — ` +
    'no usable baseline — refusing to propose from nothing (I5)'
  );
}

/** Build the propose op over the injected gh effects seam. */
export function createProposeBaselineUpdate(
  effects: BaselinePrEffects,
): Op<ProposeInput, ProposeOutcome> {
  return async (input) => {
    // The input ITSELF is guarded first (mirror checkRatchet): reading
    // input.ws on a null/undefined input would throw before any field check.
    if (typeof input !== 'object' || input === null) {
      return { status: 'failed', error: 'ratchet: invalid input — expected a non-null object' };
    }
    for (const [name, value] of [
      ['ws', input.ws],
      ['base', input.base],
    ] as const) {
      if (typeof value !== 'string') {
        return { status: 'failed', error: `ratchet: invalid input — '${name}' must be a string` };
      }
    }
    if (input.headPrefix !== undefined && typeof input.headPrefix !== 'string') {
      return { status: 'failed', error: "ratchet: invalid input — 'headPrefix' must be a string" };
    }
    if (Array.isArray(input.improvements) === false) {
      return { status: 'failed', error: "ratchet: invalid input — 'improvements' must be an array" };
    }
    // Per-improvement arg validation: baselineRelPath would throw on a
    // non-string target/metric, and a non-finite value would render a
    // baseline failing its own parser — all refused here, at the boundary,
    // with arg-error wording (the whole op fails: malformed args, not
    // evidence).
    for (let i = 0; i < input.improvements.length; i++) {
      const imp: unknown = input.improvements[i];
      if (typeof imp !== 'object' || imp === null) {
        return {
          status: 'failed',
          error: `ratchet: invalid input — improvements[${i}] must be an object`,
        };
      }
      const rec = imp as { target?: unknown; metric?: unknown; value?: unknown; capturedAt?: unknown };
      for (const [name, value] of [
        ['target', rec.target],
        ['metric', rec.metric],
      ] as const) {
        if (typeof value !== 'string') {
          return {
            status: 'failed',
            error: `ratchet: invalid input — improvements[${i}].${name} must be a string`,
          };
        }
      }
      if (typeof rec.value !== 'number' || Number.isFinite(rec.value) === false) {
        return {
          status: 'failed',
          error: `ratchet: invalid input — improvements[${i}].value must be a finite number`,
        };
      }
      if (
        rec.capturedAt !== undefined &&
        (typeof rec.capturedAt !== 'string' || isIso8601Instant(rec.capturedAt) === false)
      ) {
        return {
          status: 'failed',
          error:
            `ratchet: invalid input — improvements[${i}].capturedAt ` +
            'must be a strict ISO-8601 instant',
        };
      }
    }

    const skipped: ProposeOutcome['skipped'] = [];
    // Keyed by the baseline relPath: duplicate (target, metric) improvements
    // collapse last-wins (a later reading supersedes an earlier one for the
    // same pair) so the proposal never carries the same file twice.
    const appliedByKey = new Map<string, AppliedEntry>();

    // P1 containment BEFORE any read (shared resolver): a baselines dir that
    // escapes the ws skips EVERY improvement with the resolver's message —
    // an escape never serves evidence, and nothing outside is ever touched.
    // A MISSING baselines dir is the ordinary no-baseline-yet case: every
    // improvement skips with the I5 no-usable-baseline wording.
    const containment = await resolveBaselinesDir(input.ws);
    if (containment.ok === false) {
      for (const imp of input.improvements) {
        const relPath = baselineRelPath(imp.target, imp.metric);
        skipped.push({
          target: imp.target,
          metric: imp.metric,
          reason: containment.missing
            ? noUsableBaseline(relPath, imp.metric)
            : containment.error,
        });
      }
    } else {
      for (const imp of input.improvements) {
        const relPath = baselineRelPath(imp.target, imp.metric);
        // Read through the RESOLVED dir: relPath's 'baselines/' prefix is the
        // virtual repo-relative form; containment guarantees it maps here.
        const absPath = join(containment.dir, relPath.slice('baselines/'.length));
        // Leaf check BEFORE the read (mirrors checkRatchet): lstat — not
        // stat — so a symlink at the leaf is seen as itself. Anything that is
        // not a regular file is refused as evidence even when its bytes would
        // have parsed; an ENOENT here falls through to readFile for the
        // ordinary not-found wording.
        try {
          const leafStat = await lstat(absPath);
          if (leafStat.isFile() === false) {
            skipped.push({
              target: imp.target,
              metric: imp.metric,
              reason: `ratchet: baseline '${relPath}' is not a regular file — refusing to read as evidence`,
            });
            continue;
          }
        } catch {
          // Inspectability faults land on the readFile containment below.
        }
        let text: string;
        try {
          text = await readFile(absPath, 'utf8');
        } catch (err) {
          skipped.push({
            target: imp.target,
            metric: imp.metric,
            reason: isEnoent(err)
              ? noUsableBaseline(relPath, imp.metric)
              : `ratchet: could not read baseline '${relPath}' — ${errorMessage(err)}`,
          });
          continue;
        }
        // Committed evidence that cannot be parsed cannot vouch for a
        // proposal — I5: never fabricate from nothing.
        let baseline: BaselineFile;
        try {
          baseline = parseBaseline(text);
        } catch (err) {
          skipped.push({
            target: imp.target,
            metric: imp.metric,
            reason:
              `ratchet: baseline '${relPath}' is corrupt — no usable baseline — ` +
              `refusing to propose from nothing (I5) — ${errorMessage(err)}`,
          });
          continue;
        }
        // Identity check (mirrors checkRatchet/captureBaseline): a file at
        // the expected path belonging to another identity is never accepted
        // as the baseline a proposal would rewrite.
        const disagreements: string[] = [];
        if (baseline.target !== imp.target) {
          disagreements.push(`target '${baseline.target}' → '${imp.target}'`);
        }
        if (baseline.metric !== imp.metric) {
          disagreements.push(`metric '${baseline.metric}' → '${imp.metric}'`);
        }
        if (disagreements.length > 0) {
          skipped.push({
            target: imp.target,
            metric: imp.metric,
            reason:
              `ratchet: baseline '${relPath}' for metric '${imp.metric}' disagrees on ` +
              `${disagreements.join('; ')} — incomparable evidence`,
          });
          continue;
        }
        // The ONLY path into a proposal: a genuine tighten, with the
        // direction ALWAYS from the committed baseline (this op has no
        // readings — the improvement IS the reading).
        if (tightens(baseline.value, imp.value, baseline.direction) === false) {
          skipped.push({
            target: imp.target,
            metric: imp.metric,
            reason:
              `ratchet: metric '${imp.metric}' ${baseline.value} → ${imp.value} is not a ` +
              `tightening (${baseline.direction}) — nothing to propose`,
          });
          continue;
        }
        // Rebuild from the PARSED baseline (schema-order render,
        // byte-deterministic): direction and unit are the baseline's own
        // recorded semantics; capturedAt is the improvement's (else the
        // clock). The op NEVER writes to ws — these bytes ride to the
        // effects layer, which commits them.
        const content = renderBaseline({
          schemaVersion: 1,
          target: baseline.target,
          metric: baseline.metric,
          direction: baseline.direction,
          value: imp.value,
          unit: baseline.unit,
          capturedAt: imp.capturedAt ?? new Date().toISOString(),
        });
        appliedByKey.set(relPath, {
          path: relPath,
          target: imp.target,
          metric: imp.metric,
          oldValue: baseline.value,
          newValue: imp.value,
          direction: baseline.direction,
          content,
        });
      }
    }

    // Deterministic sorted order: the PR body, the files list, and the head
    // hash are all stable regardless of the caller's improvement order.
    const applied = [...appliedByKey.values()].sort(byPair);
    if (applied.length === 0) {
      return {
        status: 'ok',
        value: { proposal: 'none', prNumber: null, prUrl: null, head: null, applied: [], skipped },
      };
    }

    // hash8 over the canonical JSON of the SORTED (target, metric) pairs —
    // the same convention format.ts uses for baseline path digests (injective
    // JSON encoding, deterministic). Same set ⇒ same head ⇒ idempotent
    // upsert; different set ⇒ different head ⇒ its own proposal.
    const pairs = applied.map((a): [string, string] => [a.target, a.metric]);
    const hash8 = createHash('sha256')
      .update(JSON.stringify(pairs), 'utf8')
      .digest('hex')
      .slice(0, 8);
    const head = `${input.headPrefix ?? DEFAULT_HEAD_PREFIX}-${hash8}`;
    const title =
      `chore(ratchet): tighten baselines (${applied.length} metric` +
      `${applied.length === 1 ? '' : 's'})`;
    const body = [
      'Automated baseline-tightening proposal from `proposeBaselineUpdate`.',
      '',
      'Each change tightens the committed baseline; the direction is the one recorded in the baseline file:',
      '',
      ...applied.map(
        (a) =>
          `- \`${a.path}\` (${a.target} / ${a.metric}): ${a.oldValue} → ${a.newValue} (${a.direction})`,
      ),
      '',
      `Target branch: \`${input.base}\`. The required I4 check (checkDiffMonotonicity) must pass before merge.`,
    ].join('\n');

    // Idempotency: find-then-upsert. A found PR is UPDATED on its own head —
    // the outcome reports the FOUND PR's number (same PR, always), never a
    // second creation.
    let open: { number: number; url: string } | null;
    try {
      open = await effects.findOpenPrByHead(head);
    } catch (err) {
      // Nothing happened yet: a definitive failure, not an indeterminate one.
      return {
        status: 'failed',
        error:
          `ratchet: could not look up an open proposal PR for head '${head}' — ` +
          errorMessage(err),
      };
    }
    try {
      const upsert = await effects.commitAndUpsertPr({
        head,
        base: input.base,
        title,
        body,
        commitMessage: COMMIT_MESSAGE,
        files: applied.map((a) => ({ path: a.path, content: a.content })),
      });
      const appliedOut = applied.map(({ path, target, metric, oldValue, newValue }) => ({
        path,
        target,
        metric,
        oldValue,
        newValue,
      }));
      if (open !== null) {
        return {
          status: 'ok',
          value: {
            proposal: 'updated',
            prNumber: open.number,
            prUrl: open.url,
            head,
            applied: appliedOut,
            skipped,
          },
        };
      }
      return {
        status: 'ok',
        value: {
          proposal: 'created',
          prNumber: upsert.number,
          prUrl: upsert.url,
          head,
          applied: appliedOut,
          skipped,
        },
      };
    } catch (err) {
      // The commit may or may not have landed: honest indeterminate, never a
      // throw across the op seam.
      return {
        status: 'indeterminate',
        detail:
          `ratchet: committing/upserting the proposal PR for head '${head}' failed — ` +
          `the commit may or may not have landed — ${errorMessage(err)}`,
      };
    }
  };
}
