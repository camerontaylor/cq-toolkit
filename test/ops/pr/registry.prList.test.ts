// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the `gh pr list` surface (parsePrList, selectPrMatch, parseCreatedPr).
import { describe, expect, test } from 'vitest';
import type { PrSearchResult, PrState } from '../../../src/ops/pr/assemblePrs.js';
import {
  parseCreatedPr,
  parsePrList,
  selectPrMatch,
} from '../../../src/adapters/forge-github/ghEffects.js';

// ---------------------------------------------------------------------------
// The real gh adapter's pure parsers — captured-shape fixtures
// ---------------------------------------------------------------------------

describe('parsePrList (gh pr list --json number,url,state,isCrossRepository)', () => {
  test('an empty fleet has no PR on the head', () => {
    expect(parsePrList('[]')).toEqual([]);
  });

  test('rows keep the number, the URL, the lifecycle state, and the fork flag (r1#7 + final jNTyU)', () => {
    expect(
      parsePrList(
        '[{"number":7,"url":"https://github.test/owner/repo/pull/7","state":"OPEN"},{"number":8,"state":"MERGED"},{"number":9,"state":"CLOSED"},{"number":10},{"number":11,"isCrossRepository":true}]',
      ),
    ).toEqual([
      {
        number: 7,
        url: 'https://github.test/owner/repo/pull/7',
        state: 'open',
        isCrossRepository: false,
      },
      { number: 8, state: 'merged', isCrossRepository: false },
      { number: 9, state: 'closed', isCrossRepository: false },
      { number: 10, state: 'unknown', isCrossRepository: false },
      { number: 11, state: 'unknown', isCrossRepository: true },
    ]);
  });

  test('a non-array payload and an out-of-contract number are untrustworthy (thrown, r2#5)', () => {
    expect(() => parsePrList('{"number":7}')).toThrow(/non-array payload/);
    expect(() => parsePrList('[{"url":"https://github.test/owner/repo/pull/7"}]')).toThrow(
      /positive-integer number/,
    );
    // A PR number is 1, 2, 3… — zero, negatives, and floats are all noise.
    expect(() => parsePrList('[{"number":0}]')).toThrow(/positive-integer number/);
    expect(() => parsePrList('[{"number":-3}]')).toThrow(/positive-integer number/);
    expect(() => parsePrList('[{"number":2.5}]')).toThrow(/positive-integer number/);
  });

  test('non-JSON output is a fault, never a guess', () => {
    expect(() => parsePrList('gh: (GitHub) API rate limit exceeded')).toThrow(/non-JSON output/);
  });
});

describe('selectPrMatch (the deterministic adoption pick, r1#4/I11 + final jNTyU)', () => {
  const row = (number: number, state: PrState, isCrossRepository = false): PrSearchResult => ({
    number,
    state,
    isCrossRepository,
  });

  test('no matches → null', () => {
    expect(selectPrMatch([])).toBeNull();
  });

  test('a single match passes through', () => {
    expect(selectPrMatch([row(5, 'open')])).toEqual(row(5, 'open'));
  });

  test('several matches prefer the OPEN PR, regardless of print order', () => {
    expect(selectPrMatch([row(3, 'closed'), row(9, 'open'), row(12, 'open')])).toEqual(
      row(9, 'open'),
    );
    expect(selectPrMatch([row(12, 'open'), row(9, 'open'), row(3, 'closed')])).toEqual(
      row(9, 'open'),
    );
  });

  test('no open match → the LOWEST number (the oldest, most canonical PR)', () => {
    expect(selectPrMatch([row(21, 'merged'), row(4, 'closed'), row(17, 'merged')])).toEqual(
      row(4, 'closed'),
    );
    expect(selectPrMatch([row(21, 'unknown'), row(17, 'unknown')])).toEqual(row(17, 'unknown'));
  });

  test('a FORK match is returned only when it is the sole candidate — the op refuses it (final jNTyU)', () => {
    const fork = row(33, 'open', true);
    expect(selectPrMatch([fork])).toEqual(fork);
  });

  test('a same-repo candidate always beats a fork match, whatever the numbers', () => {
    expect(selectPrMatch([row(3, 'open', true), row(99, 'open')])).toEqual(row(99, 'open'));
    expect(selectPrMatch([row(3, 'open', true), row(99, 'closed')])).toEqual(row(99, 'closed'));
  });
});

describe('parseCreatedPr (gh pr create stdout)', () => {
  test('the printed URL yields the number and the URL', () => {
    expect(parseCreatedPr('https://github.test/owner/repo/pull/123\n')).toEqual({
      number: 123,
      url: 'https://github.test/owner/repo/pull/123',
    });
  });

  test('output without a pull URL is a fault (never a fabricated number)', () => {
    expect(() => parseCreatedPr('creating pull request for cq/09-16a/fix/core\n')).toThrow(
      /printed no PR URL/,
    );
  });
});
