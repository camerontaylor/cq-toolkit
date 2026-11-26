/**
 * Offline bindings for the independent seams `fileLaunchEffects` leaves to its
 * caller (`crq.launch`, `crq.py:2066`). Inactive: nothing routes through this.
 *
 * Bound here, each to the Python it mirrors:
 * - `checkAuthor` / `grantAuthor`: `author_lease.check_queue` / `grant_queue`
 *   (`author_lease.py:55` / `:72`) over the merged `authorAdmission` port;
 *   `AuthorRefused` becomes {@link StartAuthorRefused}, `grant_queue`'s
 *   `item["author_lease"].update(state="queue", decided_at=at)` mutates in place;
 * - `onDemandClone`: `review_transport.clone_for` (`review_transport.py:60`),
 *   the clone PATH only (the `git clone` of `provision` is not part of launch);
 * - `revParse`: `crq.git("rev-parse", spec, check=False, cwd=clone)`;
 * - `scan`: `crq.secret_scan` (`crq.py:587`) for ranges and
 *   `secret_scan_diff` over the projection patch (`crq.py:2097`), with
 *   `load_scan_exemptions` read from the exemption base commit;
 * - `scanBackfillContext`: the `.crq-review-context.json` patch scan
 *   (`crq.py:2111`), `review_ledger.canonical` of the item context;
 * - `writeBlockedReceipt`: `review_receipt.write_receipt(STATE/receipts,
 *   current_document(item, "blocked-secret-scan", rdir=rdir))`;
 * - `saveQueue`: `crq.save_queue` (`crq.py:294`), the `repair_tick.atomic` write.
 *
 * NOT bound (stays Python-only or caller-owned):
 * - `save_queue`'s admission-history compaction log (`admission_history.log_compaction`,
 *   the `_pending_admission_compaction` global): there is no TS equivalent, so a
 *   queue that still needs the compaction pass is refused at load, never saved here;
 * - gitleaks discovery: the caller supplies the binding (`fileReviewGitleaks`);
 * - `provision` (the on-demand `git clone`): not part of `launch`.
 *
 * Diff flags follow Python: a range scan is `--no-color --no-ext-diff
 * --unified=0` (`secret_scan`), a projection scan the hardened `--text
 * --no-textconv --no-ext-diff --no-renames` patch (`crq.py:2100`).
 *
 * Narrowings, all refusals where Python would act (the same as
 * `publicationSecretScan`): the strict patterns parser refuses what Python's
 * lax parser accepts, a revision starting with `-` is refused before any git
 * call, and non-UTF-8 git output is a `ValueError` (Python: its subclass
 * `UnicodeDecodeError`).
 */
import { join } from 'node:path';
import { pyStrip } from '../../ops/crq/deploy/gitGuards.js';
import { PatternsFormatError, parseDenylistPatterns } from '../../ops/dev/denylist.js';
import { AuthorRefused } from '../../policy/crq/authorWire.js';
import { checkQueue, grantQueue } from '../../policy/crq/authorAdmission.js';
import type { JsonObject } from '../../policy/crq/jsonValue.js';
import { ledgerJsonText, PythonJsonIntegrityError } from '../../policy/crq/pythonJson.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
import { sameRepoIdentity } from '../../policy/crq/repoRegistry.js';
import { UNIVERSAL_SCAN_CLASSES, type LaunchEffects } from '../../queue-runner/launch.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import { scanReviewDiff, type ReviewScannerEffects } from '../../queue-runner/reviewScan.js';
import { loadScanExemptions, SCAN_EXEMPTIONS_PATH } from '../../queue-runner/scanExemptions.js';
import { StartAuthorRefused, type StartRecord } from '../../queue-runner/startOne.js';
import { HARDENED_DIFF_FLAGS } from '../../shared/gitHarden.js';
import { atomicWrite } from './atomic.js';
import { currentDocument } from './harvestReviewEffects.js';
import type { GitCall, RunGit } from './ledgerGit.js';
import { writeLocalReviewReceipt } from './localReviewReceipt.js';
import { writeText } from './publicationFiles.js';
import { answered, clip, pyStderr, pyText } from './publicationGitReads.js';
import { runGitIn } from './publishSource.js';
import { queueBytes } from './queueEffects.js';
import { manualClonePath } from './reviewEffects.js';
import { matchReviewRegexBatch } from './reviewRegexMatcher.js';

/** `runtime_target.DEFAULT_REF`. */
const DEFAULT_REF = 'origin/main';
const PATTERNS_PATH = 'policy/denylist/patterns.yml';

/** The `LaunchEffects` seams this module binds. */
export type LaunchBoundEffects = Pick<
  LaunchEffects,
  | 'scan'
  | 'scanBackfillContext'
  | 'revParse'
  | 'writeBlockedReceipt'
  | 'checkAuthor'
  | 'grantAuthor'
  | 'onDemandClone'
  | 'saveQueue'
>;

export interface LaunchBindingsOptions {
  /** `STATE`. */
  readonly stateRoot: string;
  /** `QUEUE`. */
  readonly queuePath: string;
  /** The live plain queue `save_queue(q)` serializes, read at save time. */
  readonly queue: () => StartRecord;
  /** `CLONE`: where the denylist is read and `git(...)` defaults to. */
  readonly primaryClone: string;
  /** `REPO`. */
  readonly primaryRepo: string;
  /** `REPOS`, reduced to the repository slug and its clone. */
  readonly repos: readonly { readonly repo: string; readonly clone: string }[];
  /** `fileReviewGitleaks`; an absent binary must answer `not-run`. */
  readonly gitleaks: ReviewScannerEffects['gitleaks'];
  /** The denylist matcher; defaults to the worker-backed review matcher. */
  readonly match?: ReviewScannerEffects['match'];
  /** One hardened runner per repository directory; defaults to the shared `runGitIn`. */
  readonly runGitFor?: (repo: string) => RunGit;
}

interface Read {
  readonly code: number;
  /** Strict UTF-8, universal newlines and `str.strip()`: what `crq.git` returns. */
  readonly text: string;
  readonly call: GitCall;
}

function plainRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new PyError('AttributeError', `${what} is not a dict`);
  return value as Record<string, unknown>;
}

export function fileLaunchBindings(options: LaunchBindingsOptions): LaunchBoundEffects {
  const runGitFor = options.runGitFor ?? runGitIn;
  const match = options.match ?? matchReviewRegexBatch;
  const receipts = join(options.stateRoot, 'receipts');

  /** `crq.git(*pyArgs, check=, cwd=)`: answered, then decoded, then the status. */
  const read = async (
    cwd: string,
    args: readonly string[],
    pyArgs: readonly string[],
    check: boolean,
  ): Promise<Read> => {
    const call = await runGitFor(cwd)(args);
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

  /** `load_scan_exemptions(base, clone)` for a base that is set. */
  const exemptions = async (
    clone: string,
    base: string | null,
  ): Promise<ReturnType<typeof loadScanExemptions>> => {
    if (base === null || base === '') return { entries: [], error: null };
    const spec = `${base}:${SCAN_EXEMPTIONS_PATH}`;
    const size = await read(clone, ['cat-file', '-s', spec], ['cat-file', '-s', spec], false);
    // `cat-file -s` prints nothing to stdout when the path is absent on the base.
    if (!/^[0-9]+$/.test(size.text)) return { entries: [], error: null };
    try {
      const blob = await read(clone, ['cat-file', 'blob', spec], ['cat-file', 'blob', spec], false);
      return loadScanExemptions(blob.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { entries: [], error: `${SCAN_EXEMPTIONS_PATH}: ${message}` };
    }
  };

  const patterns = async (): Promise<string> => {
    const args = ['show', `${DEFAULT_REF}:${PATTERNS_PATH}`];
    return (await read(options.primaryClone, args, args, true)).text;
  };

  const universal = new Set(UNIVERSAL_SCAN_CLASSES);
  const runScan = async (input: {
    patternsText: string;
    diff: string;
    base: string;
    head: string;
    classes: readonly string[] | null;
    artifactPath: string;
    entries?: ReturnType<typeof loadScanExemptions>;
  }): Promise<Awaited<ReturnType<LaunchEffects['scan']>>> => {
    try {
      const decision = await scanReviewDiff(
        {
          patternsText: input.patternsText,
          diff: input.diff,
          base: input.base,
          head: input.head,
          foreign: input.classes !== null,
          extraClasses: (input.classes ?? []).filter((name) => !universal.has(name)),
          artifactPath: input.artifactPath,
          ...(input.entries
            ? { exemptions: input.entries.entries, exemptionError: input.entries.error }
            : {}),
        },
        {
          match,
          gitleaks: options.gitleaks,
          // `out.write_text(json.dumps(result, indent=2) + "\n")`: no temp file.
          writeReport: (text) => writeText(input.artifactPath, text),
        },
      );
      return {
        ok: decision.clean,
        denylistHits: decision.denylistHits,
        gitleaksHits: decision.gitleaksHits,
        artifactPath: decision.artifactPath,
      };
    } catch (error) {
      if (error instanceof PatternsFormatError) {
        throw new PyError('RuntimeError', 'denylist parse failed (fail closed)');
      }
      const unknown = /^unknown scan class: /.test(error instanceof Error ? error.message : '');
      if (unknown && input.classes !== null) {
        // Python reports the sorted-first missing class.
        const ids = new Set(
          parseDenylistPatterns(input.patternsText, 'denylist patterns').rules.map((r) => r.id),
        );
        const missing = [...new Set(input.classes)].filter((name) => !ids.has(name)).sort();
        throw new PyError(
          'RuntimeError',
          `scan class set references unknown denylist rule: ${missing[0] ?? ''}`,
        );
      }
      throw error;
    }
  };

  const revision = (value: string, what: string): string => {
    if (value === '' || value.startsWith('-'))
      throw new PyError('ValueError', `${what} is not a revision`);
    return value;
  };

  const cloneOf = (clone: string | null): string => clone ?? options.primaryClone;

  const authorRefusal = <T>(action: () => T): T => {
    try {
      return action();
    } catch (error) {
      if (error instanceof AuthorRefused) throw new StartAuthorRefused(error.message);
      throw error;
    }
  };

  return {
    checkAuthor: (item, at) => {
      authorRefusal(() => checkQueue(fromPlainJson(item) as JsonObject, at));
    },
    grantAuthor: (item, at) => {
      authorRefusal(() => grantQueue(fromPlainJson(item) as JsonObject, at));
      // `item["author_lease"].update(state="queue", decided_at=at)`, in place.
      if (Object.prototype.hasOwnProperty.call(item, 'author_lease')) {
        const lease = plainRecord(item.author_lease, 'author_lease');
        lease.state = 'queue';
        lease.decided_at = at;
      }
    },
    onDemandClone: async (repo) => {
      // `clone_for`: the primary, then a configured repo, then the manual path.
      if (sameRepoIdentity(repo, options.primaryRepo)) return options.primaryClone;
      const configured = options.repos.find((entry) => sameRepoIdentity(entry.repo, repo));
      if (configured) return configured.clone;
      const manual = manualClonePath(options.stateRoot, repo);
      if (manual === null) throw new PyError('ValueError', 'unconfigured review repository');
      return manual;
    },
    revParse: async (spec, clone) => {
      // `git rev-parse <spec>`, check=False: git echoes the spec when it cannot resolve it.
      const args = ['rev-parse', spec];
      return (await read(cloneOf(clone), args, args, false)).text;
    },
    scan: async (request) => {
      const clone = cloneOf(request.clone);
      const base = revision(request.base, 'base');
      const head = revision(request.head, 'head');
      // `secret_scan` reads `git diff --no-color --no-ext-diff --unified=0`; the projection
      // patch is `--text --no-textconv --no-ext-diff --no-renames` (`HARDENED_DIFF_FLAGS`).
      const flags =
        request.mode === 'range'
          ? ['--no-color', '--no-ext-diff', '--unified=0']
          : [...HARDENED_DIFF_FLAGS, '--unified=0'];
      const diff = (
        await read(clone, ['diff', ...flags, base, head], ['diff', ...flags, base, head], true)
      ).text;
      // A range scan reads the range base; a projection scan the resolved exemption base.
      const loaded = await exemptions(
        clone,
        request.mode === 'range' ? request.base : request.exemptionBase,
      );
      return runScan({
        patternsText: await patterns(),
        diff,
        base: request.base,
        head: request.head,
        classes: request.classes,
        artifactPath: join(request.rdir, 'secret-scan.json'),
        entries: loaded,
      });
    },
    scanBackfillContext: async (request) => {
      // `item.get("context", {})`: only an absent key defaults; a stored null stays null.
      const item = request.item as Record<string, unknown>;
      let context: string;
      try {
        context = ledgerJsonText(
          fromPlainJson(Object.prototype.hasOwnProperty.call(item, 'context') ? item.context : {}),
        );
      } catch (error) {
        if (error instanceof PythonJsonIntegrityError)
          throw new PyError('IntegrityError', error.message);
        throw error;
      }
      const patch =
        'diff --git a/.crq-review-context.json b/.crq-review-context.json\n--- /dev/null\n+++ b/.crq-review-context.json\n@@ -0,0 +1 @@\n+' +
        context +
        '\n';
      return runScan({
        patternsText: await patterns(),
        diff: patch,
        base: request.base,
        head: request.head,
        classes: null,
        artifactPath: join(request.rdir, 'context-secret-scan.json'),
      });
    },
    writeBlockedReceipt: async (item, rdir) => {
      const document = await currentDocument(rdir, item, 'blocked-secret-scan', null, null);
      return writeLocalReviewReceipt(receipts, document);
    },
    saveQueue: async () => {
      await atomicWrite(
        options.queuePath,
        queueBytes(fromPlainJson(options.queue()) as JsonObject),
      );
    },
  };
}
