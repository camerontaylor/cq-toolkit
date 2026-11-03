// record.ts unit tests — branch-path safety for the per-branch dev ledger:
// refname validation and the flattened, bounded ledger filename.
// Split provenance: test/ops/dev/record.test.ts was split into record.format.test.ts,
// record.finding-schema.test.ts, record.branch-path.test.ts, record.store.test.ts,
// record.readiness.test.ts, record.reuse-selector.test.ts and
// record.readiness-reuse.test.ts.
import { describe, expect, test } from 'vitest';
import { branchPathFault, devLedgerPath } from '../../../src/ops/dev/record.js';

describe('branchPathFault', () => {
  test('a normal namespaced branch is safe and joins under .cq/dev/', () => {
    expect(branchPathFault('phase1/dev-commands')).toBeNull();
    // prefix of the flattened branch + '-' + 16-hex sha256 suffix, bounded.
    const encodedFirst = devLedgerPath('/repo', 'phase1/dev-commands').split('/').at(-1) ?? '';
    expect(encodedFirst).toMatch(/^phase1-dev-commands-[0-9a-f]{16}\.json$/);
    // Collision-free AND bounded: the full branch hashes into the name, so
    // distinct branches stay distinct (`a%2Fb` vs `a/b` hash apart), and a
    // git-maximal hierarchical ref stays under the 255-byte name limit.
    const fooPath = devLedgerPath('/repo', 'foo');
    const fooBarPath = devLedgerPath('/repo', 'foo.json/bar');
    expect(fooPath).not.toBe(fooBarPath);
    expect(fooPath.endsWith('.json')).toBe(true);
    const longBranch = Array.from({ length: 40 }, (_, i) => `segment${String(i)}`).join('/');
    const longPath = devLedgerPath('/repo', longBranch);
    const encoded = longPath.split('/').at(-1) ?? '';
    expect(encoded.length).toBeLessThanOrEqual(255);
    // Same branch → same path (stable); different → different.
    expect(devLedgerPath('/repo', longBranch)).toBe(longPath);
  });

  test('refusals: empty, absolute, .., leading dot, .lock suffix, spaces, backslash', () => {
    for (const branch of ['', '/abs', 'a/../b', '.hidden', 'x.lock', 'a b', 'a\\b']) {
      expect(branchPathFault(branch), branch).not.toBeNull();
    }
  });

  test('devLedgerPath throws on an unsafe branch (defense in depth)', () => {
    expect(() => devLedgerPath('/repo', '../escape')).toThrow(/path-safe refname/);
  });
});
