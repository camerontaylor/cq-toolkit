// Analyze lane G1+G2+G3 — registry slice: the `analyze.collectFailures`,
// `analyze.clusterErrors`, `analyze.renderAnalysisReport`,
// `analyze.astGrepCodemod`, `analyze.agenticRemediation`,
// `analyze.applyRemediation`, and the G3 playbook entries
// (`analyze.playbookRegister`, `analyze.playbookDispatch`,
// `analyze.playbookQuarantineList`),
// typed against the FROZEN OpRegistryEntry (src/kernel/types.ts). All
// importers resolve through DYNAMIC imports, so loading the registry never
// loads an op module: module scope imports only zod, `dirname` from
// node:path (the applyRemediation store binding's `dir` default),
// `createDriverFactory` from the driver factory (NOT a lane module — the
// agenticRemediation entry's one construction seam; see its entry comment),
// the ledger's bound constants, the kernel's PURE zod mirrors of the frozen
// driver-seam types (kernel/schema.js — zod + types only, the same
// eager-import class as the ledger constants), and types (the type-only
// imports are erased at compile time) — the gates registry's lazy-import
// pattern. The zod schemas are registry-time mirrors of the lane's inputs
// and live HERE because `inputSchema` must exist eagerly while the ops may
// not.
import { dirname } from 'node:path';
import { z } from 'zod';
// The driver factory (ADR-0002 §2.5) is the ONE driver-family value this
// registry binds at module scope: it is NOT a lane module (the banned
// import class — ops never import src/driver/<lane>/), and binding it here
// is what lets the agenticRemediation importer compose the op without
// constructing a lane itself (the factory owns lane construction and the
// served-model assertion).
import { createDriverFactory } from '../../driver/factory.js';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
// The kernel's zod mirrors of the FROZEN driver-seam types (pure module:
// zod + types only) — one definition, never re-mirrored here.
import {
  BudgetSchema,
  ModelSpecSchema,
  SandboxPolicySchema,
  ToolPolicySchema,
} from '../../kernel/schema.js';
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
import type { Cluster, ClusterErrorsInput, ClusterErrorsReport } from './clusterErrors.js';
import type { ApprovalAuthority } from './approval.js';
import { DENY_ALL_APPROVALS } from './approval.js';
import type { CollectFailuresInput } from './collectFailures.js';
import type { AgenticRemediationInput } from './agenticRemediation.js';
import type { ApplyRemediationInput } from './applyRemediation.js';
import type { AstGrepCodemodInput } from './codemod/astGrep.js';
import type { RenderAnalysisReportInput } from './renderAnalysisReport.js';
// The G3 playbook format's schema is EAGERLY imported (the registry's
// documented eager class: zod + types only — format.ts imports nothing but
// zod at runtime), because `inputSchema` must exist while the ops may not.
import { PlaybookSchema } from './playbooks/format.js';
// The playbook ops and the quarantine ledger are composed at the importers
// through DYNAMIC imports (the lazy-import discipline); only their TYPES
// ride at module scope.
import type {
  PlaybookDispatchInput,
  PlaybookQuarantineListInput,
  PlaybookRegisterInput,
  PlaybookRegistry,
} from './playbooks/registry.js';
import type { QuarantineLedger } from './playbooks/quarantine.js';

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
 * untouched. ONE definition for BOTH consuming inputs
 * ({@link CollectFailuresInputSchema} and {@link ClusterErrorsInputSchema}
 * — the former's per-set bound and the latter's set bound are the same
 * tightening, so the collect→cluster chain can never drift apart).
 */
const AnalyzeFailureSetSchema: z.ZodType<FailureSet> = z
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
    set: AnalyzeFailureSetSchema,
    ledger: LedgerViewSchema.exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of the G1 {@link Cluster} with the SAME identifier
 * tightening the signatures carry (tool and ruleId encoded-bounded): a
 * report that enters any analyze op through this boundary can only hold
 * clusters the clusterErrors boundary could have produced, so the
 * render→apply chain never sees identifiers outside the family's bound.
 * The `z.ZodType<Cluster>` annotation pins the mirror to the frozen family
 * type at compile time.
 */
const AnalyzeClusterSchema: z.ZodType<Cluster> = z
  .object({
    id: z.string().regex(/^[0-9a-f]{8}$/, 'expected 8 lowercase hex digits (the FNV-1a 32-bit id)'),
    signature: z.string().min(1).max(SIGNATURE_MAX_CHARS),
    tool: EncodedBoundedIdentifier,
    ruleId: EncodedBoundedIdentifier.nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    failures: z.array(AnalyzeCheckFailureSchema),
    size: z.number().int().min(1),
  })
  .strict()
  // clusterErrors always sets size to the member count; a report that
  // disagrees can never have come from the family, so the boundary rejects
  // it instead of letting downstream planned-edit counts ride a lie.
  .refine((cluster) => cluster.size === cluster.failures.length, {
    message: 'size must equal failures.length',
  });

/**
 * Registry-time mirror of the G1 {@link ClusterErrorsReport}: the full
 * report, and only it — the shape both `analyze.renderAnalysisReport` and
 * (as embedded sidecar payload) `analyze.applyRemediation` accept.
 */
export const AnalyzeReportSchema: z.ZodType<ClusterErrorsReport> = z
  .object({
    clusters: z.array(AnalyzeClusterSchema),
    noise: z.array(AnalyzeCheckFailureSchema),
  })
  .strict();

/**
 * Registry-time mirror of {@link RenderAnalysisReportInput}: the full input,
 * and only it. `dir` is required and non-empty — the op wraps an EXISTING
 * directory (the store refuses a missing root) and derives both output file
 * names from the report fingerprint, so there is no path knob to misaim.
 */
export const RenderAnalysisReportInputSchema: z.ZodType<RenderAnalysisReportInput> = z
  .object({
    report: AnalyzeReportSchema,
    dir: z.string().min(1),
  })
  .strict();

/**
 * Registry-time mirror of {@link AgenticRemediationInput}: the full input,
 * and only it — the cluster mirror is the SAME {@link AnalyzeClusterSchema}
 * the report input accepts (one definition across the family chain), and
 * the driver-seam policy objects ride the kernel schema mirrors of the
 * FROZEN types. Strict: an unknown key must fail loudly.
 */
export const AgenticRemediationInputSchema: z.ZodType<AgenticRemediationInput> = z
  .object({
    clusterId: z.string().min(1),
    cluster: AnalyzeClusterSchema,
    modelSpec: ModelSpecSchema,
    toolPolicy: ToolPolicySchema.exactOptional(),
    sandboxPolicy: SandboxPolicySchema.exactOptional(),
    budget: BudgetSchema.exactOptional(),
    sessionRef: z.string().min(1).exactOptional(),
    // The write-policy approval flag (the rule's home is
    // agenticRemediation.ts's header: widening beyond read-only is an
    // approval-gated decision): required by the OP (not the
    // boundary) only when the effective policies permit writes — absence is
    // a decision the op refuses, not a malformed input.
    approved: z.boolean().exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link AstGrepCodemodInput}: the full input, and
 * only it. `files` requires at least one entry — an unscoped scan would
 * sweep everything under `dir`, which is exactly the blast radius the
 * approval gate exists to bound. `timeoutMs` defaults to 600_000 at this
 * boundary (the gates' op-boundary precedent, a zod `.default`, not a
 * minimum). `rule` must be non-empty: an empty rule text is a malformed
 * invocation, not a scan that matches nothing.
 */
export const AstGrepCodemodInputSchema: z.ZodType<AstGrepCodemodInput> = z
  .object({
    dir: z.string().min(1),
    rule: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    dryRun: z.boolean(),
    approved: z.boolean().exactOptional(),
    timeoutMs: z.number().int().positive().default(600_000),
  })
  .strict();

/**
 * Registry-time mirror of {@link ApplyRemediationInput}: the full input, and
 * only it. `clusterId` and `approved` are OPTIONAL at the boundary — their
 * ABSENCE is the `needs-human` refusal's whole point (UC §1 row 9: the op
 * must refuse when the human decision is missing, not reject the input as
 * malformed). `dir` defaults to the sidecar's directory in the op binding.
 */
export const ApplyRemediationInputSchema: z.ZodType<ApplyRemediationInput> = z
  .object({
    sidecarPath: z.string().min(1),
    dir: z.string().min(1).exactOptional(),
    clusterId: z.string().min(1).exactOptional(),
    // The FNV-id-collision disambiguator (F2), mirroring the library input's
    // optionality: required by the OP only when the sidecar carries more
    // than one cluster with the requested id.
    signature: z.string().min(1).exactOptional(),
    approved: z.boolean().exactOptional(),
    rule: z.string().min(1),
    dryRun: z.boolean(),
    timeoutMs: z.number().int().positive().default(600_000),
  })
  .strict();

/**
 * Registry-time mirror of {@link PlaybookRegisterInput}: the full input, and
 * only it — the playbook asset itself, validated by the format's strict
 * {@link PlaybookSchema}. Id UNIQUENESS is not a schema matter: a duplicate
 * registers as a `failed` refusal from the op (the registry sees the
 * population, the schema cannot).
 */
export const PlaybookRegisterInputSchema: z.ZodType<PlaybookRegisterInput> = z
  .object({
    playbook: PlaybookSchema,
  })
  .strict();

/**
 * Registry-time mirror of {@link PlaybookDispatchInput}: the full input, and
 * only it. `targets` requires at least one entry — an unscoped sweep is the
 * blast radius the family refuses at every boundary (the codemod engine
 * re-checks this at the op level too). `timeoutMs` defaults to 600_000 at
 * this boundary (the gates' op-boundary precedent, a zod `.default`).
 */
export const PlaybookDispatchInputSchema: z.ZodType<PlaybookDispatchInput> = z
  .object({
    playbookId: z.string().min(1),
    dir: z.string().min(1),
    targets: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().positive().default(600_000),
  })
  .strict();

/**
 * Registry-time mirror of {@link PlaybookQuarantineListInput}: the empty
 * object, strictly — the op takes no input and carries no option a cached
 * or filtered view could hide behind (the ledger's read surface is
 * unparameterized by design).
 */
export const PlaybookQuarantineListInputSchema: z.ZodType<PlaybookQuarantineListInput> = z
  .object({})
  .strict();

// Process-scoped v1 state for the playbook lane (the documented cut — see
// playbooks/quarantine.ts and the family NOTES.md): the playbook registry
// and the quarantine ledger are IN-MEMORY, so every playbook op composed
// below MUST bind the SAME instances — a playbook registered through one
// entry has to be dispatchable through another, and a quarantine recorded
// by one dispatch has to fail-close every later dispatch. The lazy ??=
// bindings inside the importers create them on first playbook dispatch;
// they live for the process lifetime (no file persistence in v1).
let sharedPlaybooks: PlaybookRegistry | undefined;
let sharedQuarantine: QuarantineLedger | undefined;

// THE APPROVAL AUTHORITY BINDING (W4.3; ADR-0003). The two mutating ops in
// this family — `analyze.applyRemediation` and `analyze.playbookDispatch` —
// authorize their WRITE through an `ApprovalAuthority`, never through a
// plan-JSON `approved: true`. The authority is process-wide for the same
// reason the playbook registry and quarantine ledger are: an approval that
// resolved per-importer would let two dispatch paths disagree about what is
// approved, which is the property the whole mechanism exists to prevent.
//
// FAIL-CLOSED BY DEFAULT. Unbound means DENY_ALL, so an op resolved before
// anyone calls the setter refuses every write with `needs-human` and an
// untouched workspace. There is deliberately NO permissive default and NO
// fallback that derives an approval from the input: a `approved: true` in
// plan JSON must never be able to authorize a write, so the only thing that
// can change that answer is an authority the KERNEL verified.
//
// EXACT CONTRACT FOR THE KERNEL OWNER (the governed-runner lane): bind an
// authority built over ADR-0003 §4a's signer/ledger SNAPSHOT and §4b's
// verification — i.e. one whose `VerifiedApprovals.verifiedFor` returns
// `{ nonce, state }` ONLY for a token whose signature, kid, `exp`/TTL and
// `inputsHash` already verified, and whose `state` is the claim's SIGNED
// state rather than a re-read (see ops/analyze/approval.ts for why that
// distinction is load-bearing). NO SUCH PRODUCER EXISTS YET: there is no
// approval module in src/kernel, so this binding is the seam it will land
// on, and until it is bound these two ops refuse every write by design.
// Passing `undefined` restores the deny-all default.
let sharedApproval: ApprovalAuthority = DENY_ALL_APPROVALS;

/**
 * Bind the process-wide approval authority for the analyze family's mutating
 * ops, or pass `undefined` to restore the deny-all default. See the block
 * comment above for the exact contract the kernel's authority must satisfy.
 *
 * Binding an authority does NOT make any approval valid by itself — it only
 * lets the ops ask. Every mutation still has to present a grant this
 * authority recognises, be exercised at the mutation, and consume its nonce
 * in one critical section of the workspace mutation lock.
 *
 * TENANCY AND LIFETIME (what the kernel owner must know). The binding is
 * process-wide and captured when an importer RESOLVES an op, which is what
 * makes two dispatch paths unable to disagree about what is approved. The
 * kernel runner resolves an importer per dispatch, so a bind performed BEFORE
 * a run reaches every dispatch of that run. Two consequences, both
 * fail-closed: there is no per-RUN scoping, so two concurrent plan runs in one
 * process would share one authority where ADR §4a's snapshot is per-run (the
 * damage is bounded by the subject binding — op, workspace, input digest and
 * a single-use nonce — so the worst case is "the write the token already
 * covered"); and an SDK consumer that holds a composed op reference keeps the
 * authority captured at composition time across a later reset. So: bind ONCE
 * per process, BEFORE any op is resolved.
 */
export function setAnalyzeApprovalAuthority(authority: ApprovalAuthority | undefined): void {
  sharedApproval = authority ?? DENY_ALL_APPROVALS;
}

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
  {
    name: 'analyze.renderAnalysisReport',
    inputSchema: RenderAnalysisReportInputSchema,
    // The store is composed at the importer (the ledger registry's
    // input-driven binding): the containment-checked path store over the
    // input's `dir`. No op wiring exists at registry module scope.
    importer: () =>
      Promise.all([import('./renderAnalysisReport.js'), import('./analysisStore.js')]).then(
        ([m, s]) =>
          m.makeRenderAnalysisReport((input) => s.pathAnalysisFileStore(input.dir)) as Op<
            unknown,
            unknown
          >,
      ),
  },
  {
    name: 'analyze.astGrepCodemod',
    inputSchema: AstGrepCodemodInputSchema,
    // The gates' subprocess runner + the path store over `dir`, composed at
    // the importer — no ast-grep dependency, no shipped rules: the rule
    // rides the input verbatim.
    importer: () =>
      Promise.all([
        import('./codemod/astGrep.js'),
        import('./analysisStore.js'),
        import('../gates/checkRunner.js'),
      ]).then(
        ([m, s, runner]) =>
          m.makeAstGrepCodemod(
            runner.subprocessRunCheck,
            (input) => s.pathAnalysisFileStore(input.dir),
            // The same authority binding as the two remediation ops below.
            // This entry is reachable by untrusted plan JSON, so binding it is
            // what closes the third A16 path: with deny-all (the default)
            // an `approved: true` plan input writes nothing, and no authority
            // is ever derived from the input.
            sharedApproval,
          ) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'analyze.agenticRemediation',
    inputSchema: AgenticRemediationInputSchema,
    // The DRIVER FACTORY mediates construction (ADR-0002 §2.5): the
    // importer binds the default factory (default binding: remediator →
    // the ai-sdk lane for every default provider; an unbound provider is a
    // 'config' throw the op maps to needs-human) and the op resolves its
    // 'remediator' request at the point of dispatch. The proposal schema
    // rides the invocation's outputSchema (the op renders it), so the
    // importer carries no schema and constructs no lane. A run is one
    // fresh invocation (I6). The op returns the driver's WorkerResult and
    // NEVER applies anything itself; its consumer decides outside the
    // autonomous path.
    importer: (wiring) =>
      import('./agenticRemediation.js').then(
        (m) =>
          m.makeAgenticRemediation(
            createDriverFactory(
              // Dispatch wiring (PR #238 review P2): the host's alias-notice
              // sink rides the factory config; absent (every library
              // caller), the library default — one stderr line — is
              // unchanged.
              wiring?.onDeprecatedAlias !== undefined
                ? { onDeprecatedAlias: wiring.onDeprecatedAlias }
                : {},
            ),
          ) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'analyze.applyRemediation',
    inputSchema: ApplyRemediationInputSchema,
    // The runner + the store with `dir` defaulted to the sidecar's
    // directory, composed at the importer. NEVER dispatched by the plan
    // runner's autonomous path: without { clusterId, approved: true } the
    // op refuses as needs-human (UC §1 row 9).
    importer: () =>
      Promise.all([
        import('./applyRemediation.js'),
        import('./analysisStore.js'),
        import('../gates/checkRunner.js'),
      ]).then(
        ([m, s, runner]) =>
          m.makeApplyRemediation(
            (input) => s.pathAnalysisFileStore(input.dir ?? dirname(input.sidecarPath)),
            runner.subprocessRunCheck,
            // The authority the write is authorized by — deny-all unless the
            // kernel bound one (see setAnalyzeApprovalAuthority). NEVER the
            // input's `approved` flag: that is a declared intent, not a proof.
            sharedApproval,
          ) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'analyze.playbookRegister',
    inputSchema: PlaybookRegisterInputSchema,
    // The playbook registry + quarantine ledger are SHARED, process-scoped
    // singletons (see the binding note above the array): a playbook
    // registered through THIS entry must be dispatchable through the
    // dispatch entry below, and both lazy bindings create-or-reuse the same
    // instances.
    importer: () =>
      Promise.all([import('./playbooks/registry.js'), import('./playbooks/quarantine.js')]).then(
        ([r, q]) => {
          sharedPlaybooks ??= r.makePlaybookRegistry();
          sharedQuarantine ??= q.makeQuarantineLedger();
          return r.makePlaybookRegisterOp(sharedPlaybooks) as Op<unknown, unknown>;
        },
      ),
  },
  {
    name: 'analyze.playbookDispatch',
    inputSchema: PlaybookDispatchInputSchema,
    // The shared registry + ledger (the quarantine consult MUST see what a
    // sibling dispatch recorded), the gates' subprocess runner (engine
    // scans AND verifier commands), and the containment-checked path store
    // over `input.dir` — composed at the importer. NEVER in the shipped
    // analyze plan: the plan runner's autonomous path cannot dispatch a
    // playbook (UC §1 row 9; see src/plans/analyze.ts).
    importer: () =>
      Promise.all([
        import('./playbooks/registry.js'),
        import('./playbooks/quarantine.js'),
        import('./analysisStore.js'),
        import('../gates/checkRunner.js'),
      ]).then(([r, q, s, runner]) => {
        sharedPlaybooks ??= r.makePlaybookRegistry();
        sharedQuarantine ??= q.makeQuarantineLedger();
        return r.makePlaybookDispatchOp({
          playbooks: sharedPlaybooks,
          quarantine: sharedQuarantine,
          run: runner.subprocessRunCheck,
          storeFor: (input) => s.pathAnalysisFileStore(input.dir),
          // Deny-all unless the kernel bound a verified authority — the
          // dispatch's write is authorized by the grant this exercises, never
          // by anything in the op input.
          approval: sharedApproval,
        }) as Op<unknown, unknown>;
      }),
  },
  {
    name: 'analyze.playbookQuarantineList',
    inputSchema: PlaybookQuarantineListInputSchema,
    // The shared ledger's read-only view — the same instance the dispatch
    // entry writes through, so the list is exactly what fail-closed
    // dispatch consults.
    importer: () =>
      Promise.all([import('./playbooks/registry.js'), import('./playbooks/quarantine.js')]).then(
        ([r, q]) => {
          sharedQuarantine ??= q.makeQuarantineLedger();
          return r.makePlaybookQuarantineListOp(sharedQuarantine) as Op<unknown, unknown>;
        },
      ),
  },
];
