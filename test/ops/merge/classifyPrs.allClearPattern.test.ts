// Split provenance: test/ops/merge/classifyPrs.test.ts was split by subject into
// classifyPrs.{rows,temporal,all-clear,allClearPattern,acceptance,config,objections}.test.ts
// plus classifyPrs.helpers.ts (shared fixtures). This file carries the shipped
// allClearPattern data pins.
import { describe, expect, test } from 'vitest';
import { defaultClassifyPrConfig } from '../../../src/ops/merge/classify.config.js';

// ---------------------------------------------------------------------------
// The shipped allClearPattern — line-start anchored, negation-proof
// ---------------------------------------------------------------------------

describe('defaultClassifyPrConfig.allClearPattern — shipped data', () => {
  test.each([
    // Negation pins (round 1).
    {
      name: 'a line-leading "Not LGTM" is killed by the not-lookahead',
      body: 'Not LGTM — the retry loop is broken',
      matches: false,
    },
    {
      name: 'a mid-sentence "not all clear yet" cannot match (line-start anchor)',
      body: 'This is not all clear yet',
      matches: false,
    },
    {
      name: 'a line-leading "not lgtm-worthy" is killed by the not-lookahead',
      body: 'not lgtm-worthy',
      matches: false,
    },
    // Caveat-continuation NOs — round 2 extends end-of-line to ALL alternatives.
    {
      name: '"lgtm but fix the retry loop first" does not match (caveat continues the line)',
      body: 'lgtm but fix the retry loop first',
      matches: false,
    },
    {
      name: '"all clear, but the retry loop is still broken" does not match (caveat)',
      body: 'all clear, but the retry loop is still broken',
      matches: false,
    },
    {
      name: '"no further issues, but the tests are red" does not match (caveat)',
      body: 'no further issues, but the tests are red',
      matches: false,
    },
    {
      name: '"looks good, but fix the retry loop first" does not match (kept from round 1)',
      body: 'looks good, but fix the retry loop first',
      matches: false,
    },
    // Decided (round 2): ANY continuation — even a courteous coda — is a
    // continuation; strict end-of-line fails toward awaiting.
    {
      name: '"LGTM — ship it" does not match (a coda is a continuation)',
      body: 'LGTM — ship it',
      matches: false,
    },
    {
      name: '"all clear, thanks" does not match (a courteous coda is a continuation too)',
      body: 'all clear, thanks',
      matches: false,
    },
    // Round 3: the anchors bind the WHOLE body (no multiline flag) — a
    // caveat on the NEXT line cannot resurrect a match.
    {
      name: '"LGTM\\nbut fix the retry loop first" does not match (split-line caveat)',
      body: 'LGTM\nbut fix the retry loop first',
      matches: false,
    },
    {
      name: '"all clear\\nbut the tests are red" does not match (split-line caveat)',
      body: 'all clear\nbut the tests are red',
      matches: false,
    },
    {
      name: 'leading blank lines are admitted (^\\s* spans newlines)',
      body: '\n\nlgtm',
      matches: true,
    },
    // Bare forms and the single allowed trailing punctuation.
    {
      name: 'a bare "lgtm" matches',
      body: 'lgtm',
      matches: true,
    },
    {
      name: 'a bare "no further issues" matches',
      body: 'no further issues',
      matches: true,
    },
    {
      name: 'a bare "all clear," matches (one trailing comma is the allowed modulo)',
      body: 'all clear,',
      matches: true,
    },
    {
      name: 'a bare "all clear" matches',
      body: 'all clear',
      matches: true,
    },
    {
      name: 'a bare "looks good" ending its line matches',
      body: 'looks good',
      matches: true,
    },
  ])('$name', ({ body, matches }) => {
    expect(defaultClassifyPrConfig.allClearPattern.test(body)).toBe(matches);
  });
});
