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
// The gates family's shared spot defines the upstream failure shape; the
// analyze boundary re-mirrors it LOCALLY with one ledger-domain bound added
// (see AnalyzeCheckFailureSchema), so a collect→cluster chain can never
// pass a failure the cluster boundary would reject.
import type { CheckFailure, FailureSet } from '../gates/checkRunner.js';
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
 * ENCODED-size cap for the identifiers that flow into the cluster
 * signature. The arithmetic it pins: JSON.stringify escapes to at most 6
 * units per raw character (\uXXXX for a lone surrogate), so bounding the
 * ENCODED size is the escape-proof form of the serialized-size bound — a
 * raw-length cap cannot see quote/backslash inflation (Codex's own
 * suggestion). Worst-case fixed overhead of a canonical signature = 120
 * (tool) + 120 (ruleId) encoded units + ~10 of tuple punctuation + ~3 for
 * the truncation marker < SIGNATURE_MAX_CHARS, so clusterSignature's
 * truncation loop provably converges for EVERY schema-valid op input.
 * Real rule ids pass untouched: the repo's longest enabled lint rule id
 * (46 raw chars) encodes to ~48 units. Exported so the boundary tests pin
 * the SAME number.
 */
export const ANALYZE_IDENTIFIER_ENCODED_MAX = 120;

/** Loose raw cap ahead of the encoded check: cheap rejection first; the encoded check does the real work. */
const ANALYZE_IDENTIFIER_RAW_LOOSE_MAX = 500;

/** tool/ruleId string schema: loosely raw-capped, then bounded on the JSON-ENCODED size. */
const EncodedBoundedIdentifier = z
  .string()
  .max(ANALYZE_IDENTIFIER_RAW_LOOSE_MAX)
  .refine(
    (value) => JSON.stringify(value).length <= ANALYZE_IDENTIFIER_ENCODED_MAX,
    `identifier JSON encoding exceeds ${ANALYZE_IDENTIFIER_ENCODED_MAX} units (the analyze signature bound)`,
  );

/**
 * The gates' shared CheckFailureSchema shape with ONE local bound added:
 * ruleId is bounded on its JSON-ENCODED size (it is part of the cluster
 * signature's fixed overhead). Shared by BOTH analyze ops so a
 * collect→cluster chain can never pass a ruleId the cluster boundary would
 * reject; the gates' schema itself stays untouched, and the
 * z.ZodType<CheckFailure> annotation pins the mirror to the frozen type at
 * compile time, so a shape drift fails typecheck.
 */
const AnalyzeCheckFailureSchema: z.ZodType<CheckFailure> = z
  .object({
    file: z.string().nullable(),
    line: z.number().nullable(),
    column: z.number().nullable(),
    ruleId: EncodedBoundedIdentifier.nullable(),
    message: z.string(),
    severity: z.enum(['error', 'warning']),
  })
  .strict();

/**
 * LOCAL tightening of the reused gates FailureSet shape for the analyze
 * ops: `tool` is bounded on its JSON-ENCODED size. With tool and ruleId
 * both at that bound, the signature's fixed JSON overhead provably fits
 * SIGNATURE_MAX_CHARS (see {@link ANALYZE_IDENTIFIER_ENCODED_MAX}), so the
 * over-bound residual is LIBRARY-CALL-ONLY — direct clusterSignature calls
 * that bypass this boundary. The gates' shared schema itself stays
 * untouched.
 */
const AnalyzeFailureSetSchema: z.ZodType<FailureSet> = z
  .object({
    tool: EncodedBoundedIdentifier,
    failures: z.array(AnalyzeCheckFailureSchema),
    exitCode: z.number().nullable(),
  })
  .strict();

/**
 * The clusterErrors variant: the same tightening (tool and each failure's
 * ruleId bounded on their encoded size — ruleId is part of the cluster
 * signature's fixed overhead), pinned to the frozen FailureSet type.
 */
const ClusterFailureSetSchema: z.ZodType<FailureSet> = z
  .object({
    tool: EncodedBoundedIdentifier,
    failures: z.array(AnalyzeCheckFailureSchema),
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
