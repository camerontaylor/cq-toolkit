// Split provenance: test/ops/dev/check.test.ts was split by subject into
// check.input-rules.test.ts, check.adopter.test.ts, check.portable-scan.test.ts,
// check.selection.test.ts, check.gates.test.ts and check.diff-gates.test.ts.
import { describe, expect, test } from 'vitest';
import { knipTrigger, makeDevCheck, rangeFault } from '../../../src/ops/dev/check.js';
import { makeFakeEffects } from './fakes.js';

describe('rangeFault and knipTrigger', () => {
  test('rangeFault accepts two distinct refs; refuses empty halves, options, identical ends', () => {
    expect(rangeFault('a..b')).toBeNull();
    expect(rangeFault('a..')).not.toBeNull();
    expect(rangeFault('-x..b')).not.toBeNull();
    expect(rangeFault('a..a')).not.toBeNull();
    expect(rangeFault('a..b..c')).not.toBeNull();
  });

  test.each([
    ['M\0docs/x.md\0', [], null],
    ['M\0.github/workflows/ci.yml\0', [], null],
    ['M\0src/a.ts\0', [], 'modified src/a.ts'],
    ['M\0package.json\0', [], 'modified package.json'],
    ['M\0tsconfig.build.json\0', [], 'modified tsconfig.build.json'],
    ['A\0docs/new.md\0', [], 'A docs/new.md'],
    ['D\0docs/old.md\0', [], 'D docs/old.md'],
    ['M\0docs/x.md\0', ['scratch.ts'], 'untracked file scratch.ts'],
  ])('%j with untracked %j → %j', (listing, untracked, expected) => {
    expect(knipTrigger(listing, untracked)).toBe(expected);
  });
});

describe('dev.check', () => {
  test('a malformed range or schema-bypassing input fails before any command runs', async () => {
    for (const input of [
      { repoRoot: '/repo', range: '--output=x..HEAD' },
      { repoRoot: '/repo', range: 7 },
      { repoRoot: 3 },
      { repoRoot: '/repo', knip: 'force' },
    ]) {
      const effects = makeFakeEffects();
      const result = await makeDevCheck(effects)(input as never);
      expect(result.status).toBe('failed');
      expect(effects.commands).toEqual([]);
    }
  });
});
