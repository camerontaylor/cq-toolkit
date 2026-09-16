// Analyze lane G2 — the codemod path: ast-grep as the ADOPTED ENGINE for
// mechanical remediation, driven exactly the way the gates family drives
// eslint/vitest/tsc (src/ops/gates): the toolkit ships NO rules and takes
// NO ast-grep dependency — the rule is CONSUMER CONFIG passed through the
// op input verbatim, the library takes an INJECTED runner
// ({@link makeAstGrepCodemod} over the gates' RunCheck seam), and the
// importer binds the default subprocess runner. A missing ast-grep binary
// surfaces as an honest `failed` op result naming the unobservable exit —
// never a fabricated empty match set.
//
// Invariants honored here:
//   - The toolkit keeps control of EVERY write: the scan reads ast-grep's
//     JSON output into PLANNED EDITS and the apply rewrites files through
//     the injected AnalyzeFileStore — deliberately NOT ast-grep's own
//     `--update-all` (or `-u`), so no fix lands on disk that the collision
//     check, the dry-run boundary, and the approval gate have not seen.
//   - Wire honesty: the invocation is the documented surface
//     (`ast-grep scan --json=compact --inline-rules <rule> -- <paths>`,
//     per the ast-grep CLI reference) and the parser accepts only the
//     documented match shape, strictly where it matters: `file`,
//     `replacement`, and `replacementOffsets` (BYTE offsets into the file,
//     inclusive start / exclusive end, zero-based — the ast-grep Edit
//     range) are validated; everything else (ruleId, severity,
//     metaVariables) is the consumer rule's business and ignored. A match
//     without a `replacement` (the rule carries no `fix`) is counted as an
//     unfixed match — visible, never silently dropped and never turned
//     into a fake edit.
//   - Collision safety: two planned edits whose byte ranges overlap in one
//     file mean the consumer rule is ambiguous about those bytes — the
//     WHOLE apply is blocked (`failed` naming both ranges). Blocked edits
//     are never silently dropped and never partially applied.
//   - Dry-run writes NOTHING: the diff path reads current bytes and renders
//     unified diffs; the write seam is not touched.
//   - Approval gate: the apply mode REQUIRES `approved: true` in the input —
//     without it the op refuses with `needs-human` before any I/O. The
//     dry-run mode writes nothing and needs no approval. SCOPE OF THE GATE,
//     stated precisely: this op is the RULE-SCOPED ENGINE PRIMITIVE, gated by
//     `approved: true` alone (it carries no cluster id — it has no sidecar
//     and no cluster). The cluster-scoped, sidecar-contracted remediation
//     path is `analyze.applyRemediation`, the ONLY surface satisfying the UC
//     row-9 shape { clusterId, approved: true }; that op (and the playbooks
//     that own their codemods) drive this engine underneath. The plan
//     runner's autonomous path (G3) can never rewrite a file through either
//     surface.
//   - Determinism: edits are applied per file in ascending byte order,
//     files in ascending path order; the diff renderer is a pure function
//     of (old bytes, edits). The same plan against the same bytes always
//     produces the same hunks.
//
// Residual limitations, documented: the planned-edit range is the ast-grep
// fix's byte span — a fix is exact-replacement of the matched span, so
// rules whose fixes rely on `--update-all`'s multi-file pass semantics are
// out of scope by construction; the digest recorded after an apply is the
// same coarse 32-bit staleness digest as the sidecar's (see
// renderAnalysisReport.ts); and the unified diff is synthesized from the
// edit spans (no general LCS) — hunks are exact at the edit sites with
// three lines of context, which is precisely the assurance a dry-run needs.
import { resolve } from 'node:path';
import type { Op } from '../../../kernel/types.js';
import type { RawCheckOutput, RunCheck } from '../../gates/checkRunner.js';
import type { AnalyzeFileStore } from '../analysisStore.js';
import { contentDigest } from '../renderAnalysisReport.js';

/**
 * One planned edit parsed from ast-grep's JSON output. `startByte`/`endByte`
 * are BYTE offsets into the file (inclusive start, exclusive end — the
 * ast-grep Edit range, zero-based); `replacement` is the rule fix's text
 * that will replace that byte range.
 */
export interface PlannedEdit {
  file: string;
  startByte: number;
  endByte: number;
  replacement: string;
}

/** What a scan produced: planned edits, plus the matches that carried no fix. */
export interface ScanOutcome {
  plannedEdits: PlannedEdit[];
  /** Matches whose rule carried no `fix` — honest count, never fake edits. */
  unfixedMatches: number;
}

/** The scan request the injected runner executes inside `dir`. */
export interface AstGrepScanRequest {
  dir: string;
  /** The consumer's ast-grep rule text (YAML — JSON is a valid YAML form), passed verbatim. */
  rule: string;
  /** The files to scan (paths inside dir; the scan is never left unscoped). */
  files: readonly string[];
  timeoutMs?: number;
}

/** Discriminated scan result: the op boundary maps `fault` to `failed`. */
export type AstGrepScanResult = { ok: true; outcome: ScanOutcome } | { ok: false; fault: string };

/**
 * Parse ast-grep's `--json=compact` stdout (a JSON array of match objects;
 * `[]` when nothing matched) into planned edits. Lenient about fields this
 * lane does not consume, strict about the three it does — a match with a
 * `replacement` but missing/invalid `replacementOffsets` is a PARSE FAULT
 * (an edit without a range cannot be planned honestly), never a guessed
 * edit.
 */
export function parseAstGrepJson(stdout: string): AstGrepScanResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, fault: 'ast-grep codemod: output is not valid JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, fault: 'ast-grep codemod: expected a JSON array of matches' };
  }
  const plannedEdits: PlannedEdit[] = [];
  let unfixedMatches = 0;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, fault: 'ast-grep codemod: match entry is not an object' };
    }
    const match = entry as Record<string, unknown>;
    if (typeof match.file !== 'string' || match.file === '') {
      return { ok: false, fault: 'ast-grep codemod: match entry without a file path' };
    }
    if (match.replacement === undefined) {
      unfixedMatches += 1;
      continue;
    }
    if (typeof match.replacement !== 'string') {
      return {
        ok: false,
        fault: `ast-grep codemod: match for '${match.file}' has a non-string replacement`,
      };
    }
    const offsets = match.replacementOffsets as Record<string, unknown> | undefined;
    if (
      offsets === null ||
      typeof offsets !== 'object' ||
      typeof offsets.start !== 'number' ||
      typeof offsets.end !== 'number' ||
      !Number.isInteger(offsets.start) ||
      !Number.isInteger(offsets.end) ||
      offsets.start < 0 ||
      offsets.end < offsets.start
    ) {
      return {
        ok: false,
        fault: `ast-grep codemod: match for '${match.file}' has a replacement without valid byte offsets (replacementOffsets)`,
      };
    }
    plannedEdits.push({
      file: match.file,
      startByte: offsets.start,
      endByte: offsets.end,
      replacement: match.replacement,
    });
  }
  return { ok: true, outcome: { plannedEdits, unfixedMatches } };
}

/**
 * Run one scan through the injected runner. The command is the documented
 * ast-grep surface: `scan --json=compact --inline-rules <rule> -- <files>`,
 * cwd = dir, so the reported file paths are dir-relative and re-resolve
 * through the store's containment. Verdict policy, in decision order: an
 * UNOBSERVABLE exit (null — timeout kill, signal, spawn failure, output
 * overflow) is a fault BEFORE parse acceptance, even when the captured
 * stdout prefix parses — a killed scan's partial JSON is an incomplete plan,
 * and partial evidence is never passing evidence (I9). Behind a NUMERIC
 * exit, parsable JSON output with EMPTY stderr is a completed scan — the
 * legit error-severity-matched path keeps stderr empty — while ANY stderr
 * line is a fault naming it, because `scan` still exits 0 when a REQUESTED
 * file errors (missing/unreadable) and simply omits it from the matches:
 * a plan silently missing a requested target is never accepted. Unparsable
 * output (crash text, truncation) is likewise a fault naming the exit, so a
 * missing binary is an honest `failed`, never an empty match set.
 */
export function makeAstGrepScan(
  run: RunCheck,
): (request: AstGrepScanRequest) => Promise<AstGrepScanResult> {
  return async (request) => {
    let raw: RawCheckOutput;
    try {
      raw = await run({
        command: 'ast-grep',
        args: ['scan', '--json=compact', '--inline-rules', request.rule, '--', ...request.files],
        cwd: request.dir,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      });
    } catch (err) {
      return {
        ok: false,
        fault: `ast-grep codemod: the runner crashed before a scan could complete — ${messageOf(err)}`,
      };
    }
    if (raw.exitCode === null) {
      // BEFORE parse acceptance: a scan killed by timeout/signal/overflow can
      // still leave a parseable JSON PREFIX in stdout — accepting it would
      // apply edits from an incomplete plan (or read a truncated `[]` as a
      // false clean no-op). Unobservable exit → honest `failed`, always.
      const stderrExcerpt = raw.stderr.trim().slice(0, 200);
      return {
        ok: false,
        fault: `ast-grep codemod: the scan's exit code was unobservable (timeout kill, signal, or output overflow) — the captured output may be an INCOMPLETE plan and is never accepted; re-run the scan${stderrExcerpt === '' ? '' : `; stderr: ${stderrExcerpt}`}`,
      };
    }
    // STILL before parse acceptance (exit-0 partial results): scan exits 0
    // even when a REQUESTED file could not be read, reporting it only on
    // stderr (`ERROR: <file>: No such file…`) and silently omitting it from
    // the matches — a plan that silently misses a requested target is never
    // accepted. The severity-matched path keeps stderr empty (verified
    // against ast-grep 0.45.3), so this never breaks that contract.
    if (raw.stderr.trim() !== '') {
      const stderrExcerpt = raw.stderr.trim().slice(0, 200);
      return {
        ok: false,
        fault: `ast-grep codemod: the scan reported errors on stderr (exit code ${raw.exitCode}) — a requested file may be missing or unreadable and silently absent from the plan; re-run with the file present; stderr: ${stderrExcerpt}`,
      };
    }
    const result = parseAstGrepJson(raw.stdout);
    if (!result.ok) {
      const stderrExcerpt = raw.stderr.trim().slice(0, 200);
      return {
        ok: false,
        fault: `ast-grep codemod: ${result.fault} — exit code ${raw.exitCode}${stderrExcerpt === '' ? '' : `; stderr: ${stderrExcerpt}`}`,
      };
    }
    // FILE-MATCH CANONICALIZATION (both sides, before any filtering or
    // grouping): ast-grep reports the walked path, which may carry a leading
    // `./` (or be absolute) for a target the caller requested in plain
    // relative form. Left alone, the decorated form would silently drop the
    // edit in every per-file filter while plannedEdits still counted it
    // (and could hide a collision across the two spellings). Each reported
    // path is matched back to the REQUESTED spelling — verbatim, `./`-
    // stripped, or resolved against the scan cwd — and rewritten to it; a
    // reported path outside the requested set is a fault, never an edit.
    const canonical: PlannedEdit[] = [];
    for (const edit of result.outcome.plannedEdits) {
      const requested = request.files.find(
        (file) =>
          file === edit.file ||
          stripDotSlash(file) === stripDotSlash(edit.file) ||
          resolve(request.dir, file) === resolve(request.dir, edit.file),
      );
      if (requested === undefined) {
        return {
          ok: false,
          fault: `ast-grep codemod: scan reported a match outside the requested file set: '${edit.file}'`,
        };
      }
      canonical.push({ ...edit, file: requested });
    }
    return {
      ok: true,
      outcome: { plannedEdits: canonical, unfixedMatches: result.outcome.unfixedMatches },
    };
  };
}

/**
 * The collision check: sort per file by start byte (ascending), then any
 * next range starting before the previous one ends is an overlap. Returns
 * the blocking fault message, or null when every file's plan is disjoint.
 */
export function findCollision(edits: readonly PlannedEdit[]): string | null {
  const byFile = new Map<string, PlannedEdit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.file);
    if (list === undefined) byFile.set(edit.file, [edit]);
    else list.push(edit);
  }
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1] as PlannedEdit;
      const curr = list[i] as PlannedEdit;
      if (curr.startByte < prev.endByte) {
        return `collision: overlapping planned edits in '${file}' ([${prev.startByte}, ${prev.endByte}) and [${curr.startByte}, ${curr.endByte})) — the whole apply is blocked; narrow or split the rule`;
      }
    }
  }
  return null;
}

/**
 * Combine a file's non-overlapping edits into the new bytes: splices in
 * ascending byte order over the original. Throws when a range is out of
 * bounds for the current content (the sidecar's staleness digest bounds
 * this already; this is the belt to those braces).
 */
export function applyEditsToBytes(content: Uint8Array, edits: readonly PlannedEdit[]): Uint8Array {
  const sorted = [...edits].sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.startByte < cursor || edit.endByte < edit.startByte || edit.endByte > content.length) {
      throw new RangeError(
        `planned edit [${edit.startByte}, ${edit.endByte}) is out of bounds for the current content (${content.length} bytes)`,
      );
    }
    parts.push(content.subarray(cursor, edit.startByte), Buffer.from(edit.replacement, 'utf8'));
    cursor = edit.endByte;
  }
  parts.push(content.subarray(cursor));
  return Buffer.concat(parts);
}

/** One rendered diff line: its unified marker, text (no newline), and whether the source line ended with one. */
interface DiffLine {
  marker: ' ' | '-' | '+';
  text: string;
  endsWithNewline: boolean;
}

/** Split text into lines, keeping whether each ended with a newline (the last one may not). */
function splitLines(text: string): Array<{ text: string; endsWithNewline: boolean }> {
  const lines: Array<{ text: string; endsWithNewline: boolean }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push({ text: text.slice(start, i), endsWithNewline: true });
      start = i + 1;
    }
  }
  if (start < text.length) lines.push({ text: text.slice(start), endsWithNewline: false });
  return lines;
}

/**
 * The unified-diff segmentation of one file: the old text's LINES walk in
 * order, and each changed BLOCK of lines (the union of the edited lines'
 * spans, merged when they touch) contributes one del group (the block's old
 * lines) followed by one add group (the block's new lines — the old block
 * bytes with the edits spliced in). Blocks are built at FULL-LINE
 * granularity because a fix replaces a BYTE span that usually sits MID-LINE
 * — rendering the replacement text as its own line would drop the rest of
 * the line; the block splice keeps every line whole and exact.
 */
function diffSegments(currentBytes: Uint8Array, edits: readonly PlannedEdit[]): DiffLine[] {
  const current = Buffer.from(currentBytes).toString('utf8');
  const oldLines = splitLines(current);
  // Byte offset of each line's start (and the total length as the sentinel end).
  const lineStarts: number[] = [0];
  for (const line of oldLines) {
    lineStarts.push(
      (lineStarts[lineStarts.length - 1] as number) +
        Buffer.byteLength(line.text, 'utf8') +
        (line.endsWithNewline ? 1 : 0),
    );
  }
  /** The index of the line containing byte `b` (a byte at a line start is that line; EOF is the last line). */
  const lineIndexFor = (b: number): number => {
    let index = 0;
    for (let i = 0; i < lineStarts.length - 1; i++) {
      if ((lineStarts[i] as number) <= b) index = i;
    }
    return index;
  };
  // Map each edit to the block of lines its span touches.
  const sorted = [...edits].sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
  const blocks: Array<{ startLine: number; endLine: number; edits: PlannedEdit[] }> = [];
  for (const edit of sorted) {
    let startLine: number;
    let endLine: number;
    if (edit.endByte > edit.startByte) {
      startLine = lineIndexFor(edit.startByte);
      endLine = lineIndexFor(edit.endByte - 1) + 1;
    } else {
      // A zero-length edit (a pure insertion) touches the line it sits on
      // when it is strictly MID-LINE; at a line boundary it is a zero-width
      // block between lines (documented residual: ast-grep fixes always
      // replace a non-empty match span, so this is the defensive branch).
      const line = lineIndexFor(edit.startByte);
      const lineStart = lineStarts[line] as number;
      const nextStart = lineStarts[line + 1] as number;
      const lineHasNewline = oldLines[line]?.endsWithNewline === true;
      const lineEnd = nextStart - (lineHasNewline ? 1 : 0);
      const midLine =
        edit.startByte > lineStart && edit.startByte < nextStart && edit.startByte < lineEnd;
      const totalBytes = lineStarts[oldLines.length] as number;
      if (!midLine && edit.startByte >= totalBytes && oldLines.length > 0) {
        // EOF INSERTION CLAMP: a zero-width block AT end-of-file has no byte
        // range to splice into (its relative offsets fall out of bounds), so
        // clamp it to cover the LAST line ([lastLineStart, fileEnd]) — the
        // insertion point is that line's end, the block splice appends there,
        // and the diff shows the last line rewritten with the inserted text.
        startLine = oldLines.length - 1;
        endLine = oldLines.length;
      } else {
        startLine = line;
        endLine = midLine ? line + 1 : line;
      }
    }
    const last = blocks[blocks.length - 1];
    if (last !== undefined && startLine <= last.endLine) {
      last.endLine = Math.max(last.endLine, endLine);
      last.edits.push(edit);
    } else {
      blocks.push({ startLine, endLine, edits: [edit] });
    }
  }
  const segments: DiffLine[] = [];
  let oldLine = 0;
  for (const block of blocks) {
    while (oldLine < block.startLine && oldLine < oldLines.length) {
      segments.push({
        marker: ' ',
        ...(oldLines[oldLine] as { text: string; endsWithNewline: boolean }),
      });
      oldLine += 1;
    }
    const delEnd = Math.min(block.endLine, oldLines.length);
    while (oldLine < delEnd) {
      segments.push({
        marker: '-',
        ...(oldLines[oldLine] as { text: string; endsWithNewline: boolean }),
      });
      oldLine += 1;
    }
    // The block's new bytes: splice the block's edits into the block's
    // byte range (line start of blockStartLine .. end of line delEnd-1).
    const blockStart = lineStarts[block.startLine] as number;
    const lastLine = oldLines[delEnd - 1];
    const blockEnd =
      lastLine === undefined
        ? blockStart
        : (lineStarts[delEnd - 1] as number) +
          Buffer.byteLength(lastLine.text, 'utf8') +
          (lastLine.endsWithNewline ? 1 : 0);
    const blockBytes = currentBytes.subarray(blockStart, blockEnd);
    // The edits carry ABSOLUTE byte offsets; the block splice needs them
    // relative to the block's own bytes.
    const blockEdits = block.edits.map((edit) => ({
      ...edit,
      startByte: edit.startByte - blockStart,
      endByte: edit.endByte - blockStart,
    }));
    const newText = Buffer.from(applyEditsToBytes(blockBytes, blockEdits)).toString('utf8');
    for (const line of splitLines(newText)) {
      segments.push({ marker: '+', ...line });
    }
  }
  while (oldLine < oldLines.length) {
    segments.push({
      marker: ' ',
      ...(oldLines[oldLine] as { text: string; endsWithNewline: boolean }),
    });
    oldLine += 1;
  }
  return segments;
}

/** Unified-diff context width — the conventional three lines. */
const DIFF_CONTEXT = 3;

/**
 * Render the unified diff of ONE file between its current bytes and the
 * bytes after applying the (already collision-checked, non-overlapping)
 * edits: full-line del/add blocks at the edit sites (see
 * {@link diffSegments}), three context lines around changes, merged into
 * one hunk when blocks sit closer than twice the context. Returns '' when
 * the plan changes nothing.
 */
export function renderUnifiedDiff(
  file: string,
  currentBytes: Uint8Array,
  edits: readonly PlannedEdit[],
): string {
  const current = Buffer.from(currentBytes).toString('utf8');
  // Only THIS file's edits participate: callers may pass a whole plan.
  const fileEdits = edits.filter((edit) => edit.file === file);
  const after = Buffer.from(applyEditsToBytes(currentBytes, fileEdits)).toString('utf8');
  if (current === after) return '';
  const segments = diffSegments(currentBytes, fileEdits);
  // Annotate each segment with its old/new file line numbers (1-based) for
  // the hunk headers, walking once in segment order.
  let oldNo = 1;
  let newNo = 1;
  const numbered = segments.map((segment) => {
    const entry = { ...segment, oldNo, newNo };
    if (segment.marker === ' ') {
      oldNo += 1;
      newNo += 1;
    } else if (segment.marker === '-') {
      oldNo += 1;
    } else {
      newNo += 1;
    }
    return entry;
  });
  // Hunk boundaries: change segments closer than 2·context share a hunk.
  const changeIdx = numbered.map((s, i) => (s.marker === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return '';
  const hunks: Array<[number, number]> = [];
  let start = Math.max(0, (changeIdx[0] as number) - DIFF_CONTEXT);
  let end = changeIdx[0] as number;
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k] as number;
    if (idx - end <= DIFF_CONTEXT * 2) {
      end = idx;
    } else {
      hunks.push([start, Math.min(numbered.length - 1, end + DIFF_CONTEXT)]);
      start = Math.max(0, idx - DIFF_CONTEXT);
      end = idx;
    }
  }
  hunks.push([start, Math.min(numbered.length - 1, end + DIFF_CONTEXT)]);
  let out = `--- ${file}\n+++ ${file}\n`;
  for (const [hunkStart, hunkEnd] of hunks) {
    const slice = numbered.slice(hunkStart, hunkEnd + 1);
    const oldCount = slice.filter((s) => s.marker !== '+').length;
    const newCount = slice.filter((s) => s.marker !== '-').length;
    // Unified convention: a zero-count side positions at the line BEFORE
    // the hunk (the insertion/deletion point).
    const oldHeader = (slice[0] as (typeof slice)[number]).oldNo - (oldCount === 0 ? 1 : 0);
    const newHeader = (slice[0] as (typeof slice)[number]).newNo - (newCount === 0 ? 1 : 0);
    out += `@@ -${oldHeader},${oldCount} +${newHeader},${newCount} @@\n`;
    for (const line of slice) {
      out += `${line.marker}${line.text}\n`;
      if (!line.endsWithNewline) out += '\\ No newline at end of file\n';
    }
  }
  return out;
}

/** JSON-serializable input of the `analyze.astGrepCodemod` op. */
export interface AstGrepCodemodInput {
  /** The directory that scopes the rewrite: every file resolves inside it, nothing escapes. */
  dir: string;
  /** The consumer's ast-grep rule text, passed verbatim to `--inline-rules`. */
  rule: string;
  /** The files to scan (at least one — an unscoped scan is exactly the blast radius the gates protect against). */
  files: string[];
  /** When true: render diffs, write nothing. When false: REQUIRES `approved: true`. */
  dryRun: boolean;
  /**
   * Explicit human approval for the apply mode; anything but true refuses
   * the apply. This op is the RULE-SCOPED ENGINE PRIMITIVE, so `approved`
   * alone is its whole gate (it has no cluster id to name — no sidecar, no
   * cluster); the UC row-9 shape { clusterId, approved: true } is satisfied
   * by `analyze.applyRemediation`, the cluster-scoped path that drives this
   * engine underneath.
   */
  approved?: boolean;
  /** Wall-clock cap for the scan subprocess; the registry boundary defaults it to 600_000ms. */
  timeoutMs?: number;
}

/** Per-file report rows: dry-run rows carry the diff; applied rows also carry the after-digest. */
export interface CodemodFileDiff {
  file: string;
  edits: number;
  diff: string;
}

export interface CodemodFileApplied extends CodemodFileDiff {
  /** Coarse staleness digest of the file content AFTER the write. */
  digestAfter: string;
}

/** The op's report — `mode` says which. */
export type CodemodReport =
  | {
      mode: 'dry-run';
      plannedEdits: number;
      unfixedMatches: number;
      files: CodemodFileDiff[];
      /** Present exactly when nothing matched — the honest empty result, never a silent success. */
      note?: string;
    }
  | {
      mode: 'applied';
      plannedEdits: number;
      unfixedMatches: number;
      files: CodemodFileApplied[];
      note?: string;
    };

/**
 * Build the `analyze.astGrepCodemod` op over the injected runner and store
 * selector. Order of operations, each fail-closed: (1) the approval gate —
 * an apply without `approved: true` is `needs-human` BEFORE any I/O; (2)
 * the scan — a runner or parse fault is `failed`; (3) the collision check —
 * any overlap blocks the whole apply; (4) dry-run renders diffs and writes
 * nothing, apply splices and writes per file in deterministic order. An
 * empty planned-edit set is an HONEST ok: `plannedEdits: 0` plus a `note`
 * saying nothing matched — "nothing matched" is a real outcome, not a
 * success story to hide behind.
 */
export function makeAstGrepCodemod(
  run: RunCheck,
  storeFor: (input: AstGrepCodemodInput) => AnalyzeFileStore,
): Op<AstGrepCodemodInput, CodemodReport> {
  return async (input) => {
    // The approval gate is FIRST — before the store resolves, before any
    // byte moves. Missing approval is exactly a missing human decision.
    if (!input.dryRun && input.approved !== true) {
      return {
        status: 'needs-human',
        reason:
          'codemod apply requires an explicit approval flag — remediation is never auto-applied; pass { approved: true } (or dryRun: true to preview the diffs)',
      };
    }
    // The 'at least one file' rule is enforced HERE too, not only at the
    // registry boundary: a direct library/barrel call with files: [] must
    // not degrade into an unscoped scan over the whole directory.
    if (input.files.length === 0) {
      return {
        status: 'failed',
        error: 'ast-grep codemod: an unscoped scan is refused; pass at least one file',
      };
    }
    let store: AnalyzeFileStore;
    try {
      store = storeFor(input);
    } catch (err) {
      return { status: 'failed', error: messageOf(err) };
    }
    // Read the current bytes of every target up front: containment faults
    // and missing files surface HERE, before the subprocess runs, and the
    // diff/apply share one read (a file read once is the file written back).
    const files = [...new Set(input.files)].sort();
    const current = new Map<string, Uint8Array>();
    for (const file of files) {
      try {
        current.set(file, await store.readBytes(file));
      } catch (err) {
        return {
          status: 'failed',
          error: `ast-grep codemod: could not read target — ${messageOf(err)}`,
        };
      }
    }
    // OFFSET-FRESHNESS ANCHOR: ast-grep re-reads the files at SCAN time while
    // the plan's byte offsets were computed against THIS read — drift in
    // between would splice a stale plan silently. Digest now, re-verify
    // after the scan and BEFORE anything is written (dry-run included: a
    // diff of drifted bytes would mislead the same way). Residual, one
    // sentence: a concurrent write landing between this final freshness read
    // and store.writeBytes is still a lost update — a documented TOCTOU-class
    // residual of the same accepted window the analysis store's header
    // records for a single-consumer local tool.
    const digestBeforeScan = new Map(
      files.map((file) => [
        file,
        contentDigest(Buffer.from(current.get(file) as Uint8Array).toString('utf8')),
      ]),
    );
    const scan = await makeAstGrepScan(run)({
      dir: input.dir,
      rule: input.rule,
      files,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    if (!scan.ok) return { status: 'failed', error: scan.fault };
    const collision = findCollision(scan.outcome.plannedEdits);
    if (collision !== null) return { status: 'failed', error: collision };
    for (const file of files) {
      let fresh: Uint8Array;
      try {
        fresh = await store.readBytes(file);
      } catch (err) {
        return {
          status: 'failed',
          error: `ast-grep codemod: file changed during remediation planning — '${file}' is no longer readable after the scan; nothing was written; re-run (${messageOf(err)})`,
        };
      }
      const freshDigest = contentDigest(Buffer.from(fresh).toString('utf8'));
      if (freshDigest !== digestBeforeScan.get(file)) {
        return {
          status: 'failed',
          error: `ast-grep codemod: file changed during remediation planning: '${file}' (digest before scan ${digestBeforeScan.get(file)}, after ${freshDigest}) — the scan re-reads at scan time, so the planned offsets may be stale; nothing was written; re-run`,
        };
      }
      current.set(file, fresh);
    }
    const plannedEdits = scan.outcome.plannedEdits;
    const note =
      plannedEdits.length === 0
        ? 'no planned edits — nothing matched (or the rule carries no fix); nothing was written'
        : undefined;
    if (input.dryRun) {
      let diffFiles: CodemodFileDiff[];
      try {
        diffFiles = files.map((file) => ({
          file,
          edits: plannedEdits.filter((edit) => edit.file === file).length,
          diff: renderUnifiedDiff(file, current.get(file) as Uint8Array, plannedEdits),
        }));
      } catch (err) {
        return {
          status: 'failed',
          error: `ast-grep codemod: could not render the plan — ${messageOf(err)}`,
        };
      }
      return {
        status: 'ok',
        value: {
          mode: 'dry-run',
          plannedEdits: plannedEdits.length,
          unfixedMatches: scan.outcome.unfixedMatches,
          files: diffFiles,
          ...(note === undefined ? {} : { note }),
        },
      };
    }
    const appliedFiles: CodemodFileApplied[] = [];
    for (const file of files) {
      const edits = plannedEdits.filter((edit) => edit.file === file);
      if (edits.length === 0) continue; // nothing to rewrite — the file is not part of the applied set
      const before = current.get(file) as Uint8Array;
      let after: Uint8Array;
      let diff: string;
      try {
        after = applyEditsToBytes(before, edits);
        diff = renderUnifiedDiff(file, before, edits);
      } catch (err) {
        return {
          status: 'failed',
          error: `ast-grep codemod: could not apply the plan to '${file}' — ${messageOf(err)}`,
        };
      }
      try {
        await store.writeBytes(file, after);
      } catch (err) {
        // BEST-EFFORT ROLLBACK (mirrors applyRemediation's): partial
        // multi-file apply is never stranded. The faulted file itself may
        // hold a PARTIAL write (writeFileSync is not atomic) and every
        // already-written file's ORIGINAL bytes are still in `current`
        // (freshness-verified pre-scan), so both are restored newest-first
        // through the same store before faulting. When a rollback restore
        // faults, the stranded naming survives and the restore failure is
        // named — the caller always knows the exact on-disk state.
        const rolledBack: string[] = [];
        const rollbackFaults: string[] = [];
        let faultedFileRestoreFailed = '';
        try {
          await store.writeBytes(file, current.get(file) as Uint8Array);
        } catch (restoreErr) {
          faultedFileRestoreFailed = `; the faulted file's partial-write restore failed: ${messageOf(restoreErr)}`;
        }
        for (const applied of [...appliedFiles].reverse()) {
          try {
            await store.writeBytes(applied.file, current.get(applied.file) as Uint8Array);
            rolledBack.push(applied.file);
          } catch (rollbackErr) {
            rollbackFaults.push(`${applied.file} (${messageOf(rollbackErr)})`);
          }
        }
        if (rollbackFaults.length === 0) {
          const rolledBackNote =
            rolledBack.length === 0
              ? 'no earlier files to roll back'
              : `rolled back ${rolledBack.join(', ')} (original bytes restored)`;
          return {
            status: 'failed',
            error: `ast-grep codemod: could not write '${file}' — ${messageOf(err)}; ${rolledBackNote}${faultedFileRestoreFailed}`,
          };
        }
        const restored = rolledBack.length === 0 ? 'none' : rolledBack.join(', ');
        const stranded = appliedFiles.map((applied) => applied.file);
        return {
          status: 'failed',
          error: `ast-grep codemod: could not write '${file}' — ${messageOf(err)}; rollback FAILED for ${rollbackFaults.join(', ')}; restored: ${restored}; already written (stranded): ${stranded.join(', ')}${faultedFileRestoreFailed}`,
        };
      }
      appliedFiles.push({
        file,
        edits: edits.length,
        diff,
        digestAfter: contentDigest(Buffer.from(after).toString('utf8')),
      });
    }
    return {
      status: 'ok',
      value: {
        mode: 'applied',
        plannedEdits: plannedEdits.length,
        unfixedMatches: scan.outcome.unfixedMatches,
        files: appliedFiles,
        ...(note === undefined ? {} : { note }),
      },
    };
  };
}

// No default export here, deliberately: like the ledger family's make*
// ops, the registry importer COMPOSES this op from the named factory plus
// the dynamically-imported subprocess runner and path store (the gates
// runner seam + the registry-bound store seam).

/**
 * The `./` decoration stripped — one half of the file-match canonicalization
 * in {@link makeAstGrepScan} (the other half resolves both sides against the
 * scan cwd, which also folds absolute reported paths into the comparison).
 */
function stripDotSlash(file: string): string {
  return file.startsWith('./') ? file.slice(2) : file;
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
