// Ledger lane C4 — registry slice: the `ledger.record` and `ledger.query`
// op entries, typed against the FROZEN OpRegistryEntry (src/kernel/types.ts).
// The importers bind the sync node:fs {@link pathLedgerStore} INPUT-DRIVEN —
// the factory takes a store selector over the op input, so `storePath`
// crosses the plain-JSON boundary (a store object never does) and the same
// op serves any path. Both op modules load through DYNAMIC imports, so
// loading the registry never loads an op module: module scope imports only
// zod and types (the type-only imports are erased at compile time), keeping
// the lazy-import pattern. The zod schemas are registry-time mirrors of the
// lane's types and live HERE (the shared spot, C1's CheckRunnerInputSchema
// precedent) because `inputSchema` must exist eagerly while the ops may not.
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import type { LedgerQueryInput, LedgerRecordInput } from './ledger.js';

/**
 * Registry-time mirror of the ledger threshold overrides: bounds per field
 * (suppressAt ≥ 1, escalateAt ≥ 2, integers) plus the pairwise invariant
 * escalateAt > suppressAt when BOTH are present. A lone field that only
 * makes sense against the other's default (suppressAt 5, escalateAt
 * defaulted to 3) is caught by the op's RESOLVED-pair validation — the
 * schema does not bake the defaults in, so they can drift without lying.
 */
export const LedgerThresholdsOverrideSchema = z
  .object({
    suppressAt: z.number().int().min(1).optional(),
    escalateAt: z.number().int().min(2).optional(),
  })
  .strict()
  .refine((t) => t.suppressAt === undefined || t.escalateAt === undefined || t.suppressAt < t.escalateAt, {
    message: 'escalateAt must be greater than suppressAt',
  });

/**
 * Registry-time mirror of {@link LedgerRecordInput}: the full input, and
 * only it. `root` + `storePath` are REQUIRED — the registry-bound store is
 * built per dispatch, contained to strict descendants of an existing root
 * (pathLedgerStore's seam check), so a dispatch can never aim the write
 * outside the root. String fields are bounded and non-empty: an empty
 * signature is noise, an empty component/note would pin a permanent hollow
 * backfill, and unbounded signature (500) / component (200) / note (500)
 * would let one input bloat the committed file. Strict: an unknown key
 * must fail loudly, not be silently stripped.
 */
export const LedgerRecordInputSchema: z.ZodType<LedgerRecordInput> = z
  .object({
    root: z.string().min(1),
    storePath: z.string().min(1),
    signature: z.string().min(1).max(500),
    component: z.string().min(1).max(200).optional(),
    note: z.string().min(1).max(500).optional(),
    thresholds: LedgerThresholdsOverrideSchema.optional(),
  })
  .strict();

/** Registry-time mirror of {@link LedgerQueryInput}: the full input, and only it. */
export const LedgerQueryInputSchema: z.ZodType<LedgerQueryInput> = z
  .object({
    root: z.string().min(1),
    storePath: z.string().min(1),
    thresholds: LedgerThresholdsOverrideSchema.optional(),
  })
  .strict();

/** Ledger-lane op registry (C4 record + query). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'ledger.record',
    inputSchema: LedgerRecordInputSchema,
    // The dispatch seam re-validates input through inputSchema.parseAsync
    // before invoking the op, so the erased op typing is safe here. The
    // importer resolves BOTH the op module and the fs store, binding the
    // store INPUT-DRIVEN (pathLedgerStore(input.root, input.storePath) —
    // containment checked at the seam) — no op wiring exists at registry
    // module scope.
    importer: () =>
      Promise.all([import('./ledger.js'), import('./store.js')]).then(
        ([m, s]) =>
          m.makeLedgerRecord((input) =>
            s.pathLedgerStore(input.root, input.storePath),
          ) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'ledger.query',
    inputSchema: LedgerQueryInputSchema,
    importer: () =>
      Promise.all([import('./ledger.js'), import('./store.js')]).then(
        ([m, s]) =>
          m.makeLedgerQuery((input) =>
            s.pathLedgerStore(input.root, input.storePath),
          ) as Op<unknown, unknown>,
      ),
  },
];
