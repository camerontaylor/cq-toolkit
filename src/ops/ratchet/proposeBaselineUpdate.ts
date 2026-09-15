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
// ONE PR PER IMPROVEMENT SET: every judged improvement that is a genuine
// TIGHTEN is grouped into a single proposal. The head branch is
// deterministic — `<headPrefix ?? 'ratchet/propose'>-<digest>` where digest
// is the first 12 hex (48 bits — the same width as format.ts's baseline-path
// digest) of sha256 over JSON.stringify(sorted [target, metric] pairs of the
// applied set), the canonical-JSON convention format.ts uses for baseline
// paths — so identical inputs collide onto one head and one PR, while a
// different set cannot practically share a head branch. Idempotency is
// find-then-upsert: effects.findOpenPrByHead(head) hit →
// effects.commitAndUpsertPr on the SAME head (created:false expected from
// the impl) → proposal 'updated'; miss → proposal 'created'. The UPSERT
// result carries the AUTHORITATIVE PR identity (a PR found open can be
// closed/merged between find and upsert, making the impl's fresh creation
// the truth); the find result is only a fallback. Duplicate (target, metric)
// improvements collapse LAST-WINS before the tighten gate: the newest
// reading is the truth, so a later non-tightening supersedes an earlier
// tightening and drops the metric from the proposal entirely. headPrefix is
// arg-validated to form a valid git ref.
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
  // The whole body is guarded (review-debt #72): a hostile thrown object's
  // `message` getter can itself throw, and a containment helper that
  // throws inside a catch handler would REPLACE the original fault.
  try {
    if (err instanceof Error) return err.message;
    if (typeof err === 'object' && err !== null) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string' && message !== '') return message;
      return 'unknown error';
    }
    if (typeof err === 'string') return err;
  } catch {
    // the thrown value's message accessor threw — fall through
  }
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
  /**
   * The open PR whose head branch equals `head`, or null when none is open.
   * SEAM CONTRACT for implementations (review-debt #87 round-3, item 6):
   * GitHub allows ONE head with MULTIPLE open PRs against DIFFERENT bases,
   * so an implementation must disambiguate on the (head, base) PAIR — the
   * proposal op only ever means "the open PR for this head against the
   * input's base" (H4's wiring receives the base alongside the head; the
   * narrow head-only signature stays because the op passes its own single
   * base through the wiring, not because the base is irrelevant).
   */
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
  /** The deterministic head branch, e.g. 'ratchet/propose-1a2b3c4d5e6f'; null when 'none'. */
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

/** Branch ref-name characters (the remaining check-ref-format rules live in violatesRefShapeRules/violatesWholeRefRules). */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The check-ref-format rules that matter for a branch name — applied with
 * git's own SCOPING (PR #110 review, Codex P2): the trailing-dot and
 * *.lock restrictions bind the END OF THE COMPLETE REF, not every
 * component ('release./main' is a legal ref; 'release.lock-<digest>' does
 * not end in .lock), while the dot-LEADING restriction binds EVERY
 * component ('.hidden' cannot be a branch component anywhere). Also per
 * check-ref-format: no leading/trailing slash, no '//', no '..' walk-up,
 * no '@{' sequence, not the lone '@'. Anything violating this could not
 * exist as a git ref at all — and could not ride clean markdown into the
 * PR body either.
 */
function violatesRefShapeRules(value: string): boolean {
  return (
    REF_PATTERN.test(value) === false ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('//') ||
    value.includes('..') ||
    value.includes('@{') ||
    value === '@' ||
    value.split('/').some((segment) => segment.startsWith('.'))
  );
}

/**
 * Whole-ref END rules (PR #110 review): the trailing-dot and *.lock
 * restrictions bind the END OF THE COMPLETE REF — a BASE is a complete ref
 * and is validated with them; the head PREFIX is validated with the shape
 * rules only, because the head is judged as the branch it actually
 * becomes (`<prefix>-<digest>`, below) — a prefix like 'release.lock' or
 * 'main.' is legal when its composition does not end in '.lock' or '.'.
 */
function violatesWholeRefRules(value: string): boolean {
  return violatesRefShapeRules(value) || value.endsWith('.') || value.endsWith('.lock');
}

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

/**
 * Markdown safety for the PR body: identity fields render inside backticks,
 * so a raw target/metric carrying backticks or newlines could break out of
 * them and inject body content — those characters are STRIPPED for the body
 * rendering only. The committed FILE keeps the raw identity (parseBaseline's
 * business, not markdown's), and the baselines/ path is inert by
 * construction (sanitizeSegment admits [a-z0-9-] only).
 */
function mdSafe(identity: string): string {
  return identity.replace(/[`\r\n]/g, '');
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
    if (input.headPrefix !== undefined) {
      if (typeof input.headPrefix !== 'string') {
        return { status: 'failed', error: "ratchet: invalid input — 'headPrefix' must be a string" };
      }
      // A git ref, not free text (see violatesRefShapeRules) — else the head
      // could not exist at all.
      if (violatesRefShapeRules(input.headPrefix)) {
        return {
          status: 'failed',
          error: "ratchet: invalid input — 'headPrefix' would form an invalid git ref",
        };
      }
    }
    // The base branch gets the same ref discipline: the proposal PR must
    // target a ref that can exist, and a free-text base could smuggle
    // markdown into the body's target line.
    if (violatesWholeRefRules(input.base)) {
      return {
        status: 'failed',
        error: "ratchet: invalid input — 'base' would form an invalid git ref",
      };
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
    // Duplicate (target, metric) improvements collapse LAST-WINS among the
    // entries that get judged: improvements are grouped by pair in input
    // order and only the LAST entry per pair survives to the gate. The
    // newest evidence is the truth — a later non-tightening reading
    // SUPERSEDES an earlier tightening (the metric is dropped from the
    // proposal entirely, never kept at the older tightened value), and a
    // later tightening after a looser entry still proposes. The tighten gate
    // then runs ONCE per metric, on the surviving entry only; superseded
    // entries produce no records at all. The group key is the canonical JSON
    // of the raw pair (injective — format.ts's own digest argument), so even
    // exotic strings cannot alias another pair's group.
    const lastByKey = new Map<string, ProposeInput['improvements'][number]>();
    for (const imp of input.improvements) {
      lastByKey.set(JSON.stringify([imp.target, imp.metric]), imp);
    }
    const judged = [...lastByKey.values()];
    const applied: AppliedEntry[] = [];

    // P1 containment BEFORE any read (shared resolver): a baselines dir that
    // escapes the ws skips EVERY judged improvement with the resolver's
    // message — an escape never serves evidence, and nothing outside is ever
    // touched. A MISSING baselines dir is the ordinary no-baseline-yet case:
    // every judged improvement skips with the I5 no-usable-baseline wording.
    const containment = await resolveBaselinesDir(input.ws);
    if (containment.ok === false) {
      for (const imp of judged) {
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
      for (const imp of judged) {
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
        applied.push({
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
    applied.sort(byPair);
    if (applied.length === 0) {
      return {
        status: 'ok',
        value: { proposal: 'none', prNumber: null, prUrl: null, head: null, applied: [], skipped },
      };
    }

    // 12-hex (48-bit) digest over the canonical JSON of the SORTED (target,
    // metric) pairs — the same convention AND width as format.ts's baseline
    // path digest (injective JSON encoding, deterministic). Same set ⇒ same
    // head ⇒ idempotent upsert; a different set cannot practically collide
    // onto the same head branch.
    const pairs = applied.map((a): [string, string] => [a.target, a.metric]);
    const digest = createHash('sha256')
      .update(JSON.stringify(pairs), 'utf8')
      .digest('hex')
      .slice(0, 12);
    const head = `${input.headPrefix ?? DEFAULT_HEAD_PREFIX}-${digest}`;
    if (violatesWholeRefRules(head)) {
      return {
        status: 'failed',
        error: `ratchet: invalid input — the composed head '${head}' would form an invalid git ref`,
      };
    }
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
          `- \`${a.path}\` (${mdSafe(a.target)} / ${mdSafe(a.metric)}): ${a.oldValue} → ${a.newValue} (${a.direction})`,
      ),
      '',
      `Target branch: \`${mdSafe(input.base)}\`. The required I4 check (checkDiffMonotonicity) must pass before merge.`,
    ].join('\n');

    // Idempotency: find-then-upsert. A found PR is UPDATED on its own head —
    // one PR per improvement set, never a second creation. The verdict uses
    // the find result; the REPORTED PR identity is the upsert result's
    // (authoritative — see below).
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
      // The UPSERT result carries the AUTHORITATIVE PR identity: a PR found
      // open can be closed/merged between find and upsert, and the impl then
      // legitimately creates a DIFFERENT PR — its number/url is the truth.
      // The find result is a FALLBACK only, for an impl that reports no
      // identity from the upsert (the seam is wide; runtime is verified).
      const prNumber = typeof upsert.number === 'number' ? upsert.number : (open?.number ?? null);
      const prUrl =
        typeof upsert.url === 'string' && upsert.url !== '' ? upsert.url : (open?.url ?? null);
      // The VERDICT follows the upsert's `created` flag when the impl
      // reports one (review-debt #87 round-3): the find result is stale by
      // construction — a PR found open can be closed/merged between find
      // and upsert, and the impl's fresh creation is then the truth. The
      // find result remains the FALLBACK for an impl that reports no flag
      // (same wide-seam posture as the identity fields above).
      const verdictFromUpsert: 'created' | 'updated' | undefined =
        upsert.created === true ? 'created' : upsert.created === false ? 'updated' : undefined;
      return {
        status: 'ok',
        value: {
          proposal: verdictFromUpsert ?? (open !== null ? 'updated' : 'created'),
          prNumber,
          prUrl,
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
