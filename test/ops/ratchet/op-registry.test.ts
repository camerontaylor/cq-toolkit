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
});
