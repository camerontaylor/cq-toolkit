// Split provenance: test/ops/review/fixReviewItem.test.ts was split into the
// fixReviewItem.*.test.ts siblings in this directory; the shared fixtures live
// in fixReviewItem.helpers.ts and the original suite header sits there.
import { describe, expect, test } from 'vitest';
import { registry } from '../../../src/ops/review/registry.js';
import { baseInput, completeWorker, scriptedOp } from './fixReviewItem.helpers.js';

// ---------------------------------------------------------------------------
// 8. Registry entry
// ---------------------------------------------------------------------------

describe('review.fixItem registry entry', () => {
  /**
   * The family's fixItem entry. The family registry carries the SIX
   * review-loop ops (enumerated exhaustively in registry.test.ts); this
   * block pins only the fixItem entry's own contract.
   */
  const fixEntry = () => {
    const entry = registry.find((candidate) => candidate.name === 'review.fixItem');
    if (entry === undefined) {
      throw new Error("missing registry entry 'review.fixItem'");
    }
    return entry;
  };

  test("the family registry carries a 'review.fixItem' entry", () => {
    expect(registry.some((entry) => entry.name === 'review.fixItem')).toBe(true);
  });

  test('inputSchema accepts the minimal valid input', () => {
    const entry = fixEntry();
    const minimal = {
      pr: 1,
      item: {
        id: 'T1',
        path: null,
        line: null,
        body: 'fix me',
        comments: [],
      },
      worktree: { path: '/tmp/cq-fix-review/pr-1', branch: 'cq-review/pr-1' },
      driver: { model: 'm', provider: 'p' },
    };
    expect(entry.inputSchema.safeParse(minimal).success).toBe(true);
  });

  test.each([
    [
      'an unknown key',
      (minimal: Record<string, unknown>) => {
        minimal['extra'] = 1;
      },
    ],
    [
      'pr 0',
      (minimal: Record<string, unknown>) => {
        minimal['pr'] = 0;
      },
    ],
    [
      'a missing worktree',
      (minimal: Record<string, unknown>) => {
        delete minimal['worktree'];
      },
    ],
  ])('inputSchema rejects %s', (_name, mutate) => {
    const entry = fixEntry();
    const minimal: Record<string, unknown> = {
      pr: 1,
      item: { id: 'T1', path: null, line: null, body: 'fix me', comments: [] },
      worktree: { path: '/tmp/cq-fix-review/pr-1', branch: 'cq-review/pr-1' },
      driver: { model: 'm', provider: 'p' },
    };
    mutate(minimal);
    expect(entry.inputSchema.safeParse(minimal).success).toBe(false);
  });

  test('the importer resolves to a callable op (the driver factory constructs inert lane instances)', async () => {
    const entry = fixEntry();
    const op = await entry.importer();
    expect(typeof op).toBe('function');
  });
});

test('local finding input is additive: no PR required, strict finding schema, old thread shape retained', async () => {
  const entry = registry.find((item) => item.name === 'review.fixItem')!;
  const old = baseInput();
  const { pr: _pr, ...local } = old;
  const input = {
    ...local,
    item: {
      kind: 'finding' as const,
      finding: {
        id: 'local-1',
        source: 'agent',
        file: 'src/a.ts',
        line: 3,
        severity: 'major',
        text: 'Local defect',
        status: 'open' as const,
      },
    },
  };
  expect(entry.inputSchema.safeParse(old).success).toBe(true);
  expect(entry.inputSchema.safeParse(input).success).toBe(true);
  expect(
    entry.inputSchema.safeParse({ ...input, item: { ...input.item, unknown: true } }).success,
  ).toBe(false);
  const scripted = scriptedOp([
    completeWorker(
      JSON.stringify({
        disposition: 'unchanged_with_reason',
        summary: 'already correct',
        commits: [],
        evidence: [{ path: 'src/a.ts', line: 3 }],
      }),
    ),
  ]);
  const result = await scripted.op(input);
  expect(result.status).toBe('ok');
  expect(scripted.invocations[0]?.prompt).toContain('Local defect');
  expect(scripted.invocations[0]?.prompt).not.toContain('Pull request: #undefined');
});
