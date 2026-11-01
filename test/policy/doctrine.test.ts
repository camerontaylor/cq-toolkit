import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('direct main merge policy', () => {
  it('requires exact-head checks and independent review without promotion machinery', () => {
    const doctrine = readFileSync(new URL('../../policy/DOCTRINE.md', import.meta.url), 'utf8');
    const rule = doctrine.split('## I3 —')[1]?.split('## I4 —')[0];
    expect(rule).toContain('PRs target `main`');
    expect(rule).toContain('`static`');
    expect(rule).toContain('`denylist`');
    expect(rule).toContain('independent reviewer');
    expect(rule).toContain('CRQ reviews merged PRs after merge');
    expect(rule).not.toContain('atomic leased push');
  });
});
