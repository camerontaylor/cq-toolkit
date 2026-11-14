/** Python 3.14.4 Unicode 16.0.0 character predicates. Generated offline by
 * scripts/generate-crq-unicode16.py, which emits the two varint streams below.
 * These tables do not implement a regex matcher or activate review scanning. */
const wordData =
  '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';
const spaceData = 'CQQOBGQAGgDfKwD/EgodAQUALwCgHwA=';

function decode(encoded: string): readonly number[] {
  const bytes = Buffer.from(encoded, 'base64');
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const byte of bytes) {
    value += (byte & 127) * 2 ** shift;
    if (byte & 128) shift += 7;
    else {
      values.push(value);
      value = 0;
      shift = 0;
    }
  }
  if (shift || values.length % 2) throw new Error('invalid Unicode table');
  const ranges: number[] = [];
  let previous = -1;
  for (let i = 0; i < values.length; i += 2) {
    const start = previous + 1 + (values[i] ?? 0);
    const end = start + (values[i + 1] ?? 0);
    if (start <= previous || end > 0x10ffff) throw new Error('invalid Unicode range');
    ranges.push(start, end);
    previous = end;
  }
  return ranges;
}
const word = decode(wordData);
const space = decode(spaceData);
/** Inclusive start/end pairs, copied so callers cannot mutate the tables. */
export function pythonUnicode16WordRanges(): readonly number[] {
  return word.slice();
}
/** Inclusive start/end pairs, copied so callers cannot mutate the tables. */
export function pythonUnicode16SpaceRanges(): readonly number[] {
  return space.slice();
}
function contains(ranges: readonly number[], code: number): boolean {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return false;
  let low = 0;
  let high = ranges.length / 2;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const start = ranges[mid * 2] ?? 0;
    const end = ranges[mid * 2 + 1] ?? 0;
    if (code < start) high = mid;
    else if (code > end) low = mid + 1;
    else return true;
  }
  return false;
}
/** Python Unicode regex \\w: str.isalnum() or underscore. */
export function pythonUnicode16Word(code: number): boolean {
  return contains(word, code);
}
/** Python Unicode regex \\s: str.isspace(). */
export function pythonUnicode16Space(code: number): boolean {
  return contains(space, code);
}
