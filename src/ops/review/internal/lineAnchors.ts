// Head-file line anchors for diff text. A model reading raw hunks has to count
// lines to cite a head line, and it guesses; the anchors list the head line of
// every added line and the nearest surviving head line of every removed run,
// so findings can quote a number instead of deriving one. The original diff
// bytes stay untouched elsewhere in the prompt (delivery evidence is exact).
const EXCERPT_CHARS = 48;
const MAX_ANCHOR_CHARS = 6_000;

export const ANCHOR_INSTRUCTION =
  'Head line anchors list the head-file line number of each added line and, for removed code, the nearest surviving head line. Cite these numbers as finding lines; anchor a finding about deleted code to the nearest surviving head line.';

export interface HunkPosition {
  oldLine: number | undefined;
  newLine: number | undefined;
}

const excerpt = (text: string): string => {
  const flat = text.trim().replace(/\s+/g, ' ');
  const cut = Array.from(flat).slice(0, EXCERPT_CHARS).join('');
  return cut.length < flat.length ? `${cut}…` : cut;
};

/**
 * Anchors for one diff slice, starting at `start` (the position at the slice's
 * first line; omit when the slice begins before any hunk header). Returns ''
 * when the slice has no added or removed lines inside a hunk.
 */
export function headLineAnchors(
  text: string,
  start: HunkPosition = { oldLine: undefined, newLine: undefined },
): string {
  let { oldLine, newLine } = start;
  const rows: string[] = [];
  let removed: { before: number; count: number; first: string } | undefined;
  const flush = () => {
    if (removed === undefined) return;
    rows.push(
      `removed before L${removed.before} (${removed.count} line${removed.count === 1 ? '' : 's'}): ${excerpt(removed.first)}`,
    );
    removed = undefined;
  };
  for (const line of text.split('\n')) {
    const marker = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (marker) {
      flush();
      oldLine = Number(marker[1]);
      newLine = Number(marker[2]);
      continue;
    }
    if (oldLine === undefined || newLine === undefined) continue;
    if (line.startsWith('-')) {
      removed ??= { before: newLine, count: 0, first: line.slice(1) };
      removed.count++;
      oldLine++;
    } else if (line.startsWith('+')) {
      flush();
      rows.push(`L${newLine} + ${excerpt(line.slice(1))}`);
      newLine++;
    } else if (line.startsWith(' ')) {
      flush();
      oldLine++;
      newLine++;
    } else flush();
  }
  flush();
  if (rows.length === 0) return '';
  let out = '';
  for (const row of rows) {
    if (out.length + row.length + 1 > MAX_ANCHOR_CHARS) return `${out}(further anchors omitted)\n`;
    out += `${row}\n`;
  }
  return out;
}
