/**
 * Offline secret-scan binding for the repair publication seam:
 * `c.secret_scan(target, head, STATE/repair/<job>/publication-secret-scan.json)`,
 * the defensive scan `repair_tick.publish` runs over the final rebased
 * publication, after the hack detector and before anything is journaled or pushed.
 * Inactive and standalone: nothing imports this from a runtime entry point,
 * and it names no type from the publication orchestration.
 * {@link PublicationSecretScan} is a structural subset of what
 * `PublicationPublishEffects` (`src/queue-runner/publicationPublish.ts`)
 * declares for `secretScan`; a test pins it.
 *
 * The scan engine is not re-implemented: `scanReviewDiff` is the TypeScript
 * port of `crq.secret_scan_diff` (denylist over added and removed lines,
 * `ALLOWLIST_PATHS`, base-commit exemptions, the gitleaks veto and the report
 * bytes) and the review matcher and gitleaks bindings are reused. This module
 * binds only what `crq.secret_scan` itself does around it, in Python's order,
 * each Git read in the primary clone:
 * 1. `git diff --unified=0 <base> <head>` (the scanned patch);
 * 2. `load_scan_exemptions(base)`: `cat-file -s <base>:.crq/scan-exemptions.toml`,
 *    then `cat-file blob` of it. Absent is no exemptions and no error; any
 *    failure to read, decode or parse the blob is `exemption_error` and no
 *    exemptions, so it fails closed;
 * 3. `git show origin/main:policy/denylist/patterns.yml` (the rules);
 * 4. the scan, then the report written with `Path.write_text` semantics
 *    (truncated in place, no `mkdir`: a missing job directory is a failure).
 * It resolves to `not hits and not gl_hits`.
 *
 * Failure classes, which `publishRepair` branches on:
 * - A clean verdict is `true`; a dirty one is `false`, which `publishRepair`
 *   turns into `ValueError('publication secret scan failed')`. Anything this
 *   seam throws propagates unchanged and the worktree is removed; nothing is
 *   journaled or pushed after a scan, so a refused scan leaves no state.
 * - A Git read that exits non-zero is `PyError('RuntimeError')` with Python's
 *   `c.git` text, `git <argv[:6]> … exit <n>: <stderr[:400]>`. A process that
 *   never produced an exit code is `PyError('OSError')`, as in the sibling
 *   reads, except for the exemption blob read, where Python's `try` also
 *   swallows it into `exemption_error`. Invalid UTF-8 is `PyError('ValueError')`.
 * - A patterns file the strict parser refuses (or one with no rule) is
 *   `PyError('RuntimeError', 'denylist parse failed (fail closed)')`.
 * - A report that cannot be written is `PyError('OSError')`, Python's
 *   `FileNotFoundError`/`PermissionError`.
 * - A matcher or gitleaks failure is not wrapped: `scanReviewDiff` throws a
 *   plain `Error` and writes no report, so an unavailable scanner is never a
 *   clean verdict. Python lets a gitleaks report that cannot be parsed raise
 *   as well, so both refuse.
 *
 * Parity points a reader should not "fix":
 * - Exemptions come from the BASE commit only, never from head: a change that
 *   adds an exemption cannot exempt itself.
 * - A gitleaks exit other than 0 is a `gitleaks-error` hit, not a skip; only
 *   an absent binary is `not-run`, and then the denylist alone decides.
 * - The report is written for a dirty verdict too, and `exempted` appears
 *   only when something was exempted or `exemption_error` is set.
 *
 * Narrowings, all refusals (or more scanning) where Python would act:
 * - `base` and `head` must be 40-hex object ids (`ValueError`), checked before
 *   any Git call, so neither can be read as an option or a revision expression.
 * - The diff adds `HARDENED_DIFF_FLAGS` (`--text --no-ext-diff --no-textconv
 *   --no-renames` and pinned prefixes). A binary file or a pure rename is
 *   therefore scanned by content where Python's plain diff prints only a
 *   marker; an ambient `diff.external` or `diff.textconv` cannot reshape it.
 * - Quoted paths (`core.quotePath`) are decoded and an undecodable one refuses
 *   the scan, where Python matches the quoted text literally.
 * - The strict constrained-format patterns parser refuses a file Python's
 *   lax line parser would accept.
 * - The job id must match the repair job grammar, as in `publicationFiles`.
 */
import { join } from 'node:path';
import { pyStrip } from '../../ops/crq/deploy/gitGuards.js';
import { PatternsFormatError } from '../../ops/dev/denylist.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import { scanReviewDiff, type ReviewScannerEffects } from '../../queue-runner/reviewScan.js';
import { loadScanExemptions, SCAN_EXEMPTIONS_PATH } from '../../queue-runner/scanExemptions.js';
import { HARDENED_DIFF_FLAGS } from '../../shared/gitHarden.js';
import type { GitCall, RunGit } from './ledgerGit.js';
import { answered, clip, commit, pyStderr, pyText } from './publicationGitReads.js';
import { repairJobDir, writeText } from './publicationFiles.js';
import { runGitIn } from './publishSource.js';
import { matchReviewRegexBatch } from './reviewRegexMatcher.js';

/** `runtime_target.DEFAULT_REF`. */
const DEFAULT_REF = 'origin/main';
const PATTERNS_PATH = 'policy/denylist/patterns.yml';
/** The report file `publish` names next to `publication.patch`. */
export const SECRET_SCAN_REPORT = 'publication-secret-scan.json';

/** The publication secret-scan seam, bound to one clone and one `state/` root. */
export interface PublicationSecretScan {
  /**
   * `c.secret_scan(base, head, STATE/repair/<job>/publication-secret-scan.json)[0]`:
   * true when neither the denylist nor gitleaks has an unexempted hit.
   */
  secretScan(jobId: unknown, target: string, head: string): Promise<boolean>;
}

export interface PublicationSecretScanOptions {
  /** `c.STATE` (`ROOT / 'state'`). */
  readonly stateRoot: string;
  /** `c.CLONE`: the primary clone, where every read runs and `origin/main` is resolved. */
  readonly clone: string;
  /** One hardened runner per repository directory; defaults to the shared `runGitIn`. */
  readonly runGitFor?: (repo: string) => RunGit;
  /** The denylist matcher; defaults to the worker-backed review matcher. */
  readonly match?: ReviewScannerEffects['match'];
  /** The gitleaks binding (`fileReviewGitleaks`); an absent binary must answer `not-run`. */
  readonly gitleaks: ReviewScannerEffects['gitleaks'];
}

interface Read {
  readonly code: number;
  /** Strict UTF-8, universal newlines and `str.strip()`: what `c.git` returns. */
  readonly text: string;
  readonly call: GitCall;
}

export function gitPublicationSecretScan(
  options: PublicationSecretScanOptions,
): PublicationSecretScan {
  const runGitFor = options.runGitFor ?? runGitIn;
  const match = options.match ?? matchReviewRegexBatch;

  /**
   * `c.git(*pyArgs, check=...)` in the clone. Python's `subprocess.run(text=True)`
   * decodes before it checks the exit status, so the order is: answered, decode,
   * then the status. The message names Python's argv, not the hardened one.
   */
  const read = async (
    args: readonly string[],
    pyArgs: readonly string[],
    check: boolean,
  ): Promise<Read> => {
    const call = await runGitFor(options.clone)(args);
    const code = answered(call);
    const text = pyText(call);
    if (check && code !== 0) {
      throw new PyError(
        'RuntimeError',
        `${['git', ...pyArgs].slice(0, 6).join(' ')} … exit ${code}: ${clip(pyStrip(pyStderr(call)), 400)}`,
      );
    }
    return { code, text: pyStrip(text), call };
  };

  /** `load_scan_exemptions(base)` for a base that is set. */
  const exemptions = async (base: string): Promise<ReturnType<typeof loadScanExemptions>> => {
    const spec = `${base}:${SCAN_EXEMPTIONS_PATH}`;
    const size = await read(['cat-file', '-s', spec], ['cat-file', '-s', spec], false);
    // `cat-file -s` prints nothing to stdout when the path is absent on the base.
    if (!/^[0-9]+$/.test(size.text)) return { entries: [], error: null };
    try {
      const blob = await read(['cat-file', 'blob', spec], ['cat-file', 'blob', spec], false);
      return loadScanExemptions(blob.text);
    } catch (error) {
      // Any failure to read, decode or parse fails closed: no exemptions at all.
      const message = error instanceof Error ? error.message : String(error);
      return { entries: [], error: `${SCAN_EXEMPTIONS_PATH}: ${message}` };
    }
  };

  return {
    async secretScan(jobId, target, head) {
      const reportPath = join(repairJobDir(options.stateRoot, jobId), SECRET_SCAN_REPORT);
      const base = commit(target, 'base');
      commit(head, 'head');

      const diff = (
        await read(
          ['diff', ...HARDENED_DIFF_FLAGS, '--unified=0', base, head],
          ['diff', '--no-color', '--no-ext-diff', '--unified=0', base, head],
          true,
        )
      ).text;
      const loaded = await exemptions(base);
      const patternsArgs = ['show', `${DEFAULT_REF}:${PATTERNS_PATH}`];
      const patternsText = (await read(patternsArgs, patternsArgs, true)).text;

      try {
        const decision = await scanReviewDiff(
          {
            patternsText,
            diff,
            base,
            head,
            foreign: false,
            extraClasses: [],
            artifactPath: reportPath,
            exemptions: loaded.entries,
            exemptionError: loaded.error,
          },
          {
            match,
            gitleaks: options.gitleaks,
            // `out.write_text(json.dumps(result, indent=2) + "\n")`: no mkdir, no temp file.
            writeReport: (text) => writeText(reportPath, text),
          },
        );
        return decision.clean;
      } catch (error) {
        if (error instanceof PatternsFormatError) {
          throw new PyError('RuntimeError', 'denylist parse failed (fail closed)');
        }
        throw error;
      }
    },
  };
}
