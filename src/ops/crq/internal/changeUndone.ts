/**
 * Position-keyed comparison of two zero-context diffs: the TypeScript twin of
 * `repair_tick.diff_changed_locations` and `repair_tick.change_undone`
 * (apps/crq-python/repair_tick.py). Containment must ask whether the head
 * diff undoes a published change AT THE SAME LOCATION; an identical line
 * elsewhere in the file is not an undo, so file-wide line text is never the key.
 *
 * Line numbers are `bigint` because Python integers are unbounded and a hunk
 * header can carry any run of Unicode decimal digits. Digit-run bounds follow
 * Python's `int()` string limit.
 */
import { decimalDigitValue } from '../../../policy/crq/prReviewFindings.js';
import { pythonSplitlines } from '../../../policy/crq/repairGates.js';

/** A Python `(int, str)` tuple, the element of every set in the Python twin. */
export type Located = readonly [bigint, string];

export interface ChangedLocations {
  /** (new_line, text) of each insertion. */
  readonly added: ReadonlyMap<string, Located>;
  /** (old_line, text) of each deletion. */
  readonly removed: ReadonlyMap<string, Located>;
  /** (old-side line preceding the insertion, text). */
  readonly addedGaps: ReadonlyMap<string, Located>;
  /** (new-side line preceding the deletion, text). */
  readonly removedGaps: ReadonlyMap<string, Located>;
  /** (old_start, old_count, insertion texts) of each hunk that also deletes. */
  readonly replaced: readonly (readonly [bigint, bigint, ReadonlySet<string>])[];
}

const hunkHeader = /^@@ -(\p{Nd}+)(?:,(\p{Nd}+))? \+(\p{Nd}+)(?:,(\p{Nd}+))? @@/u;
const maxIntDigits = 4300;

/** Python `int(digits)` for a non-empty run of Unicode decimal digits. */
function pythonInt(digits: string): bigint {
  const count = Array.from(digits).length;
  if (count > maxIntDigits)
    throw new Error(
      `Exceeds the limit (${maxIntDigits} digits) for integer string conversion: value has ${count} digits; ` +
        'use sys.set_int_max_str_digits() to increase the limit',
    );
  let value = 0n;
  for (const character of digits)
    value = value * 10n + BigInt(decimalDigitValue(character.codePointAt(0) as number));
  return value;
}

// JSON keeps the pair injective, including for lone-surrogate escapes in the text.
const key = (line: bigint, text: string): string => JSON.stringify([line.toString(), text]);

export function changedLocations(patch: string): ChangedLocations {
  const added = new Map<string, Located>();
  const removed = new Map<string, Located>();
  const addedGaps = new Map<string, Located>();
  const removedGaps = new Map<string, Located>();
  const replaced: [bigint, bigint, ReadonlySet<string>][] = [];
  let hunkAdds: string[] = [];
  let oldNo = 0n;
  let newNo = 0n;
  let oldAnchor = 0n;
  let newAnchor = 0n;
  let hunkStart = 0n;
  let hunkCount = 0n;
  let inHunk = false;
  const put = (target: Map<string, Located>, line: bigint, text: string): void => {
    target.set(key(line, text), [line, text]);
  };
  // Mirrors Python's closure, which reads the PREVIOUS hunk's start and count.
  const endHunk = (): void => {
    if (inHunk && hunkAdds.length && hunkCount)
      replaced.push([hunkStart, hunkCount, new Set(hunkAdds)]);
    hunkAdds = [];
  };
  for (const line of pythonSplitlines(patch)) {
    if (line.startsWith('diff --git ')) {
      endHunk();
      inHunk = false;
    } else if (line.startsWith('@@')) {
      endHunk();
      const match = hunkHeader.exec(line);
      inHunk = match !== null;
      if (!match) continue;
      const [, oldStart, oldCount, newStart, newCount] = match;
      // Python converts the two starts first, then the old count; the new count is only compared.
      oldNo = pythonInt(oldStart!);
      newNo = pythonInt(newStart!);
      hunkStart = oldNo;
      hunkCount = oldCount === undefined ? 1n : pythonInt(oldCount);
      // git names the preceding line for an empty side, else the first.
      oldAnchor = oldCount === '0' ? oldNo : oldNo - 1n;
      newAnchor = newCount === '0' ? newNo : newNo - 1n;
    } else if (inHunk && line.startsWith('+')) {
      const text = line.slice(1);
      put(added, newNo, text);
      put(addedGaps, oldAnchor, text);
      hunkAdds.push(text);
      newNo += 1n;
    } else if (inHunk && line.startsWith('-')) {
      const text = line.slice(1);
      put(removed, oldNo, text);
      put(removedGaps, newAnchor, text);
      oldNo += 1n;
    }
  }
  endHunk();
  return { added, removed, addedGaps, removedGaps, replaced };
}

/** Python's str ordering: by code point, not by UTF-16 unit. */
function compareText(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}

/**
 * Changes the head diff undoes at the same location in the published tree.
 *
 * The published diff maps parent->published and the head diff maps
 * published->head, so published new-line numbers and head old-line numbers
 * share one coordinate system. A head replacement hunk that starts before a
 * deletion gap gives the restored line the hunk's earlier gap anchor, so a hunk
 * whose replaced span covers the gap is also matched on its added texts.
 */
export function changeUndone(published: ChangedLocations, head: ChangedLocations): Located[] {
  const undone = new Map<string, Located>();
  for (const [id, entry] of published.added) if (head.removed.has(id)) undone.set(id, entry);
  for (const [id, entry] of published.removedGaps)
    if (head.addedGaps.has(id)) undone.set(id, entry);
  for (const [oldStart, oldCount, adds] of head.replaced)
    for (const [id, entry] of published.removedGaps)
      if (oldStart <= entry[0] && entry[0] < oldStart + oldCount && adds.has(entry[1]))
        undone.set(id, entry);
  return [...undone.values()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : compareText(a[1], b[1]),
  );
}
