/**
 * Offline binding of `repair_tick.repair_provenance` (repair_tick.py:309): the
 * provenance table `finalize_publication` appends to a fix PR's body. Inactive
 * and standalone: nothing imports this from a runtime entry point, and it
 * names no type from the publication orchestration. {@link PublicationProvenance}
 * is a structural subset of `PublicationFinalizeEffects.repairProvenance`
 * (`src/queue-runner/publicationFinalize.ts`); a test pins it. It only reads:
 * no Git, no forge, no network, no provider and no write.
 *
 * What Python reads, in order, per `record['jobs']` entry:
 *
 * 1. `state/repair/inbox/<job>.json` (`json.loads`): a missing file is
 *    `OSError`, malformed text `ValueError`, a document that is not an object
 *    `AttributeError` at the first `.get`, and any of them aborts the whole
 *    table (no partial lines).
 * 2. `state/runs/<source run>/review.ndjson`: `Path.exists()` only, so any
 *    `stat` failure reads as absent and the job file is the local locator.
 * 3. For a job with `canonical_finding_id`: `state/backfill/findings/triage/
 *    <id>.json` (`exists()` only), then, once per call, the retained review
 *    records of `state/backfill/publication/pending/*.json` through
 *    `finding_inbox(c)`. That whole lookup sits in one
 *    `except (OSError, ValueError, KeyError)`, so an absent or invalid
 *    `backfill-rollout.json`, an unreadable or malformed retained record or a
 *    review without an `id` all collapse to "no reviews" and the local locator
 *    is kept; the lookup is never retried within the call. A `TypeError` is
 *    not caught: a non-string durable root, an unhashable review `id` or an
 *    unhashable lookup key propagates.
 *
 * Python evaluates lazily and the order is observable: `a or b or c` stops at
 * the first truthy term, so `job['finding']` is only dereferenced when
 * `canonical_finding_id` is falsy, `job['source']` only when the earlier terms
 * are, and `local.relative_to(...)` only when `pr` is falsy. A present `null`
 * is not the `{}` default of `.get('finding', {})`, so it is an `AttributeError`
 * at the first dereference. `or` and `dget` below keep that.
 *
 * Paths are `pathlib` values, not strings: `Path / x` drops `.` and empty
 * segments, an absolute `x` replaces the base, `//x` keeps two leading
 * slashes, `..` is kept, and `relative_to` is a lexical prefix test that
 * raises `ValueError` (not a path under the repository root). {@link PyPath}
 * models exactly that, so the text in the PR body matches. `Path / <non-str>`
 * is a `TypeError`.
 *
 * Narrowings, all refusals where Python would act or print differently:
 * - A job id must match the repair job grammar (`crq-[A-Za-z0-9._-]+`), as
 *   in `publicationFiles`; Python would read `../x` or an absolute path.
 * - `record['jobs']` must be a list (Python would iterate a string's characters).
 * - `str()` of a list or dict (a finding `id` that is a container) is not
 *   modelled and throws; scalars, including floats, are.
 * - Retained records sort by file name as Python 3.14's `glob` does (code
 *   point order, undecodable bytes as surrogate escapes), via `triageRows`.
 */
import { readFile, stat } from 'node:fs/promises';
import {
  JsonNumber,
  JsonObject,
  pythonNumberText,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import {
  ledgerLoads,
  ledgerRecordPath,
  ledgerSubscript,
  ledgerValidate,
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerTimestampError,
  LedgerTypeError,
  LedgerUnicodeDecodeError,
  pythonTruthy,
} from '../../policy/crq/ledger.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import { checkBackfillRollout, readOptionalFile } from './backfillRollout.js';
import { SpoolConfigError } from './publisherSpool.js';
import { checkRepairJobId } from './repairPreparation.js';
import { readJsonValue, StateFileUnreadable } from './repairStateSource.js';
import { sortedJsonNames } from './triageRows.js';

type Rec = Record<string, unknown>;

/** The provenance seam, bound to one `state/` root and repository. */
export interface PublicationProvenance {
  /** `repair_provenance(c, record, run)`: the table lines, `''` first. */
  repairProvenance(record: Rec, run: string): Promise<readonly string[]>;
}

export interface PublicationProvenanceOptions {
  /** `c.STATE` (`ROOT / 'state'`). */
  readonly stateRoot: string;
  /** `c.REPO`. */
  readonly repo: string;
}

// ---------------------------------------------------------------- pathlib

/** `PurePosixPath`: an anchor (`''`, `/` or `//`) and the parts after it. */
interface PyPath {
  readonly anchor: '' | '/' | '//';
  readonly parts: readonly string[];
}

function parsePath(text: string): PyPath {
  const anchor =
    text.startsWith('//') && !text.startsWith('///') ? '//' : text.startsWith('/') ? '/' : '';
  return { anchor, parts: text.split('/').filter((part) => part !== '' && part !== '.') };
}

/** `base / segment`: an absolute segment replaces the base. */
function joinPath(base: PyPath, segment: unknown): PyPath {
  if (typeof segment !== 'string') {
    throw new PyError('TypeError', 'argument should be a str or an os.PathLike object');
  }
  const next = parsePath(segment);
  return next.anchor === '' ? { anchor: base.anchor, parts: [...base.parts, ...next.parts] } : next;
}

function pathText(path: PyPath): string {
  const body = path.parts.join('/');
  return path.anchor === '' ? (body === '' ? '.' : body) : `${path.anchor}${body}`;
}

/** `path.relative_to(root)`, lexically; `ValueError` when `path` is not under `root`. */
function relativeTo(path: PyPath, root: PyPath): string {
  const under =
    path.anchor === root.anchor &&
    path.parts.length >= root.parts.length &&
    root.parts.every((part, index) => path.parts[index] === part);
  if (!under) {
    throw new PyError(
      'ValueError',
      `'${pathText(path)}' is not in the subpath of '${pathText(root)}'`,
    );
  }
  const rest = path.parts.slice(root.parts.length);
  return rest.length === 0 ? '.' : rest.join('/');
}

/**
 * `os.fsencode` on POSIX (UTF-8, `surrogateescape`): a lone `U+DC80..U+DCFF` is
 * the raw byte, and any other lone surrogate is a `UnicodeEncodeError`
 * (`ValueError`), which `Path.exists()` reports as absent.
 */
function fsEncode(text: string): Buffer | null {
  const parts: Buffer[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code >= 0xd800 && code <= 0xdfff) {
      if (code < 0xdc80 || code > 0xdcff) return null;
      parts.push(Buffer.from([code - 0xdc00]));
    } else {
      parts.push(Buffer.from(char));
    }
  }
  return Buffer.concat(parts);
}

/** `Path.exists()` on 3.14: any `stat` or encoding failure is "does not exist". */
async function exists(path: PyPath): Promise<boolean> {
  const bytes = fsEncode(pathText(path));
  if (bytes === null) return false;
  try {
    await stat(bytes);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- python semantics

const typeName = (value: JsonValue): string =>
  value === null
    ? 'NoneType'
    : typeof value === 'boolean'
      ? 'bool'
      : typeof value === 'string'
        ? 'str'
        : value instanceof JsonNumber
          ? value.kind
          : Array.isArray(value)
            ? 'list'
            : 'dict';

/** `value.get(key)` (`undefined` is `None` from a missing key); `AttributeError` off a dict. */
function dget(value: JsonValue, key: string): JsonValue | undefined {
  if (!(value instanceof JsonObject)) {
    throw new PyError('AttributeError', `'${typeName(value)}' object has no attribute 'get'`);
  }
  return value.get(key);
}

/** `value.get(key, {})`: the default is for a missing key only, not a present `null`. */
function dgetObject(value: JsonValue, key: string): JsonValue {
  const found = dget(value, key);
  return found === undefined ? new JsonObject([]) : found;
}

/** `a or b or ...`: the first truthy term, else the last, each evaluated only if reached. */
function or(...terms: ReadonlyArray<() => JsonValue | undefined>): JsonValue {
  let last: JsonValue | undefined;
  for (const term of terms) {
    last = term();
    if (pythonTruthy(last)) return last as JsonValue;
  }
  return last ?? null;
}

/** `str(value)` for the scalars a job file carries. */
function pyStr(value: JsonValue): string {
  if (value === null) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value instanceof JsonNumber) {
    return value.kind === 'int'
      ? (value.integer as bigint).toString()
      : pythonNumberText(value.float as number);
  }
  throw new Error('str() of a list or dict is not modelled');
}

function asText(value: JsonValue, what: string): string {
  if (typeof value !== 'string') throw new PyError('TypeError', `${what} must be a str`);
  return value;
}

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/** `(OSError, ValueError, KeyError)`: what `repair_provenance` catches around the review lookup. */
function lookupFailure(error: unknown): boolean {
  return (
    isFsError(error) ||
    // `LedgerTypeError` is a `TypeError` in Python, which this `except` does not catch.
    (error instanceof LedgerIntegrityError && !(error instanceof LedgerTypeError)) ||
    error instanceof LedgerTimestampError ||
    error instanceof LedgerJsonDecodeError ||
    error instanceof LedgerUnicodeDecodeError ||
    error instanceof SpoolConfigError
  );
}

/**
 * The hashable identity a `dict` key or lookup has. Floats cannot come from a
 * retained record (`ledger.loads` refuses them) but can be a job's lookup key:
 * an integral one is the integer, `nan` equals nothing.
 */
function hashKey(value: JsonValue): string | null {
  if (value === null) return 'None';
  if (typeof value === 'string') return `s${value}`;
  if (typeof value === 'boolean') return `n${value ? 1 : 0}`;
  if (value instanceof JsonNumber) {
    if (value.kind === 'int') return `n${(value.integer as bigint).toString()}`;
    const float = value.float as number;
    if (Number.isNaN(float)) return null;
    return Number.isInteger(float) ? `n${BigInt(float).toString()}` : `f${float}`;
  }
  throw new PyError('TypeError', `unhashable type: '${typeName(value)}'`);
}

// ------------------------------------------------------------------ reads

/** `json.loads(path.read_text())`, with the classes Python raises. */
async function readJob(path: string): Promise<JsonValue> {
  try {
    return await readJsonValue(path);
  } catch (error) {
    if (error instanceof StateFileUnreadable) {
      throw new PyError(error.origin === 'os' ? 'OSError' : 'ValueError', error.message);
    }
    throw error;
  }
}

/**
 * `{v['id']: v for v in inbox.publication.retained() if isinstance(v, dict)
 * and v.get('event_type') == 'review'}` behind `finding_inbox(c)`.
 * `Outbox.retained` loads every file first, so a load failure anywhere ends
 * the lookup before any record is keyed; a review without `id` is a `KeyError`
 * and an unhashable one a `TypeError`, in file order.
 */
async function retainedReviews(state: PyPath): Promise<Map<string, JsonObject>> {
  const rollout = await readOptionalFile(pathText(joinPath(state, 'backfill-rollout.json')));
  // `settings` is `None` when the file is absent, and `finding_inbox` raises `ValueError`.
  if (rollout === null)
    throw new LedgerIntegrityError('backfill requires existing ledger configuration');
  const config = ledgerLoads(rollout);
  // `value.get(k)` on a list, string, number or null raises `AttributeError`, which is not caught.
  if (!(config instanceof JsonObject)) {
    throw new PyError('AttributeError', `'${typeName(config)}' object has no attribute 'get'`);
  }
  checkBackfillRollout(config);
  // `ArtifactStore(root)` is `Path(root).resolve()`: a non-str is `TypeError`, a NUL `ValueError`.
  const root = config.get('durable_artifact_root');
  if (typeof root !== 'string')
    throw new PyError('TypeError', 'durable_artifact_root must be a str');
  if (root.includes('\0')) throw new LedgerIntegrityError('embedded null byte');

  // `pathlib` keeps `..`, so a symlinked segment before it resolves in the kernel, not lexically.
  const pending = pathText(joinPath(state, 'backfill/publication/pending'));
  const prefix = Buffer.from(`${pending}/`);
  const records: JsonValue[] = [];
  for (const name of await sortedJsonNames(pending)) {
    records.push(ledgerLoads(new Uint8Array(await readFile(Buffer.concat([prefix, name])))));
  }
  const reviews = new Map<string, JsonObject>();
  for (const record of records) {
    if (!(record instanceof JsonObject) || record.get('event_type') !== 'review') continue;
    const key = hashKey(ledgerSubscript(record, 'id'));
    if (key !== null) reviews.set(key, record);
  }
  return reviews;
}

/** The ledger URL for a retained review that validates and holds the finding, else `null`. */
function ledgerLink(review: JsonObject, repo: string, findingId: string): string | null {
  try {
    ledgerValidate(review);
    const payload = ledgerSubscript(review, 'payload');
    if (ledgerSubscript(payload, 'repo') !== repo) return null;
    const findings = ledgerSubscript(payload, 'findings');
    if (!Array.isArray(findings)) return null;
    for (const finding of findings) {
      if (ledgerSubscript(finding, 'id') === findingId) {
        return `[ledger review](https://github.com/${repo}/blob/cq/review-ledger/${ledgerRecordPath(review)})`;
      }
    }
    return null;
  } catch (error) {
    // `except (ValueError, KeyError, TypeError)`: keep an accurate local locator.
    // `LedgerIntegrityError` covers `LedgerKeyError` and `LedgerTypeError` too.
    if (error instanceof LedgerIntegrityError || error instanceof LedgerTimestampError) return null;
    throw error;
  }
}

export function filePublicationProvenance(
  options: PublicationProvenanceOptions,
): PublicationProvenance {
  const { stateRoot, repo } = options;
  const state = parsePath(stateRoot);
  const root: PyPath = { anchor: state.anchor, parts: state.parts.slice(0, -1) };
  const real = (path: PyPath): string => pathText(path);

  return {
    async repairProvenance(record, run) {
      const runText = asText(run as JsonValue, 'run');
      const lines = [
        '',
        `Source run: \`${runText}\``,
        '',
        '| finding ID | source ledger/review | source |',
        '|---|---|---|',
      ];
      if (!Object.hasOwn(record, 'jobs')) throw new PyError('KeyError', "'jobs'");
      const jobs = record.jobs;
      // A string or dict iterates its characters or keys in Python: refused, not modelled.
      if (
        typeof jobs === 'string' ||
        (typeof jobs === 'object' && jobs !== null && !Array.isArray(jobs))
      )
        throw new Error('jobs must be a list');
      if (!Array.isArray(jobs))
        throw new PyError('TypeError', `'${typeof jobs}' object is not iterable`);

      let reviews: Map<string, JsonObject> | undefined;
      for (const jobId of jobs) {
        const id = asText(jobId as JsonValue, 'job id');
        if (!checkRepairJobId(id)) throw new PyError('ValueError', 'invalid repair job id');
        const jobFile = joinPath(joinPath(state, 'repair/inbox'), `${id}.json`);
        const job = await readJob(real(jobFile));
        const finding = dgetObject(job, 'finding');
        const source = (): JsonValue => dgetObject(job, 'source');
        const fid = or(
          () => dget(job, 'canonical_finding_id'),
          () => dget(finding, 'id'),
          () => dget(finding, 'source_id'),
          () => dget(source(), 'id'),
          () => dget(source(), 'source_id'),
          () => id,
        );
        const origin = or(
          () => dget(job, 'review_id'),
          () => dget(source(), 'review_id'),
          () => dget(source(), 'run'),
          () => dget(job, 'run'),
          () => runText,
        );
        const sourceRun = or(
          () => dget(source(), 'run'),
          () => dget(job, 'run'),
          () => runText,
        );
        const raw = joinPath(joinPath(joinPath(state, 'runs'), sourceRun), 'review.ndjson');
        let local = (await exists(raw)) ? raw : jobFile;
        const pr = dget(job, 'pr');
        let link = pythonTruthy(pr)
          ? `https://github.com/${repo}/pull/${pyStr(pr as JsonValue)}`
          : `threadless; local source \`${relativeTo(local, root)}\``;

        if (pythonTruthy(dget(job, 'canonical_finding_id'))) {
          const row = joinPath(
            joinPath(state, 'backfill/findings/triage'),
            `${asText(fid, 'finding id')}.json`,
          );
          local = (await exists(row)) ? row : jobFile;
          link = `threadless; local source \`${relativeTo(local, root)}\``;
          if (reviews === undefined) {
            try {
              reviews = await retainedReviews(state);
            } catch (error) {
              if (!lookupFailure(error)) throw error;
              reviews = new Map();
            }
          }
          const key = hashKey(
            or(
              () => dget(job, 'review_id'),
              () => dget(source(), 'review_id'),
            ),
          );
          const review = key === null ? undefined : reviews.get(key);
          if (review !== undefined) {
            link = ledgerLink(review, repo, fid as string) ?? link;
          }
        }
        lines.push(`| \`${pyStr(fid)}\` | \`${pyStr(origin)}\` | ${link} |`);
      }
      return lines;
    },
  };
}
