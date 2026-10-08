// Fixture op-family registry for the plans-smoke REAL sweep/test-fix
// instances (goal T4.3, migrated to the S4b-B2 factory posture — ADR-0002
// §2.5): the family-convention shape (src/ops/<family>/registry.ts — see
// src/ops/README.md) rendered as plain ESM .js under test/fixtures, exactly
// like the sibling smoke family. The real-instance legs point the BUILT CLI
// at this directory with --ops-root, so `cq run-plan` discovers
// `sweep.planSweep` + `sweep.unit` through the same lazy-aggregating central
// registry (src/registry) it uses for real families.
//
// WHY A FIXTURE FAMILY: sweep.unit's registered importer binds the DEFAULT
// createDriverFactory() — whose conservative bindings resolve only the
// default providers on the ai-sdk lane. The real-instance legs need the
// subprocess lane over the fake sweep agent (hermetic, no network), and a
// deployment binds that lane through its DriverFactoryConfig — which is
// EXACTLY what this family is: the fixture deployment's factory config
// (bindings: fixer → subprocess for the fake provider; lanes.subprocess
// carrying the binary/routing-table/sessions-dir knobs that plan JSON may
// no longer name). The plan JSON's driver section stays
// {provider, model} — the factory's RESOLUTION INPUT.
//
// The entries bind the REAL op modules from the BUILT package (dist), so
// the legs exercise the shipped compositions, not a re-implementation.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', '..', '..', 'dist', 'index.js');
const { PlanSweepInputSchema, SweepUnitDispatchInputSchema } = await import(DIST);

export const registry = [
  {
    name: 'sweep.planSweep',
    inputSchema: PlanSweepInputSchema,
    // Lazy: resolves to the op module's DEFAULT export (the op function —
    // `() => Promise<Op>` per the family convention).
    importer: async () => (await import('./plan.js')).default,
  },
  {
    name: 'sweep.unit',
    inputSchema: SweepUnitDispatchInputSchema,
    importer: async () => (await import('./unit.js')).default,
  },
];
