// Analyze lane G1 — registry slice: the `analyze.collectFailures` and
// `analyze.clusterErrors` op entries, typed against the FROZEN
// OpRegistryEntry (src/kernel/types.ts). Both importers resolve through
// DYNAMIC imports, so loading the registry never loads an op module: module
// scope imports only zod, the ledger bound constants, and types (the
// type-only imports are erased at compile time) — the gates registry's
// lazy-import pattern. The zod schemas are registry-time mirrors of the
// lane's inputs and live HERE because `inputSchema` must exist eagerly while
// the ops may not.
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
// Reused from the gates family's shared spot: CheckFailure crosses the
// boundary exactly as `gates.checkRunner` produced it, so the analyze input
// schemas can never drift from the upstream shape (the same one-source
// argument the gates registry makes for its own consumers).
import { CheckFailureSchema } from '../gates/registry.js';
import type { FailureSet } from '../gates/checkRunner.js';
// Runtime import of the ledger's field-bound constants — pulled from ONE
// definition (the ledger record boundary) so a parse here rejects exactly
// what a record could produce. Safe at module scope: the pure ledger
// decision module has zero runtime imports of its own.
import { COMPONENT_MAX_CHARS, NOTE_MAX_CHARS, SIGNATURE_MAX_CHARS } from '../ledger/ledger.js';
// TYPE-ONLY import of the store format: erased at compile time, so this
// module never loads the store's node:fs adapter (the ledger module's own
// discipline).
import type { LedgerEntry } from '../ledger/store.js';
import type { LedgerView } from '../ledger/ledger.js';
import type { ClusterErrorsInput } from './clusterErrors.js';
import type { CollectFailuresInput } from './collectFailures.js';

/**
 * LOCAL tightening of the reused gates FailureSet shape for the analyze ops:
 * `tool` is bounded to the ledger's COMPONENT_MAX_CHARS — ledger-domain
 * alignment, so the fixed JSON overhead of a canonical cluster signature
 * (tool + ruleId + template) always fits SIGNATURE_MAX_CHARS and
 * clusterSignature's template-truncation loop always converges for
 * op-dispatched input; the over-bound residual is unreachable through the
 * op boundary. The gates' shared schema itself stays untouched, and the
 * failure shape is still the gates' ONE definition (CheckFailureSchema).
 */
const AnalyzeFailureSetSchema: z.ZodType<FailureSet> = z
  .object({
    tool: z.string().max(COMPONENT_MAX_CHARS),
    failures: z.array(CheckFailureSchema),
    exitCode: z.number().nullable(),
  })
  .strict();

/**
 * The clusterErrors variant additionally bounds EACH failure's ruleId to
 * the ledger component bound (ruleId is part of the cluster signature's
 * fixed overhead). Mirrors the gates' shared CheckFailureSchema shape with
 * that one bound added; the z.ZodType<FailureSet> annotation pins the
 * mirror to the frozen type at compile time, so a shape drift fails
 * typecheck.
 */
const ClusterFailureSetSchema: z.ZodType<FailureSet> = z
  .object({
    tool: z.string().max(COMPONENT_MAX_CHARS),
    failures: z.array(
      z
        .object({
          file: z.string().nullable(),
          line: z.number().nullable(),
          column: z.number().nullable(),
          ruleId: z.string().max(COMPONENT_MAX_CHARS).nullable(),
          message: z.string(),
          severity: z.enum(['error', 'warning']),
        })
        .strict(),
    ),
    exitCode: z.number().nullable(),
  })
  .strict();

/**
 * Registry-time mirror of {@link CollectFailuresInput}: the full input, and
 * only it. Deliberately a PURE mirror — an empty `sets` array validates
 * here, because "no runs to aggregate" is the op's POLICY failure (mapped to
 * `failed` with the reason), not a shape violation; the boundary rejects
 * what cannot be an input, the op rejects what must not aggregate.
 */
export const CollectFailuresInputSchema: z.ZodType<CollectFailuresInput> = z
  .object({
    sets: z.array(AnalyzeFailureSetSchema),
  })
  .strict();

/**
 * Registry-time mirror of the frozen ledger {@link LedgerEntry}: bounds ride
 * from the ledger's exported constants (one definition), and the optional
 * fields are `.exactOptional()` so an explicit `component: undefined` is
 * rejected exactly as the frozen type reads.
 */
const LedgerEntryObject: z.ZodType<LedgerEntry> = z
  .object({
    signature: z.string().min(1).max(SIGNATURE_MAX_CHARS),
    count: z.number().int().min(1),
    component: z.string().min(1).max(COMPONENT_MAX_CHARS).exactOptional(),
    note: z.string().min(1).max(NOTE_MAX_CHARS).exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of the frozen ledger {@link LedgerView}: the full
 * view, and only it. Mirrored HERE because the ledger family exports no view
 * schema for reuse (a frozen-surface gap recorded in the family notes); the
 * `z.ZodType<LedgerView>` annotation pins the mirror to the frozen type at
 * compile time, so a ledger-shape change fails this boundary's typecheck.
 */
export const LedgerViewSchema: z.ZodType<LedgerView> = z
  .object({
    entries: z.array(LedgerEntryObject),
    knownNoise: z.array(z.string()),
    needsHuman: z.array(z.string()),
  })
  .strict();

/**
 * Registry-time mirror of {@link ClusterErrorsInput}: the full input, and
 * only it — the FailureSet schema shared with the gates family (no drift
 * from what `gates.checkRunner` produces), the ledger view optional with
 * `.exactOptional()` (an explicit null is not a view).
 */
export const ClusterErrorsInputSchema: z.ZodType<ClusterErrorsInput> = z
  .object({
    set: ClusterFailureSetSchema,
    ledger: LedgerViewSchema.exactOptional(),
  })
  .strict();

/** Analyze-lane op registry (G1: failure-set aggregation; signature clustering). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'analyze.collectFailures',
    inputSchema: CollectFailuresInputSchema,
    // The dispatch seam re-validates input through inputSchema.parseAsync
    // before invoking the op, so the erased op typing is safe here. The
    // importer resolves the op module's DEFAULT export — the documented
    // family-registry seam (src/ops/README.md).
    importer: () => import('./collectFailures.js').then((m) => m.default as Op<unknown, unknown>),
  },
  {
    name: 'analyze.clusterErrors',
    inputSchema: ClusterErrorsInputSchema,
    // Pure decision op — no injected wiring; the `.default` resolution is
    // the documented family-registry seam (src/ops/README.md).
    importer: () => import('./clusterErrors.js').then((m) => m.default as Op<unknown, unknown>),
  },
];
