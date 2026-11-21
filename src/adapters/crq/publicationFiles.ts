/**
 * Offline file bindings for the repair publication seams: the journal
 * (`state/repair/<job>/publication.json`) read and write, the patch
 * (`publication.patch`), the fix-PR body (`fix-pr.md`) and the queue save.
 * Inactive and standalone: nothing imports this from a runtime entry point,
 * and it names no type from the publication orchestration.
 * {@link PublicationFileEffects} is a structural subset of what
 * `PublicationPublishEffects` and `PublicationFinalizeEffects`
 * (`src/queue-runner/publication{Publish,Finalize}.ts`) declare; a test pins it.
 * No git, no forge, no provider and no process spawn happen here; every path
 * derives from the injected `stateRoot` (Python's `c.STATE`).
 *
 * Two Python writers are mirrored, not unified, because they differ on disk:
 * - `crq_repair.atomic` (journal, queue): `mkdir -p` of the parent, a 0600 temp
 *   in the same directory, `json.dump(indent=2)` plus one newline, fsync,
 *   rename, fsync of the directory, temp unlinked. {@link atomicWrite} is that
 *   discipline and `atomicJsonText` is those bytes.
 * - `Path.write_text` (patch, fix-pr body): no `mkdir`, no temp, no fsync, the
 *   file truncated in place at its umask mode. A crash can leave it partial,
 *   as in Python, and a missing job directory fails (`FileNotFoundError`)
 *   instead of being created.
 *
 * Reads, matching Python 3.14 (production): `journal.exists()` is `os.path.exists`
 * so any `stat` failure reads as absent (`null`); a present journal that cannot
 * be read or parsed throws, never `null`, so a corrupt journal is not mistaken
 * for "no publication yet" and replayed. `OSError`-class failures throw
 * `PyError('OSError')`, decode/parse/digit-limit refusals `PyError('ValueError')`
 * and a document that is not a JSON object `PyError('TypeError')` (Python's
 * first `publication['head']` subscript raises it). The exception text is Node's,
 * not CPython's, so a `record.error` built from it differs in wording.
 *
 * Narrowings, all refusals where Python would act:
 * - `jobs[0]` must match the repair job grammar (`crq-[A-Za-z0-9._-]+`). Python
 *   joins any string, so `../x` or an absolute path would escape `state/repair`;
 *   a non-string is `TypeError` in both.
 * - Numbers read from a journal are plain JavaScript values (integers beyond the
 *   safe range stay `bigint`), so a Python float with an integral value (`2.0`)
 *   is rewritten as `2`. The Python writers never emit one.
 * - `save_queue`'s admission-history compaction log is not reproduced: the TS
 *   queue loader refuses a queue needing compaction, so there is none to log.
 */
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JsonObject, toPlainJson } from '../../policy/crq/jsonValue.js';
import { atomicJsonText } from '../../policy/crq/pythonJson.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import { atomicWrite } from './atomic.js';
import { checkRepairJobId } from './repairPreparation.js';
import { pathExists, readJsonValue, StateFileUnreadable } from './repairStateSource.js';

type Rec = Record<string, unknown>;

/** The publication file seams, bound to one `state/` root. */
export interface PublicationFileEffects {
  /** `json.loads(journal.read_text())` when `journal.exists()`; `null` when absent. */
  readJournal(jobId: unknown): Promise<Rec | null>;
  /** `atomic(STATE/repair/<job>/publication.json, publication)`; snapshots the value at the call. */
  writeJournal(jobId: unknown, publication: Rec): Promise<void>;
  /** `(STATE/repair/<job>/publication.patch).write_text(text)`. */
  writePatch(jobId: unknown, text: string): Promise<void>;
  /** `(STATE/repair/<job>/fix-pr.md).write_text(text)`; resolves to the path. */
  writeFixPrBody(jobId: unknown, text: string): Promise<string>;
  /** `c.save_queue(q)`: `atomic(QUEUE, q)`; snapshots the queue at the call. */
  saveQueue(q: Rec): Promise<void>;
}

export interface PublicationFilesOptions {
  /** `c.STATE` (`ROOT / 'state'`). */
  readonly stateRoot: string;
  /** `c.QUEUE`; defaults to `<stateRoot>/queue.json`. */
  readonly queuePath?: string;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/** Python raises every failed filesystem call as `OSError`; other failures pass through. */
async function asOsError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isFsError(error)) throw new PyError('OSError', error.message);
    throw error;
  }
}

/**
 * `Path.write_text`: open (create or truncate) first, then encode. A string
 * with a lone surrogate therefore leaves the file empty and raises
 * `UnicodeEncodeError` (a `ValueError`), where Node would write U+FFFD.
 */
async function writeText(path: string, text: string): Promise<void> {
  await asOsError(async () => {
    const file = await open(path, 'w');
    try {
      if (LONE_SURROGATE.test(text)) {
        throw new PyError(
          'ValueError',
          "'utf-8' codec can't encode character: surrogates not allowed",
        );
      }
      await file.writeFile(text, 'utf8');
    } finally {
      await file.close();
    }
  });
}

/**
 * `crq_repair.atomic`: the parent is made before the value is dumped, so a
 * value that cannot be serialised leaves the target untouched but the
 * directory in place. The text is built before the first await: the caller
 * may mutate the value as soon as this call is awaited.
 */
async function atomicJson(path: string, value: unknown): Promise<void> {
  let text: string | undefined;
  let failure: unknown;
  try {
    text = atomicJsonText(value);
  } catch (error) {
    failure = error;
  }
  await asOsError(() => mkdir(dirname(path), { recursive: true }));
  if (text === undefined) throw failure;
  await asOsError(() => atomicWrite(path, text));
}

export function filePublicationEffects(options: PublicationFilesOptions): PublicationFileEffects {
  const { stateRoot } = options;
  const queuePath = options.queuePath ?? join(stateRoot, 'queue.json');
  /** `STATE / 'repair' / record['jobs'][0]`. */
  const jobDir = (jobId: unknown): string => {
    if (typeof jobId !== 'string') {
      throw new PyError('TypeError', 'repair job id must be a str');
    }
    if (!checkRepairJobId(jobId)) throw new PyError('ValueError', 'invalid repair job id');
    return join(stateRoot, 'repair', jobId);
  };

  return {
    async readJournal(jobId) {
      const path = join(jobDir(jobId), 'publication.json');
      if (!(await pathExists(path))) return null;
      let value;
      try {
        value = await readJsonValue(path);
      } catch (error) {
        if (error instanceof StateFileUnreadable) {
          throw new PyError(error.origin === 'os' ? 'OSError' : 'ValueError', error.message);
        }
        throw error;
      }
      // `null`, a list or a scalar parses in Python and then fails on `publication['head']`.
      if (!(value instanceof JsonObject)) {
        throw new PyError('TypeError', 'publication journal is not a JSON object');
      }
      return toPlainJson(value, { bigints: true }) as Rec;
    },

    async writeJournal(jobId, publication) {
      await atomicJson(join(jobDir(jobId), 'publication.json'), publication);
    },

    async writePatch(jobId, text) {
      await writeText(join(jobDir(jobId), 'publication.patch'), text);
    },

    async writeFixPrBody(jobId, text) {
      const path = join(jobDir(jobId), 'fix-pr.md');
      await writeText(path, text);
      return path;
    },

    saveQueue: (q) => atomicJson(queuePath, q),
  };
}
