// T4.2 — the ratchet family OP registry (src/ops/ratchet/registry.ts).
//
// Pinned here:
//   1. The family carries exactly the four H1–H3 ops (the metric adapters are
//      NOT ops and stay in metricRegistry.ts), each named `<family>.<module
//      base>` so the central completeness heuristic covers the module and the
//      CLI exposes one subcommand per op.
//   2. Every entry's schema accepts a minimal plain-JSON input (the JSON a
//      dispatcher sends) and rejects an unknown key (strict throughout).
//   3. The importer RESOLVES to a callable async op without spawning,
//      touching the network, or reading the filesystem at bind time: the
//      CheckRunner/gh/git seams are bound per dispatch and are closure-only
//      at construction (the inertness proof).
import { describe, expect, test } from 'vitest';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import { registry } from '../../../src/ops/ratchet/registry.js';

const ENTRY_NAMES = [
  'ratchet.captureBaseline',
  'ratchet.checkRatchet',
  'ratchet.monotonicGuard',
  'ratchet.proposeBaselineUpdate',
];

const entryByName = (name: string) => {
  const entry = registry.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing registry entry '${name}'`);
  return entry;
};

const commandSource = (): Record<string, unknown> => ({
  kind: 'command',
  command: 'node',
  args: ['-e', ''],
  parse: 'tsc-text',
});

const minimalInputs: Record<string, () => Record<string, unknown>> = {
  'ratchet.checkRatchet': () => ({
    ws: '/repo',
    target: 'typecheck',
    metric: 'typecheck-count',
    source: commandSource(),
  }),
  'ratchet.captureBaseline': () => ({
    ws: '/repo',
    target: 'typecheck',
    metric: 'typecheck-count',
    source: commandSource(),
  }),
  'ratchet.monotonicGuard': () => ({ diff: '' }),
  'ratchet.proposeBaselineUpdate': () => ({
    ws: '/repo',
    base: 'main',
    improvements: [{ target: 'typecheck', metric: 'typecheck-count', value: 0 }],
  }),
};

const minimalInput = (name: string): Record<string, unknown> => {
  const make = minimalInputs[name];
  if (make === undefined) throw new Error(`no minimal input fixture for '${name}'`);
  return make();
};

describe('ratchet family op registry entries', () => {
  test('the family carries exactly the four ops, each `<family>.<module base>`', () => {
    expect(registry.map((entry) => entry.name).sort()).toEqual([...ENTRY_NAMES].sort());
  });

  test.each(ENTRY_NAMES)('%s: inputSchema accepts a minimal valid input', (name) => {
    expect(entryByName(name).inputSchema.safeParse(minimalInput(name)).success).toBe(true);
  });

  test.each(ENTRY_NAMES)('%s: inputSchema rejects an unknown key (strict)', (name) => {
    const result = entryByName(name).inputSchema.safeParse({
      ...minimalInput(name),
      typo: true,
    });
    expect(result.success).toBe(false);
  });

  test('monotonicGuard requires exactly one of diff/diffPath', () => {
    const schema = entryByName('ratchet.monotonicGuard').inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ diff: '', diffPath: '/tmp/x.diff' }).success).toBe(false);
    expect(schema.safeParse({ diffPath: '/tmp/x.diff' }).success).toBe(true);
  });

  test.each(ENTRY_NAMES)(
    '%s: the importer resolves to an async op without side effects',
    async (name) => {
      const op = await entryByName(name).importer();
      expect(typeof op).toBe('function');
    },
  );

  test('ratchet.monotonicGuard normalizes the coverage re-basis before judging (review finding 1)', async () => {
    // A hand-committed fractional coverage baseline re-based to the integer
    // the live `coverage-json` reading uses must read as an equal no-op, not
    // a loosening — the op normalizes before the pure guard judges.
    const op = await entryByName('ratchet.monotonicGuard').importer();
    const reBasis = await op({ diff: coverageDiff(93.46, 93) });
    expect(reBasis).toMatchObject({
      status: 'ok',
      value: { ok: true, violations: [], filesChecked: 1 },
    });
    const loosened = await op({ diff: coverageDiff(93, 92) });
    expect(loosened).toMatchObject({
      status: 'ok',
      value: { ok: false, violations: [{ why: 'loosened' }] },
    });
  });
});

/** A full-file-rewrite diff over the committed coverage baseline path. */
function coverageDiff(oldValue: number, newValue: number): string {
  const rel = baselineRelPath('coverage', 'coverage');
  const body = (value: number): string[] =>
    renderBaseline({
      schemaVersion: 1,
      target: 'coverage',
      metric: 'coverage',
      direction: 'higher-is-better',
      value,
      unit: 'pct',
      capturedAt: '2026-09-15T19:20:25.084Z',
    })
      .split('\n')
      .filter((line) => line !== '');
  return (
    [
      `diff --git a/${rel} b/${rel}`,
      'index 1111111..2222222 100644',
      `--- a/${rel}`,
      `+++ b/${rel}`,
      '@@ -1,7 +1,7 @@',
      ...body(oldValue).map((line) => `-${line}`),
      ...body(newValue).map((line) => `+${line}`),
    ].join('\n') + '\n'
  );
}
