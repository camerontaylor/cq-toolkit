// Split provenance: test/cli/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures and helpers
// live in registry.helpers.ts, which carries the full I1 contract header.
// This file carries the registry ⇄ CLI subcommand surface (invariant 3).
import { describe, expect, test } from 'vitest';
import { subcommandNames } from '../../src/cli/main.js';
import { listPlans } from '../../src/plans/registry.js';
import { list, listWithDiagnostics } from '../../src/registry/index.js';

describe('registry ⇄ CLI subcommand surface', () => {
  test('every registry entry has a subcommand', async () => {
    const entries = await list();
    const planNames = (await listPlans()).map((entry) => entry.name);
    const names = subcommandNames(entries, planNames);
    for (const entry of entries) {
      expect(names).toContain(entry.name);
    }
    expect(names).toContain('run-plan');
    // T4.3 generation contract: the plan-registry names are on the subcommand
    // surface too — generated from the registry, never a hand-written list.
    for (const planName of planNames) {
      expect(names).toContain(planName);
    }
    // The built-in run-plan subcommand exists even with zero op families.
    expect(subcommandNames([])).toEqual(['run-plan']);
    // Plan names ride the caller-supplied list (sorted, deduped, run-plan
    // appended) — the signature stays backward compatible for op-only callers.
    expect(subcommandNames([], ['sweep'])).toEqual(['sweep', 'run-plan']);
    // Convention closure (phase-4 T4.2): every planned family now exports a
    // `registry` array, so NO family is skipped — the diagnostics' skip list
    // is empty. ratchet's interim metric-adapter registry moved to
    // metricRegistry.ts and the family's registry.ts is the op registry.
    const { entries: diagEntries, skippedFamilies } = await listWithDiagnostics();
    expect(skippedFamilies).toEqual([]);
    // list() is exactly the diagnostics' entry half (same cached scan).
    expect(diagEntries).toEqual(entries);
  });
});
