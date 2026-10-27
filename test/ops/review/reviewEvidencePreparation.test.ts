import { describe, expect, it } from 'vitest';
import type { FindingAnchor, FindingEvidenceV1 } from '../../../src/ops/review/findings.js';
import {
  MAX_EVIDENCE_REPAIRS,
  prepareFindingEvidence,
  type AnchorBlobInput,
  type AnchorValidationContext,
  type EvidencePreparationStep,
} from '../../../src/ops/review/internal/reviewEvidencePreparation.js';

// The R3S anchor-test comparison, reused so preparation outcomes are directly
// comparable with the validator fixtures: one modified file, one renamed pair,
// one added file, one deleted file, one unchanged dependency and one file
// whose pin has no content on either side (unavailable blob).
const MODIFIED = 'src/ops/review/modified.ts';
const OLD_NAME = 'src/ops/review/oldName.ts';
const NEW_NAME = 'src/ops/review/newName.ts';
const ADDED = 'src/ops/review/added.ts';
const DELETED = 'src/ops/review/deleted.ts';
const DEPENDENCY = 'src/ops/review/dependency.ts';
const UNAVAILABLE = 'src/ops/review/unavailable.ts';

const modifiedBase = 'import { parse } from "./parser.js";\n\nexport const before = 1;\n';
const modifiedHead = 'import { parse } from "./parser.js";\n\nexport const after = 2;\n';
const renamedBase = 'export const moved = true;\n';
const renamedHead = 'export const moved = true;\nexport const movedExtra = 2;\n';
const addedHead = 'export const fresh = 3;\n';
const deletedText = 'export const gone = 4;\n';
const dependencyText = 'export const dep = 0;\nexport const dep2 = 1;\n';

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
  [
    OLD_NAME,
    { base: renamedBase, head: undefined, baseHunks: [{ start: 1, end: 2 }], headHunks: [] },
  ],
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
  // A pin exists but no side has content: the blob is unavailable.
  [UNAVAILABLE, { base: undefined, head: undefined, baseHunks: [], headHunks: [] }],
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

const dependencySupport = () => ({
  ...anchor({
    file: DEPENDENCY,
    start: 1,
    end: 1,
    quote: 'export const dep = 0;',
  }),
  relevance: 'the cited dependency reads the constant',
});

const isInvalid = (
  step: EvidencePreparationStep,
): step is Extract<EvidencePreparationStep, { status: 'invalid' }> => step.status === 'invalid';

const invalid = (
  step: EvidencePreparationStep,
): Extract<EvidencePreparationStep, { status: 'invalid' }> => {
  expect(step.status).toBe('invalid');
  if (!isInvalid(step)) throw new Error('unreachable');
  return step;
};

const valid = (
  step: EvidencePreparationStep,
): Extract<EvidencePreparationStep, { status: 'valid' }> => {
  expect(step.status).toBe('valid');
  if (step.status !== 'valid') throw new Error('unreachable');
  return step;
};

describe('R3W evidence preparation', () => {
  it('keeps the card bound: MAX_EVIDENCE_REPAIRS is two', () => {
    expect(MAX_EVIDENCE_REPAIRS).toBe(2);
  });

  it('accepts a valid original verbatim with no repair history', () => {
    const candidate = evidence();
    const step = valid(prepareFindingEvidence({ candidate, context }));
    expect(step.evidence).toBe(candidate);
    expect(step.candidates).toHaveLength(1);
    expect(step.candidates[0]?.evidence).toBe(candidate);
    expect(step.candidates[0]?.reasons).toEqual([]);
    expect(step.repairs).toEqual([]);
  });

  it('stops at the first valid repair and stores it verbatim with its trigger', () => {
    const original = evidence({ primary: anchor({ quote: 'wrong bytes' }) });
    const repair = evidence({ failureScenario: 're-anchored after rereading the hunk' });
    const step = valid(
      prepareFindingEvidence({ candidate: original, context, repairs: [repair] }),
    );
    expect(step.evidence).toBe(repair);
    expect(step.candidates.map((row) => row.evidence)).toEqual([original, repair]);
    expect(step.repairs).toEqual([
      { requestedAfter: ['quote-mismatch'], evidence: repair, reasons: [] },
    ]);
  });

  it('prefers an earlier valid repair over a later one and evaluates nothing after it', () => {
    const original = evidence({ primary: anchor({ quote: 'wrong bytes' }) });
    const first = evidence({ failureScenario: 'first repair, valid' });
    const second = evidence({ failureScenario: 'second repair, never evaluated' });
    const step = valid(
      prepareFindingEvidence({ candidate: original, context, repairs: [first, second] }),
    );
    expect(step.evidence).toBe(first);
    expect(step.candidates).toHaveLength(2);
  });

  it('retains every raw candidate and full history when repairs stay invalid', () => {
    const original = evidence({ primary: anchor({ start: 99, end: 99 }) });
    const firstRepair = evidence({
      primary: anchor({
        file: NEW_NAME,
        side: 'base',
        start: 1,
        end: 1,
        quote: 'export const moved = true;',
      }),
    });
    const secondRepair = evidence({ primary: anchor({ side: 'base' }) });
    const step = invalid(
      prepareFindingEvidence({
        candidate: original,
        context,
        repairs: [firstRepair, secondRepair],
      }),
    );
    expect(step.candidates.map((row) => row.evidence)).toEqual([
      original,
      firstRepair,
      secondRepair,
    ]);
    expect(step.candidates[0]?.reasons).toEqual(['out-of-range']);
    expect(step.candidates[1]?.reasons).toEqual([]);
    expect(step.candidates[2]?.reasons).toEqual(['unknown-base-path']);
    expect(step.repairs[0]?.requestedAfter).toEqual(['out-of-range']);
    expect(step.repairs[1]?.requestedAfter).toEqual([]);
    expect(step.reasons).toEqual(['unknown-base-path']);
    expect(step.repairOutcome).toBe('exhausted');
    expect(step.ignoredRepairSubmissions).toBe(0);
  });

  it('counts but never evaluates submissions beyond the cap', () => {
    const original = evidence({ primary: anchor({ start: 99, end: 99 }) });
    const extra = evidence({ failureScenario: 'beyond the bound' });
    const step = invalid(
      prepareFindingEvidence({
        candidate: original,
        context,
        repairs: [original, original, extra],
      }),
    );
    expect(step.candidates).toHaveLength(3);
    expect(step.candidates.some((row) => row.evidence === extra)).toBe(false);
    expect(step.ignoredRepairSubmissions).toBe(1);
    expect(step.repairOutcome).toBe('exhausted');
  });

  it('reports unused repair capacity when none is offered or the cap is zero', () => {
    const broken = evidence({ primary: anchor({ quote: 'nope' }) });
    const noOffer = invalid(prepareFindingEvidence({ candidate: broken, context }));
    expect(noOffer.repairOutcome).toBe('unused');
    expect(noOffer.ignoredRepairSubmissions).toBe(0);
    expect(noOffer.repairs).toEqual([]);
    const capped = invalid(
      prepareFindingEvidence({
        candidate: broken,
        context,
        repairs: [evidence()],
        maxRepairs: 0,
      }),
    );
    expect(capped.repairOutcome).toBe('unused');
    expect(capped.ignoredRepairSubmissions).toBe(1);
    expect(capped.candidates).toHaveLength(1);
  });

  it('refuses a repair allowance above the card maximum', () => {
    expect(() =>
      prepareFindingEvidence({
        candidate: evidence(),
        context,
        maxRepairs: 3,
      }),
    ).toThrow('maxRepairs must be an integer between 0 and 2');
  });

  it('never relocates a repeated quote: a repair must cite its own occurrence', () => {
    // dependency.ts line 1 is a quote that also appears (verbatim) as a
    // substring elsewhere; a payload citing it at the wrong file or line stays
    // invalid with the same typed reasons no matter how often it is repaired.
    const repeated = evidence({
      primary: anchor({ file: DEPENDENCY, start: 2, end: 2, quote: 'export const dep = 0;' }),
    });
    const step = invalid(
      prepareFindingEvidence({ candidate: repeated, context, repairs: [repeated, repeated] }),
    );
    for (const row of step.candidates) expect(row.reasons).toEqual(['quote-mismatch']);
  });

  it('keeps a pre-persisted invalid marker inert: the verdict describes anchors', () => {
    const marked = evidence({
      validation: { status: 'invalid', reasons: ['quote-mismatch'] },
    });
    const stillValid = valid(prepareFindingEvidence({ candidate: marked, context }));
    expect(stillValid.evidence).toBe(marked);
    const brokenMarked = evidence({
      primary: anchor({ start: 99, end: 99 }),
      validation: { status: 'invalid', reasons: ['quote-mismatch'] },
    });
    const step = invalid(prepareFindingEvidence({ candidate: brokenMarked, context }));
    expect(step.candidates[0]?.evidence).toBe(brokenMarked);
    expect(step.candidates[0]?.evidence.validation).toEqual({
      status: 'invalid',
      reasons: ['quote-mismatch'],
    });
    expect(step.reasons).toEqual(['out-of-range']);
  });
});

describe('R3W preparation across comparison shapes', () => {
  const cases: {
    name: string;
    candidate: FindingEvidenceV1;
    reasons: string[];
  }[] = [
    {
      name: 'rename pair: head anchor on the new path validates',
      candidate: evidence({
        primary: anchor({
          file: NEW_NAME,
          start: 1,
          end: 1,
          quote: 'export const moved = true;',
        }),
      }),
      reasons: [],
    },
    {
      name: 'rename pair: base anchor on the old path validates',
      candidate: evidence({
        primary: anchor({
          file: OLD_NAME,
          side: 'base',
          start: 1,
          end: 1,
          quote: 'export const moved = true;',
        }),
      }),
      reasons: [],
    },
    {
      name: 'rename pair: cross-side anchor is rejected without relocation',
      candidate: evidence({
        primary: anchor({
          file: NEW_NAME,
          side: 'base',
          start: 1,
          end: 1,
          quote: 'export const moved = true;',
        }),
      }),
      reasons: ['unknown-base-path'],
    },
    {
      name: 'wrong side: head anchor on the deleted path',
      candidate: evidence({ primary: anchor({ file: DELETED, side: 'head' }) }),
      reasons: ['unknown-head-path'],
    },
    {
      name: 'out-of-hunk anchor on unchanged dependency lines',
      candidate: evidence({
        primary: anchor({ file: DEPENDENCY, start: 1, end: 1, quote: 'export const dep = 0;' }),
      }),
      reasons: ['no-hunk-information'],
    },
    {
      name: 'unavailable blob pin with no side content',
      candidate: evidence({ primary: anchor({ file: UNAVAILABLE }) }),
      reasons: ['unknown-head-path'],
    },
    {
      name: 'unknown path is never resolved through the rename map',
      candidate: evidence({ primary: anchor({ file: 'src/ops/review/typo.ts' }) }),
      reasons: ['unknown-path'],
    },
    {
      name: 'malicious path bytes are malformed, not unknown',
      candidate: evidence({ primary: anchor({ file: 'bad\0path' }) }),
      reasons: ['malformed-path'],
    },
    {
      name: 'newline in a path is malformed',
      candidate: evidence({ primary: anchor({ file: 'bad\npath' }) }),
      reasons: ['malformed-path'],
    },
    {
      name: 'added file: empty-side anchor is rejected for the missing side only',
      candidate: evidence({ primary: anchor({ file: ADDED, side: 'base' }) }),
      reasons: ['unknown-base-path'],
    },
    {
      name: 'source whitespace: quote must match the pinned bytes exactly',
      candidate: evidence({ primary: anchor({ quote: 'export const after = 2; ' }) }),
      reasons: ['quote-mismatch'],
    },
    {
      name: 'supporting evidence failure keeps its marker after primary success',
      candidate: evidence({
        supporting: [{ ...anchor({ start: 99, end: 99 }), relevance: 'out of range' }],
      }),
      reasons: ['out-of-range', 'supporting-evidence'],
    },
  ];
  for (const { name, candidate, reasons } of cases) {
    it(`${name}`, () => {
      const step = prepareFindingEvidence({ candidate, context });
      if (reasons.length === 0) {
        expect(step.status).toBe('valid');
        return;
      }
      expect(invalid(step).reasons).toEqual(reasons);
      expect(step.candidates[0]?.evidence).toBe(candidate);
    });
  }

  it('supporting evidence may cite unchanged dependency code when the quote is real', () => {
    const step = valid(
      prepareFindingEvidence({
        candidate: evidence({ supporting: [dependencySupport()] }),
        context,
      }),
    );
    expect(step.evidence.supporting).toHaveLength(1);
  });
});
