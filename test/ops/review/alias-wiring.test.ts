// PR #238 review P2 — the SHIPPED review.fixItem registry importer consumes
// the dispatch wiring: an injected `onDeprecatedAlias` sink receives the
// deprecated-alias notice and process.stderr stays untouched; the unwired
// importer keeps the library default (one stderr line). The op RESOLVES
// FIRST (ADR-0002 §2.5), so the aliased spec fires the notice before the
// offline ai-sdk lane throw ('unknown provider' — no provider table entry
// without credentials) maps to its §2.9 verdict — never an escaped throw.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { registry } from '../../../src/ops/review/registry.js';
import type { OpResult } from '../../../src/kernel/types.js';

const entry = registry.find((candidate) => candidate.name === 'review.fixItem');
if (entry === undefined) throw new Error('review family: no registry entry named review.fixItem');

/** Minimal schema-valid input whose aliased spec fires the notice at resolve. */
const aliasedInput = {
  pr: 1,
  item: { id: 't1', path: null, line: null, body: 'x', comments: [] },
  worktree: { path: '/tmp/cq-alias-wiring-wt', branch: 'b' },
  driver: { provider: 'ai-sdk', model: 'glm-4.6' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('review.fixItem importer dispatch wiring (PR #238 review P2)', () => {
  test('an injected sink receives the notice; process.stderr stays silent', async () => {
    const notices: string[] = [];
    const op = await entry.importer({
      onDeprecatedAlias: (message: string) => {
        notices.push(message);
      },
    });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = (await op(aliasedInput)) as OpResult<unknown>;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('cq:');
    expect(notices[0]).toContain('deprecated');
    expect(write).not.toHaveBeenCalled(); // the sink replaced the stderr write
    // The offline lane throw mapped per §2.9 — the dispatch verdict, not a
    // throw across the op seam.
    expect(['failed', 'needs-human']).toContain(result.status);
  });

  test('the unwired importer keeps the library default: the stderr notice still writes', async () => {
    const op = await entry.importer();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await op(aliasedInput);
    expect(write.mock.calls.some((call) => String(call[0]).includes('deprecated'))).toBe(true);
  });
});
