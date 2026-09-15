// Fixture op-family registry for the from-source smoke (I1 slice D):
// the family-convention shape (src/ops/<family>/registry.ts — see
// src/ops/README.md) rendered as plain ESM .js under test/fixtures, exactly
// like the sibling test/fixtures/cli-ops/fixture family. The from-source
// smoke points the BUILT CLI at this directory with --ops-root, so `cq
// run-plan` discovers `agent-run` through the same lazy-aggregating central
// registry (src/registry) it uses for real families.
import { z } from 'zod';

export const registry = [
  {
    name: 'agent-run',
    inputSchema: z.object({ jobId: z.string() }).strict(),
    // Lazy: resolves to the op module's DEFAULT export (the op function —
    // `() => Promise<Op>` per the family convention).
    importer: async () => (await import('./agent-run.js')).default,
  },
];
