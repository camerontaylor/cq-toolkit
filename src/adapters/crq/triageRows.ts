/**
 * Read-only persisted triage row loading for the S5b dry-run planner.
 *
 * Offline port of the two reads `crq_repair/triage.py::phase` makes before it
 * plans anything:
 *
 *     rows = [ledger.loads(p.read_bytes())
 *             for p in sorted((inbox.root / 'triage').glob('*.json'))]
 *     reviews = inbox.publication.retained()
 *
 * Nothing here writes, locks, spawns a process, calls Git or a forge, or
 * reaches a provider. It is inactive: no runtime entry point imports it.
 *
 * Python 3.14 `Path.glob('*.json')` semantics (the production minor), checked
 * against the interpreter rather than assumed:
 *
 * - every directory entry whose name ends in `.json` is yielded, including
 *   `.json` itself, dotfiles, directories and dangling symlinks; the later
 *   `read_bytes()` then raises for the last two, so the load refuses;
 * - a `scandir` `OSError` (absent directory, `ENOTDIR`, `EACCES`) is
 *   swallowed and yields nothing, so an unreadable inbox is zero rows;
 * - `sorted(paths)` orders by file name code point, with undecodable bytes as
 *   lone `surrogateescape` surrogates (`U+DC80..U+DCFF`), which sort before
 *   `U+E000`; a leading U+FEFF is kept.
 *
 * Any read or `ledger.loads` failure of a yielded file aborts the whole load,
 * exactly as Python's list comprehension aborts the phase: the error is
 * propagated unchanged (`LedgerIntegrityError`, `LedgerJsonDecodeError`,
 * `LedgerUnicodeDecodeError`, or the Node `fs` error). A row that decodes to
 * something other than a JSON object is a {@link TriageRowsRefusal}: Python
 * raises `TypeError` at the first `row['finding']` / `r['target']` subscript
 * whatever the deadline, so nothing can be planned from it.
 *
 * Ordering note: Python calls `repo.begin_invocation()` before these reads;
 * the planner calls it from `planTriageDryRun`, after them. A failed load
 * aborts the phase either way, and the call only resets Git memoisation, so
 * there is no observable difference.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FindingPublication } from '../../ops/review/internal/crq/findingInbox.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { ledgerLoads } from '../../policy/crq/ledger.js';
import { compareCodePoints } from '../../policy/crq/pythonJson.js';

/** A persisted triage file whose content cannot be a triage row at all. */
export class TriageRowsRefusal extends Error {
  override readonly name = 'TriageRowsRefusal';
}

export interface TriageDryRunInputs {
  /** `ledger.loads` of `triage/*.json`, in `sorted(glob)` file-name order. */
  readonly rows: readonly JsonObject[];
  /** `inbox.publication.retained()`. */
  readonly reviews: readonly JsonValue[];
}

const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const JSON_SUFFIX = Buffer.from('.json');

/** The length of the well-formed UTF-8 sequence starting at `index`, or 0. */
function sequenceLength(bytes: Uint8Array, index: number): number {
  const lead = bytes[index] as number;
  const length =
    lead < 0x80 ? 1 : lead < 0xc2 ? 0 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf5 ? 4 : 0;
  if (length <= 1) return length;
  try {
    FATAL_UTF8.decode(bytes.subarray(index, index + length));
    return length;
  } catch {
    return 0;
  }
}

/**
 * `os.fsdecode`: UTF-8 with `surrogateescape`. Each byte that is not part of
 * a well-formed sequence becomes `U+DC00 + byte`, as CPython does.
 */
function fsDecode(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length;) {
    const length = sequenceLength(bytes, index);
    if (length === 0) {
      text += String.fromCharCode(0xdc00 + (bytes[index] as number));
      index += 1;
    } else {
      text += FATAL_UTF8.decode(bytes.subarray(index, index + length));
      index += length;
    }
  }
  return text;
}

/**
 * `sorted(directory.glob('*.json'))` as file-name buffers: every `.json`
 * entry, code-point order, and an unlistable directory is empty.
 */
async function sortedJsonNames(directory: string): Promise<readonly Buffer[]> {
  let names: Buffer[];
  try {
    names = await readdir(directory, { encoding: 'buffer' });
  } catch {
    return [];
  }
  return names
    .filter((name) => name.subarray(name.length - JSON_SUFFIX.length).equals(JSON_SUFFIX))
    .map((name) => ({ name, text: fsDecode(name) }))
    .sort((a, b) => compareCodePoints(a.text, b.text))
    .map((entry) => entry.name);
}

/**
 * `ledger.loads(p.read_bytes())` for each `triage/*.json` of one findings
 * root (`state/backfill/findings`), sorted as Python sorts the glob. The
 * list is materialised before any read, like Python's comprehension.
 */
export async function loadTriageRows(findingsRoot: string): Promise<readonly JsonObject[]> {
  const directory = join(findingsRoot, 'triage');
  const prefix = Buffer.from(`${directory}/`);
  const rows: JsonObject[] = [];
  for (const name of await sortedJsonNames(directory)) {
    const loaded = ledgerLoads(new Uint8Array(await readFile(Buffer.concat([prefix, name]))));
    if (!(loaded instanceof JsonObject)) {
      throw new TriageRowsRefusal(
        `triage row ${JSON.stringify(fsDecode(name))} is not a JSON object`,
      );
    }
    rows.push(loaded);
  }
  return rows;
}

/**
 * Both dry-run inputs in Python's read order: the triage rows, then the
 * retained reviews. `publication` is the already-exposed
 * {@link FindingPublication.retained} binding (`fileFindingPublication`).
 */
export async function loadTriageDryRunInputs(input: {
  readonly findingsRoot: string;
  readonly publication: Pick<FindingPublication, 'retained'>;
}): Promise<TriageDryRunInputs> {
  const rows = await loadTriageRows(input.findingsRoot);
  const reviews = await input.publication.retained();
  return { rows, reviews };
}
