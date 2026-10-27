// Pure anchor validation for the R3S additive evidence schema
// (`FindingEvidenceV1` in ../findings.ts). The caller supplies every pinned
// input: the exact base/head blob text for each path, the changed hunks per
// path per side and the rename map from the comparison the review ran
// against. This module performs no git, filesystem or network access, so a
// fixture test can exercise every outcome deterministically.
//
// Integrity, not truth: a passing anchor proves the quote exists verbatim at
// the cited lines of the cited side — and, for the primary anchor, that the
// range overlaps the comparison's changed hunk(s). It says nothing about
// whether the stated failureScenario is real; a human or blind semantic
// adjudicator still checks that (reviewer-lane.md, card R3S).

import type { FindingAnchor, FindingEvidenceV1 } from '../findings.js';

/** One changed hunk of one side: inclusive 1-based start, exclusive end. */
export interface AnchorHunk {
  start: number;
  end: number;
}

/** Exact caller-supplied pins for one path, both sides of the comparison. */
export interface AnchorBlobInput {
  /** `undefined` means the path does not exist on that side. */
  base: string | undefined;
  head: string | undefined;
  /** Changed hunk ranges on the base side (removed/kept line ranges). */
  baseHunks: readonly AnchorHunk[];
  /** Changed hunk ranges on the head side (added/kept line ranges). */
  headHunks: readonly AnchorHunk[];
}

/** The caller's view of one reviewed comparison. */
export interface AnchorValidationContext {
  /**
   * Blob pins keyed by path. `{file, side}` is normative: an anchor names the
   * exact path it cites in the chosen tree, so pin the base blob under the
   * path it belongs to and the head blob under its own. For a renamed pair
   * that is two registrations — base content under the old path, head
   * content under the new. The `renames` map never relocates evidence and
   * never fabricates side existence: it only repairs a path spelling, and a
   * side absent from the resolved pin still rejects (wrong-side anchors fail
   * even when the quoted bytes exist in the other tree).
   */
  blobs: ReadonlyMap<string, AnchorBlobInput>;
  /** `old -> new` pairs for every renamed path in the comparison. */
  renames: ReadonlyMap<string, string>;
}

export type AnchorInvalidReason =
  | 'malformed-path'
  | 'unknown-path'
  | 'unknown-base-path'
  | 'unknown-head-path'
  | 'empty-file'
  | 'out-of-range'
  | 'quote-mismatch'
  | 'outside-changed-hunks'
  | 'no-hunk-information'
  | 'supporting-evidence';

export type AnchorVerdict = { status: 'valid' } | { status: 'invalid'; reasons: AnchorInvalidReason[] };

/** `end` is exclusive, so an empty file has no valid line range at all. */
const lineCount = (text: string): number => text.split('\n').length;

/** NUL and newline bytes are git plumbing separators, never path text. */
const isMalformedPath = (path: string): boolean => path.includes('\0') || path.includes('\n');

/** The new name citing the old spelling, when the map pins that direction. */
const reverseRename = (
  renames: ReadonlyMap<string, string>,
  newPath: string,
): string | undefined => {
  for (const [oldPath, target] of renames) if (target === newPath) return oldPath;
  return undefined;
};

function validateAnchor(
  anchor: FindingAnchor,
  context: AnchorValidationContext,
  requireHunkOverlap: boolean,
): AnchorInvalidReason[] {
  if (isMalformedPath(anchor.file)) return ['malformed-path'];
  let file = anchor.file;
  let blob = context.blobs.get(file);
  if (blob === undefined) {
    // The path itself is unknown to the comparison. A rename pair may be
    // cited under either spelling: resolve to the other name. This repairs
    // spelling only — it never moves evidence between paths and the side
    // checks below still apply to the resolved pin.
    const other = context.renames.get(file) ?? reverseRename(context.renames, file);
    if (other === undefined) return ['unknown-path'];
    blob = context.blobs.get(other);
    if (blob === undefined) return ['unknown-path'];
    file = other;
  }
  // {file, side} is normative: the resolved pin must actually contain the
  // cited side. A base-side anchor on a renamed-away or newly added path
  // names a path the base tree never had, and a head-side anchor on a
  // deleted path names a path the head tree no longer has; both reject even
  // when the same bytes exist on the opposite side.
  if (anchor.side === 'base' && blob.base === undefined) return ['unknown-base-path'];
  if (anchor.side === 'head' && blob.head === undefined) return ['unknown-head-path'];
  const text = anchor.side === 'base' ? blob.base : blob.head;
  if (text === '') return ['empty-file'];
  // Inclusive 1-based range must fit the pinned blob; `start > end` fails too.
  if (anchor.start > anchor.end || anchor.end > lineCount(text)) return ['out-of-range'];
  const expected = text.split('\n').slice(anchor.start - 1, anchor.end).join('\n');
  if (expected !== anchor.quote) return ['quote-mismatch'];
  if (requireHunkOverlap) {
    const hunks = anchor.side === 'base' ? blob.baseHunks : blob.headHunks;
    if (hunks.length === 0) return ['no-hunk-information'];
    const overlaps = hunks.some((hunk) => anchor.start < hunk.end && hunk.start <= anchor.end);
    if (!overlaps) return ['outside-changed-hunks'];
  }
  return [];
}

/**
 * Validate one additive evidence payload against the pinned comparison. The
 * primary anchor must be a real, quoted, changed-hunk-overlapping range; each
 * supporting anchor must be a real quoted range but may cite unchanged
 * dependency code (that is what supporting evidence is for). Failure reasons
 * are never silently dropped: every typed primary reason is kept, and each
 * distinct supporting-anchor failure reason is also preserved verbatim after
 * the primary reasons, followed by the `supporting-evidence` marker so
 * callers can see which half failed without losing the why. A persisted
 * `validation: { status: 'invalid' }` marker on the input records a previous
 * engine outcome and never influences this verdict: re-running the validator
 * over a marked candidate still reports what its anchors prove today, so a
 * surviving candidate is never invalidated by its own history.
 */
export function validateFindingEvidence(
  evidence: FindingEvidenceV1,
  context: AnchorValidationContext,
): AnchorVerdict {
  const primary = validateAnchor(evidence.primary, context, true);
  const supporting: AnchorInvalidReason[] = [];
  for (const item of evidence.supporting) {
    for (const reason of validateAnchor(item, context, false))
      if (!supporting.includes(reason)) supporting.push(reason);
  }
  if (primary.length === 0 && supporting.length === 0) return { status: 'valid' };
  return {
    status: 'invalid',
    reasons: [
      ...primary,
      ...supporting,
      ...(supporting.length > 0 ? ['supporting-evidence' as const] : []),
    ],
  };
}
