/**
 * `backfill_accounting.Repository.verify_review` and its `restore` step, ported
 * over the hardened `RunGit` seam: a creditable review record is only
 * publishable when the repository evidence actually supports it.
 *
 * Python parity, kept exactly:
 *
 * - `ledger.validate(value)` runs first; a non-creditable record is accepted
 *   with an empty map (`verify_review` returns {} and the caller proceeds).
 * - `restore(artifacts, store)`: each retained reference is verified against
 *   the durable store; `git-bundle` references are additionally verified and
 *   unbundled into the review clone, so fetched history becomes object-visible.
 * - `resolve`: only full 40..64-hex object ids; `rev-parse <oid>^{commit}`.
 * - Tree identity: `rev-parse <commit>^{tree}` must equal `target_tree` and
 *   `head_tree`, else "review tree mismatch".
 * - Entries: `ls-tree -r -z` maps path -> {mode, kind, blob}.
 * - Changed intervals: `diff --no-ext-diff --no-textconv --no-color
 *   --src-prefix=a/ --dst-prefix=b/ --no-renames --unified=0 base head`,
 *   parsed per Python's hunk state machine (malformed hunks, lengths and
 *   truncation refuse; quoted or backslash paths fall back to no-tracking).
 * - Per scope row: the blob must match the recorded entries on both sides,
 *   the mode must be a regular file, claimed lines must lie within the blob's
 *   line count, and the claimed set must be a subset of the changed intervals.
 */
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCreditable,
  ledgerPath,
  ledgerScope,
  ledgerValidate,
} from '../../policy/crq/ledger.js';
import type { GitCall, RunGit } from './ledgerGit.js';

function integrity(message: string): LedgerIntegrityError {
  return new LedgerIntegrityError(message);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** One git call over the injected runner; stderr is surfaced on failures. */
function git(call: GitCall): Uint8Array {
  if (call.code !== 0) {
    throw integrity(
      `git ${call.args[0] ?? ''} failed: ${call.stderr.slice(0, 200) || `exit ${call.code ?? 'signal'}`}`,
    );
  }
  return call.stdout;
}

/** Python's `line_bytes`: split on \n, dropping the trailing empty element. */
function lineBytes(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let count = 1;
  for (const byte of data) if (byte === 0x0a) count += 1;
  if (data[data.length - 1] === 0x0a) count -= 1;
  return count;
}

const OID_40_64 = /^[0-9a-f]{40,64}$/;

/** Python's `Repository.restore`: verify each reference, unbundle git bundles. */
export async function restoreArtifacts(
  runGit: RunGit,
  value: JsonObject,
  verify: (reference: { sha256: string; location: string }) => Promise<void>,
): Promise<void> {
  const payload = value.get('payload');
  const references =
    payload instanceof JsonObject && Array.isArray(payload.get('artifacts'))
      ? (payload.get('artifacts') as readonly JsonValue[])
      : [];
  for (const reference of references) {
    const record =
      reference instanceof JsonObject
        ? {
            sha256:
              typeof reference.get('sha256') === 'string'
                ? (reference.get('sha256') as string)
                : '',
            location:
              typeof reference.get('location') === 'string'
                ? (reference.get('location') as string)
                : '',
          }
        : { sha256: '', location: '' };
    await verify(record);
    const kind =
      reference instanceof JsonObject && typeof reference.get('kind') === 'string'
        ? (reference.get('kind') as string)
        : undefined;
    if (kind === 'git-bundle') {
      git(await runGit(['bundle', 'verify', record.location]));
      git(await runGit(['bundle', 'unbundle', record.location]));
    }
  }
}

/** Python's `Repository.entries`: `ls-tree -r -z` mapped path -> {mode, blob}. */
async function entries(
  runGit: RunGit,
  commit: string,
): Promise<Map<string, { mode: string; blob: string }>> {
  const out = git(await runGit(['ls-tree', '-r', '-z', commit]));
  const result = new Map<string, { mode: string; blob: string }>();
  for (const raw of decode(out).split('\0')) {
    if (raw === '') continue;
    const tab = raw.indexOf('\t');
    if (tab < 0) throw integrity('malformed ls-tree entry');
    const meta = raw.slice(0, tab).split(' ');
    const mode = meta[0] ?? '';
    const blob = meta[2] ?? '';
    let name = raw.slice(tab + 1);
    // Python's `ledger.path` normalizes and refuses non-canonical paths; a
    // path it refuses is recorded under its byte-hex form, matching Python's
    // `git-path-bytes:` fallback for undecodable names.
    try {
      name = ledgerPath(name);
    } catch {
      name = `git-path-bytes:${Buffer.from(name, 'utf8').toString('hex')}`;
    }
    result.set(name, { mode, blob });
  }
  return result;
}

/**
 * Python's `Repository.changed_intervals`: the head-side added-line intervals
 * per path, parsed from the pinned plain-diff form.
 */
export async function changedIntervals(
  runGit: RunGit,
  base: string,
  head: string,
): Promise<Map<string, Set<number>>> {
  const out = git(
    await runGit([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--no-renames',
      '--unified=0',
      base,
      head,
    ]),
  );
  const result = new Map<string, Set<number>>();
  let current: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of decode(out).split('\n')) {
    if (oldLeft !== 0 || newLeft !== 0) {
      if (line.startsWith(' ')) {
        oldLeft -= 1;
        newLeft -= 1;
      } else if (line.startsWith('-')) {
        oldLeft -= 1;
      } else if (line.startsWith('+')) {
        newLeft -= 1;
      } else if (line.startsWith('\\ No newline at end of file')) {
        continue;
      } else {
        throw integrity('malformed diff hunk');
      }
      if (oldLeft < 0 || newLeft < 0) throw integrity('malformed diff hunk length');
      continue;
    }
    if (line.startsWith('+++ b/')) {
      let name = line.slice(6);
      if (name.includes(' ') && name.endsWith('\t')) name = name.slice(0, -1);
      if (name.startsWith('"') || name.includes('\\')) {
        current = null; // quoted names use whole-file residual fallback
      } else {
        current = name;
        if (!result.has(current)) result.set(current, new Set());
      }
    } else if (line.startsWith('+++ ')) {
      current = null;
    } else if (line.startsWith('@@ ')) {
      const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw integrity('malformed diff hunk header');
      oldLeft = match[1] === undefined ? 1 : Number(match[1]);
      const start = Number(match[2]);
      newLeft = match[3] === undefined ? 1 : Number(match[3]);
      if (current !== null) {
        const set = result.get(current) ?? new Set<number>();
        for (let n = start; n < start + newLeft; n++) set.add(n);
        result.set(current, set);
      }
    }
  }
  if (oldLeft !== 0 || newLeft !== 0) throw integrity('truncated diff hunk');
  return result;
}

/**
 * Python's `Repository.verify_review`. Returns the credited map (path ->
 * verified line set) for a creditable record; a non-creditable record returns
 * an empty map after schema validation, exactly Python.
 */
export async function verifyReview(
  runGit: RunGit,
  value: JsonObject,
  verifyArtifact: (reference: { sha256: string; location: string }) => Promise<void>,
): Promise<Map<string, Set<number>>> {
  ledgerValidate(value);
  if (!ledgerCreditable(value)) return new Map();
  await restoreArtifacts(runGit, value, verifyArtifact);
  const payload = value.get('payload');
  if (!(payload instanceof JsonObject)) throw integrity('review payload is not an object');
  const target = payload.get('target');
  const head = payload.get('head');
  const base = payload.get('base');
  const targetTree = payload.get('target_tree');
  const headTree = payload.get('head_tree');
  for (const candidate of [target, head, base, targetTree, headTree]) {
    if (typeof candidate !== 'string') throw integrity('review commit fields are incomplete');
  }
  const resolve = async (commit: string): Promise<string> => {
    if (!OID_40_64.test(commit)) {
      throw integrity('target must be an immutable full object ID');
    }
    return decode(git(await runGit(['rev-parse', `${commit}^{commit}`]))).trim();
  };
  const tree = async (commit: string): Promise<string> => {
    const resolved = await resolve(commit);
    return decode(git(await runGit(['rev-parse', `${resolved}^{tree}`]))).trim();
  };
  if ((await tree(target as string)) !== targetTree || (await tree(head as string)) !== headTree) {
    throw integrity('review tree mismatch');
  }
  const [targetEntries, headEntries] = await Promise.all([
    entries(runGit, target as string),
    entries(runGit, head as string),
  ]);
  const changed = await changedIntervals(runGit, base as string, head as string);
  const reviewedScope = payload.get('reviewed_scope');
  if (reviewedScope === undefined) throw integrity('review payload has no reviewed_scope');
  const scope = ledgerScope(reviewedScope);
  const result: Map<string, Set<number>> = new Map();
  for (const [name, byBlob] of scope) {
    for (const [blob, lines] of byBlob) {
      const targetEntry = targetEntries.get(name);
      const headEntry = headEntries.get(name);
      if (
        targetEntry === undefined ||
        headEntry === undefined ||
        targetEntry.blob !== blob ||
        headEntry.blob !== blob
      ) {
        throw integrity('synthetic head/target blob mismatch');
      }
      if (targetEntry.mode !== '100644' && targetEntry.mode !== '100755') {
        throw integrity('reviewed non-regular object');
      }
      const blobData = git(await runGit(['cat-file', 'blob', blob]));
      const maximum = lineBytes(blobData);
      for (const n of lines) {
        if (n < 1 || n > maximum) throw integrity('credit outside head-side changed intervals');
      }
      const allowed = changed.get(name) ?? new Set<number>();
      for (const n of lines) {
        if (!allowed.has(n)) throw integrity('credit outside head-side changed intervals');
      }
      let merged = result.get(name);
      if (merged === undefined) {
        merged = new Set<number>();
        result.set(name, merged);
      }
      for (const n of lines) merged.add(n);
    }
  }
  return result;
}
