import { describe, expect, it } from 'vitest';
import {
  FindingAnchorSchema,
  FindingEvidenceV1Schema,
  type FindingAnchor,
  type FindingEvidenceV1,
} from '../../../src/ops/review/findings.js';
import {
  validateFindingEvidence,
  type AnchorBlobInput,
  type AnchorValidationContext,
} from '../../../src/ops/review/internal/findingAnchors.js';

// A small reviewed comparison used as the pinned fixture throughout:
// one modified file, one renamed file, one added file, one deleted file and
// one dependency the change reads from but does not modify.
const MODIFIED = 'src/ops/review/modified.ts';
const OLD_NAME = 'src/ops/review/oldName.ts';
const NEW_NAME = 'src/ops/review/newName.ts';
const ADDED = 'src/ops/review/added.ts';
const DELETED = 'src/ops/review/deleted.ts';
const DEPENDENCY = 'src/ops/review/dependency.ts';

const modifiedBase = 'import { parse } from "./parser.js";\n\nexport const before = 1;\n';
const modifiedHead = 'import { parse } from "./parser.js";\n\nexport const after = 2;\n';
const renamedBase = 'export const moved = true;\n';
const renamedHead = 'export const moved = true;\nexport const movedExtra = 2;\n';
const addedHead = 'export const fresh = 3;\n';
const deletedText = 'export const gone = 4;\n';
const dependencyText = 'export const dep = 0;\nexport const dep2 = 1;\n';

// Path-specific pins: {file, side} is normative, so the base content of the
// renamed pair lives under the OLD path and the head content under the NEW
// path, each pin carrying only the sides that path actually has.
const blobs = new Map<string, AnchorBlobInput>([
  [
    MODIFIED,
    {
      base: modifiedBase,
      head: modifiedHead,
      baseHunks: [{ start: 3, end: 4 }],
      headHunks: [{ start: 3, end: 4 }],
    },
  ],
  [OLD_NAME, { base: renamedBase, head: undefined, baseHunks: [{ start: 1, end: 2 }], headHunks: [] }],
  [
    NEW_NAME,
    { base: undefined, head: renamedHead, baseHunks: [], headHunks: [{ start: 1, end: 3 }] },
  ],
  [ADDED, { base: undefined, head: addedHead, baseHunks: [], headHunks: [{ start: 1, end: 2 }] }],
  [
    DELETED,
    { base: deletedText, head: undefined, baseHunks: [{ start: 1, end: 2 }], headHunks: [] },
  ],
  [DEPENDENCY, { base: dependencyText, head: dependencyText, baseHunks: [], headHunks: [] }],
]);

const context: AnchorValidationContext = {
  blobs,
  renames: new Map([[OLD_NAME, NEW_NAME]]),
};

const anchor = (over: Partial<FindingAnchor> = {}): FindingAnchor => ({
  file: MODIFIED,
  side: 'head',
  start: 3,
  end: 3,
  quote: 'export const after = 2;',
  ...over,
});

const evidence = (over: Partial<FindingEvidenceV1> = {}): FindingEvidenceV1 => ({
  version: 1,
  failureScenario: 'the modified constant is exported with the wrong value',
  primary: anchor(),
  supporting: [],
  ...over,
});

const valid = (result: ReturnType<typeof validateFindingEvidence>): void => {
  expect(result).toEqual({ status: 'valid' });
};

const invalidReasons = (result: ReturnType<typeof validateFindingEvidence>): string[] => {
  expect(result.status).toBe('invalid');
  return result.status === 'invalid' ? result.reasons : [];
};

describe('R3S additive evidence schema', () => {
  it('accepts a well-formed payload and keeps the record envelope at schemaVersion 1', () => {
    expect(evidence()).toMatchObject({ version: 1 });
    expect(FindingEvidenceV1Schema.safeParse({ ...evidence(), extra: true }).success).toBe(false);
    expect(FindingAnchorSchema.safeParse({ ...anchor(), extra: true }).success).toBe(false);
  });

  it('does not require an evidence payload: legacy findings stay valid unchanged', () => {
    // A CodeRabbit-shaped finding has no evidenceV1 and must never be asked
    // to invent one; the payload is additive per the card. The envelope's
    // own schemaVersion stays 1, so no legacy record is invalidated.
    const legacy = {
      id: 'cr-1',
      source: 'coderabbit',
      severity: 'major',
      text: 'possible null dereference',
      status: 'open',
    } as const;
    expect('evidenceV1' in legacy).toBe(false);
  });

  it('rejects unknown keys, empty quotes and a six-item supporting list', () => {
    expect(FindingAnchorSchema.safeParse({ ...anchor(), quote: '' }).success).toBe(false);
    expect(
      FindingEvidenceV1Schema.safeParse(
        evidence({
          supporting: Array.from({ length: 6 }, () => ({
            ...anchor({ file: DEPENDENCY, quote: 'export const dep = 0;' }),
            relevance: 'calls the cited helper',
          })),
        }),
      ).success,
    ).toBe(false);
  });

  it('requires a non-empty failureScenario and keeps validation strictly additive', () => {
    expect(
      FindingEvidenceV1Schema.safeParse({ ...evidence(), failureScenario: '' }).success,
    ).toBe(false);
    const survivor: FindingEvidenceV1 = {
      ...evidence(),
      validation: { status: 'invalid', reasons: ['quote-mismatch'] },
    };
    expect(FindingEvidenceV1Schema.parse(survivor).validation).toEqual({
      status: 'invalid',
      reasons: ['quote-mismatch'],
    });
    expect(
      FindingEvidenceV1Schema.safeParse({
        ...evidence(),
        validation: { status: 'valid' },
      }).success,
    ).toBe(false);
  });
});

describe('R3S anchor validator: pinned quote integrity', () => {
  it('accepts a head-side anchor on a modified file inside the changed hunk', () => {
    valid(validateFindingEvidence(evidence(), context));
  });

  it('accepts a base-side anchor quoting deleted lines of a deleted file', () => {
    valid(
      validateFindingEvidence(
        evidence({
          primary: anchor({
            file: DELETED,
            side: 'base',
            start: 1,
            end: 1,
            quote: 'export const gone = 4;',
          }),
        }),
        context,
      ),
    );
  });

  it('accepts an anchor on a newly added file whose only content is the change', () => {
    valid(
      validateFindingEvidence(
        evidence({
          primary: anchor({
            file: ADDED,
            side: 'head',
            start: 1,
            end: 1,
            quote: 'export const fresh = 3;',
          }),
        }),
        context,
      ),
    );
  });

  it('accepts a multi-line exact supporting range and rejects an inexact quote', () => {
    // Supporting anchors may cite unchanged files, but the primary side of
    // this payload still anchors the change itself.
    valid(
      validateFindingEvidence(
        evidence({
          supporting: [
            {
              ...anchor({
                file: DEPENDENCY,
                start: 1,
                end: 2,
                quote: 'export const dep = 0;\nexport const dep2 = 1;',
              }),
              relevance: 'the modified module reads this constant',
            },
          ],
        }),
        context,
      ),
    );
    expect(
      invalidReasons(
        validateFindingEvidence(evidence({ primary: anchor({ quote: 'export const after=2;' }) }), context),
      ),
    ).toContain('quote-mismatch');
  });

  it('rejects a quote whose indentation differs from the pinned source', () => {
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({ primary: anchor({ quote: '  export const after = 2;' }) }),
          context,
        ),
      ),
    ).toContain('quote-mismatch');
  });

  it('rejects a wrong-side range: base side of an added file', () => {
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({
            primary: anchor({
              file: ADDED,
              side: 'base',
              start: 1,
              end: 1,
              quote: 'export const fresh = 3;',
            }),
          }),
          context,
        ),
      ),
    ).toEqual(['unknown-base-path']);
  });

  it('rejects a head-side range on a deleted path even with an identical quote on the base side', () => {
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({
            primary: anchor({
              file: DELETED,
              side: 'head',
              start: 1,
              end: 1,
              quote: 'export const gone = 4;',
            }),
          }),
          context,
        ),
      ),
    ).toEqual(['unknown-head-path']);
  });

  it('accepts an unchanged-path supporting anchor and rejects an unchanged-path primary as hunk-less', () => {
    // Control: DEPENDENCY is not part of the change. As supporting evidence
    // it validates (exact quote, no hunk requirement); as a primary anchor it
    // fails hunk checks, so a finding can never anchor its defect outside
    // the change.
    valid(
      validateFindingEvidence(
        evidence({
          supporting: [
            {
              ...anchor({ file: DEPENDENCY, start: 1, end: 1, quote: 'export const dep = 0;' }),
              relevance: 'unchanged dependency cited as context',
            },
          ],
        }),
        context,
      ),
    );
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({
            primary: anchor({ file: DEPENDENCY, start: 1, end: 1, quote: 'export const dep = 0;' }),
          }),
          context,
        ),
      ),
    ).toEqual(['no-hunk-information']);
  });

  it('rejects a range past the end of the pinned blob and an inverted range', () => {
    expect(
      invalidReasons(
        validateFindingEvidence(evidence({ primary: anchor({ start: 9, end: 9 }) }), context),
      ),
    ).toContain('out-of-range');
    expect(
      invalidReasons(
        validateFindingEvidence(evidence({ primary: anchor({ start: 3, end: 2 }) }), context),
      ),
    ).toContain('out-of-range');
  });

  it('rejects an anchor into an empty file', () => {
    const empty = new Map(context.blobs);
    empty.set(ADDED, {
      base: undefined,
      head: '',
      baseHunks: [],
      headHunks: [{ start: 1, end: 1 }],
    });
    const emptyContext: AnchorValidationContext = { blobs: empty, renames: context.renames };
    // The empty-file guard runs before range/quote checks: a 0-line blob has
    // no citable range at all, and the validator must not fabricate a match
    // against content that does not exist.
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({ primary: anchor({ file: ADDED, start: 1, end: 1, quote: 'anything' }) }),
          emptyContext,
        ),
      ),
    ).toEqual(['empty-file']);
  });
});

describe('R3S anchor validator: path, rename and deletion handling', () => {
  it('rejects an unknown path and a traversal-shaped path', () => {
    expect(
      invalidReasons(
        validateFindingEvidence(evidence({ primary: anchor({ file: '../outside/secrets.ts' }) }), context),
      ),
    ).toEqual(['unknown-path']);
  });

  it('rejects a path with a NUL byte as malformed before any blob lookup', () => {
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({ primary: anchor({ file: 'src/ops/review/\0hidden.ts' }) }),
          context,
        ),
      ),
    ).toEqual(['malformed-path']);
  });

  it('accepts a base-side anchor cited through the old rename name', () => {
    valid(
      validateFindingEvidence(
        evidence({
          primary: anchor({
            file: OLD_NAME,
            side: 'base',
            start: 1,
            end: 1,
            quote: 'export const moved = true;',
          }),
        }),
        context,
      ),
    );
  });

  it('resolves a NEW_NAME primary whose pin is registered only under the old spelling', () => {
    // Spelling repair: the map resolves NEW_NAME back to OLD_NAME's pin, but
    // the side checks still apply to the resolved pin.
    const unregisteredNew = new Map(context.blobs);
    unregisteredNew.delete(NEW_NAME);
    const unregisteredContext: AnchorValidationContext = {
      blobs: unregisteredNew,
      renames: context.renames,
    };
    valid(
      validateFindingEvidence(
        evidence({
          primary: anchor({
            file: NEW_NAME,
            side: 'base',
            start: 1,
            end: 1,
            quote: 'export const moved = true;',
          }),
        }),
        unregisteredContext,
      ),
    );
  });

  it('rejects a base-side anchor keyed by the new rename name: the side is absent there', () => {
    // Normative {file, side}: NEW_NAME's pin has no base tree. The quoted
    // bytes exist verbatim in the base of the OLD path, but the citation
    // names the wrong path for the chosen side and must reject; the rename
    // map repairs spelling, it never fabricates side existence.
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({
            primary: anchor({
              file: NEW_NAME,
              side: 'base',
              start: 1,
              end: 1,
              quote: 'export const moved = true;',
            }),
          }),
          context,
        ),
      ),
    ).toEqual(['unknown-base-path']);
  });

  it('rejects a head-side anchor keyed by the old rename name: the side is absent there', () => {
    // Mirror case: OLD_NAME's pin has no head tree. NEW_NAME holds the same
    // bytes on the head side, but {file: OLD_NAME, side: head} names the
    // wrong path for that tree.
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({
            primary: anchor({
              file: OLD_NAME,
              side: 'head',
              start: 2,
              end: 2,
              quote: 'export const movedExtra = 2;',
            }),
          }),
          context,
        ),
      ),
    ).toEqual(['unknown-head-path']);
  });
});

describe('R3S anchor validator: changed-hunk overlap', () => {
  it('rejects a primary anchor on a modified file outside every changed hunk', () => {
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({
            primary: anchor({ start: 1, end: 1, quote: 'import { parse } from "./parser.js";' }),
          }),
          context,
        ),
      ),
    ).toContain('outside-changed-hunks');
  });

  it('requires hunk information: a modified file with no hunks cannot prove a primary anchor', () => {
    const hunkless = new Map(context.blobs);
    hunkless.set(MODIFIED, { base: modifiedBase, head: modifiedHead, baseHunks: [], headHunks: [] });
    const hunklessContext: AnchorValidationContext = { blobs: hunkless, renames: context.renames };
    expect(invalidReasons(validateFindingEvidence(evidence(), hunklessContext))).toContain(
      'no-hunk-information',
    );
  });

  it('accepts a primary anchor partially overlapping a hunk and one spanning adjacent hunks', () => {
    const two = new Map(context.blobs);
    two.set(MODIFIED, {
      base: modifiedBase,
      head: modifiedHead,
      baseHunks: [{ start: 3, end: 4 }],
      headHunks: [
        { start: 2, end: 3 },
        { start: 3, end: 5 },
      ],
    });
    const twoContext: AnchorValidationContext = { blobs: two, renames: context.renames };
    valid(
      validateFindingEvidence(
        evidence({
          primary: anchor({
            start: 2,
            end: 4,
            // Line 2 of the fixture head is the blank line between the
            // import and the changed constant, so the quote starts with a
            // newline and spans lines 2..4 inclusive.
            quote: '\nexport const after = 2;\n',
          }),
        }),
        twoContext,
      ),
    );
  });

  it('accepts supporting evidence citing unchanged dependency code', () => {
    valid(
      validateFindingEvidence(
        evidence({
          supporting: [
            {
              ...anchor({
                file: DEPENDENCY,
                start: 1,
                end: 2,
                quote: 'export const dep = 0;\nexport const dep2 = 1;',
              }),
              relevance: 'the modified module reads this constant',
            },
          ],
        }),
        context,
      ),
    );
  });

  it('collapses duplicate supporting failure kinds but preserves every distinct typed reason verbatim', () => {
    // Two supporting anchors fail with the same out-of-range reason: the
    // typed reason stays (deduplicated), followed by the marker. The why is
    // never dropped in favor of the what.
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({
            supporting: [
              { ...anchor({ file: DEPENDENCY, start: 9, end: 9 }), relevance: 'out of range' },
              { ...anchor({ file: DEPENDENCY, start: 8, end: 9 }), relevance: 'also out of range' },
            ],
          }),
          context,
        ),
      ),
    ).toEqual(['out-of-range', 'supporting-evidence']);
  });

  it('keeps a distinct supporting reason kind next to its marker', () => {
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({
            supporting: [
              {
                ...anchor({ file: DEPENDENCY, start: 1, end: 1, quote: 'not the pinned line' }),
                relevance: 'wrong quote',
              },
            ],
          }),
          context,
        ),
      ),
    ).toEqual(['quote-mismatch', 'supporting-evidence']);
  });

  it('reports primary reasons first, then distinct supporting reasons, then the marker', () => {
    expect(
      invalidReasons(
        validateFindingEvidence(
          evidence({
            primary: anchor({ start: 9, end: 9 }),
            supporting: [
              { ...anchor({ file: DEPENDENCY, start: 9, end: 9 }), relevance: 'also wrong' },
            ],
          }),
          context,
        ),
      ),
    ).toEqual(['out-of-range', 'out-of-range', 'supporting-evidence']);
  });
});

describe('R3S anchor validator: survivor semantics', () => {
  it('ignores a persisted invalid marker: the verdict describes the anchors, not the marker', () => {
    const marked: FindingEvidenceV1 = {
      ...evidence(),
      validation: { status: 'invalid', reasons: ['quote-mismatch'] },
    };
    valid(validateFindingEvidence(marked, context));
  });

  it('re-invalidates a genuinely broken marked candidate with fresh reasons', () => {
    const marked: FindingEvidenceV1 = {
      ...evidence({ primary: anchor({ start: 9, end: 9 }) }),
      validation: { status: 'invalid', reasons: ['quote-mismatch'] },
    };
    expect(invalidReasons(validateFindingEvidence(marked, context))).toEqual(['out-of-range']);
  });
});
