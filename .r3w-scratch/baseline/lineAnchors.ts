// Head-file line anchors for diff text. A model reading raw hunks has to count
// lines to cite a head line, and it guesses; the anchors list the head line of
// every added line and the nearest surviving head line of every removed run,
// so findings can quote a number instead of deriving one. The original diff
// bytes stay untouched elsewhere in the prompt (delivery evidence is exact).
const EXCERPT_CHARS = 48;
const MAX_ANCHOR_CHARS = 6_000;

export const ANCHOR_INSTRUCTION =
  'Head line anchors list the head-file line number of each added line and, for removed code, the nearest surviving head line. Cite these numbers as finding lines; anchor a finding about deleted code to the nearest surviving head line. A removal without a surviving head-line anchor supplies no citable head line.';

export interface HunkPosition {
  oldLine: number | undefined;
  newLine: number | undefined;
  previousHeadLine?: number | undefined;
  oldRemaining?: number | undefined;
  newRemaining?: number | undefined;
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
  let { oldLine, newLine, oldRemaining, newRemaining } = start;
  let previousHeadLine =
    start.previousHeadLine ?? (newLine !== undefined && newLine > 1 ? newLine - 1 : undefined);
  const rows: string[] = [];
  let removed: { count: number; first: string } | undefined;
  const flush = (nextHeadLine?: number) => {
    if (removed === undefined) return;
    const where =
      nextHeadLine !== undefined
        ? `before L${nextHeadLine}`
        : previousHeadLine !== undefined
          ? `after L${previousHeadLine}`
          : 'without a surviving head-line anchor';
    rows.push(
      `removed ${where} (${removed.count} line${removed.count === 1 ? '' : 's'}): ${excerpt(removed.first)}`,
    );
    removed = undefined;
  };
  const reset = () => {
    flush();
    oldLine = undefined;
    newLine = undefined;
    oldRemaining = undefined;
    newRemaining = undefined;
    previousHeadLine = undefined;
  };
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('diff --git ')) {
      reset();
      continue;
    }
    const marker = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (marker) {
      reset();
      oldLine = Number(marker[1]);
      newLine = Number(marker[3]);
      oldRemaining = Number(marker[2] ?? 1);
      newRemaining = Number(marker[4] ?? 1);
      // A zero-length head range names the line BEFORE the deletion, not a
      // following line. +0,0 represents an empty head and has no line anchor.
      const preceding = newRemaining === 0 ? newLine : newLine - 1;
      previousHeadLine = preceding > 0 ? preceding : undefined;
      continue;
    }
    if (oldLine === undefined || newLine === undefined) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;
    const removedLine = line.startsWith('-');
    const addedLine = line.startsWith('+');
    const contextLine = line.startsWith(' ') || (line === '' && index < lines.length - 1);
    const consumesOld = removedLine || contextLine;
    const consumesNew = addedLine || contextLine;
    if (
      (!consumesOld && !consumesNew) ||
      (consumesOld && oldRemaining === 0) ||
      (consumesNew && newRemaining === 0)
    ) {
      reset();
      continue;
    }
    if (removedLine) {
      removed ??= { count: 0, first: line.slice(1) };
      removed.count++;
    } else {
      flush(newLine);
      previousHeadLine = newLine;
      if (addedLine) rows.push(`L${newLine} + ${excerpt(line.slice(1))}`);
    }
    if (consumesOld) {
      oldLine++;
      if (oldRemaining !== undefined) oldRemaining--;
    }
    if (consumesNew) {
      newLine++;
      if (newRemaining !== undefined) newRemaining--;
    }
    if (oldRemaining === 0 && newRemaining === 0) reset();
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
