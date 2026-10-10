// Zod mirrors of the frozen driver-seam types — seam v2 (ADR-0002).
//
// The hand-written types in ./types.js are the single source of truth; these
// zod v4 schemas mirror the seam's serializable parts (everything except the
// `Driver` interface) for serializability tests, journal parsing, and the
// shipped conformance suite. The kernel's schema module re-exports every
// name here, so the public mirror surface is unchanged; the seam block lives
// in the driver family because the one-directional seam rule (src/driver
// never imports src/kernel) binds the conformance suite too.
//
// Freeze check (one-directional, per the freeze contract): every schema is
// annotated `z.ZodType<Frozen>`, so the schema's inferred OUTPUT must be
// assignable to the hand-written frozen type — a schema that drifts loose
// fails typecheck. Full two-way checking is awkward in zod v4, so the
// one-directional guarantee is the accepted one.
//
// Every persisted-shape schema is `.strict()`: objects carrying extra keys
// (for instance a key named for a vendor message type) FAIL parsing instead
// of being silently stripped. This backs the vendor-vocabulary frozen claim
// exercised in test/kernel/types.test.ts.
import { z } from 'zod';
import type {
  Budget,
  DriverStopReason,
  ModelSpec,
  OpInvocation,
  OutputSchema,
  ProviderSignals,
  SandboxLevel,
  SandboxPolicy,
  ToolDenial,
  ToolPolicy,
  ToolPolicyMode,
  Usage,
  WorkerErrorClass,
  WorkerResult,
  WorkspaceBinding,
} from './types.js';

export const UsageSchema: z.ZodType<Usage> = z
  .object({
    // Mirror-only tightening (review-debt #17, PR #7 Major/P2): token counts
    // are cardinalities — non-negative integers. The frozen Usage type is
    // untouched; a negative or fractional count is malformed at the mirror
    // exactly like the CLI lanes' own wire gates.
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative().exactOptional(),
  })
  .strict();

export const DriverStopReasonSchema: z.ZodType<DriverStopReason> = z.enum([
  'complete',
  'aborted',
  'budget',
  'error',
]);

export const ModelSpecSchema: z.ZodType<ModelSpec> = z
  .object({
    model: z.string(),
    provider: z.string(),
  })
  .strict();

export const ToolPolicyModeSchema: z.ZodType<ToolPolicyMode> = z.enum([
  'allowlist',
  'unrestricted',
  'none',
]);

export const ToolPolicySchema: z.ZodType<ToolPolicy> = z
  .object({
    allow: z.array(z.string()),
    mode: ToolPolicyModeSchema.exactOptional(),
  })
  .strict();

export const SandboxLevelSchema: z.ZodType<SandboxLevel> = z.enum([
  'none',
  'workspace-write',
  'read-only',
]);

export const SandboxPolicySchema: z.ZodType<SandboxPolicy> = z
  .object({
    level: SandboxLevelSchema,
  })
  .strict();

export const BudgetSchema: z.ZodType<Budget> = z
  .object({
    // Mirror-only tightening (review-debt #17): a negative USD cap is
    // malformed — the frozen RunOptions type is untouched.
    maxUsd: z.number().nonnegative().exactOptional(),
    maxTokens: z.number().exactOptional(),
    wallClockMs: z.number().exactOptional(),
    maxAttempts: z.number().exactOptional(),
  })
  .strict();

export const ToolDenialSchema: z.ZodType<ToolDenial> = z
  .object({
    tool: z.string(),
    reason: z.string(),
  })
  .strict();

// Seam v2 (ADR-0002 §2.1/§2.8): the structured-output request and the
// workspace binding ride the invocation, so the strict mirror gains them.
// `JsonSchema` mirrors as a record of unknown — plain data, no external $ref.

export const OutputSchemaSchema: z.ZodType<OutputSchema> = z
  .object({
    name: z.string(),
    schema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const WorkspaceBindingSchema: z.ZodType<WorkspaceBinding> = z
  .object({
    path: z.string(),
  })
  .strict();

export const OpInvocationSchema: z.ZodType<OpInvocation> = z
  .object({
    prompt: z.string(),
    modelSpec: ModelSpecSchema,
    toolPolicy: ToolPolicySchema,
    sandboxPolicy: SandboxPolicySchema,
    sessionRef: z.string().exactOptional(),
    budget: BudgetSchema,
    outputSchema: OutputSchemaSchema.exactOptional(),
    workspace: WorkspaceBindingSchema.exactOptional(),
  })
  .strict();

export const WorkerErrorClassSchema: z.ZodType<WorkerErrorClass> = z.enum([
  'output-invalid',
  'served-model-mismatch',
  'transient',
  'rate-limit',
  'quota',
  'auth',
  'provider-error',
  'harness',
  'unknown',
]);

export const ProviderSignalsSchema: z.ZodType<ProviderSignals> = z
  .object({
    // Issue #242: a retry delay is never negative — the same tightening the
    // window rows below received (PR #238 review round 2), applied to the
    // top-level field. Both producers floor at 0.
    retryAfterMs: z.number().nonnegative().exactOptional(),
    windows: z
      .array(
        z
          .object({
            // Window-value bounds (PR #238 review round 2): the same rows the
            // shipped conformance suite asserts per result
            // (src/driver/conformance.ts) and the ProviderSignals doc states —
            // nonempty ids, utilization 0–1, integral nonnegative remaining
            // counts, parseable reset instants. Malformed quota evidence must
            // not parse through the strict mirror as validated data.
            id: z.string().min(1),
            utilization: z.number().min(0).max(1).exactOptional(),
            remaining: z
              .object({
                requests: z.number().int().nonnegative().exactOptional(),
                tokens: z.number().int().nonnegative().exactOptional(),
              })
              .strict()
              .exactOptional(),
            resetAt: z
              .string()
              .refine((value) => !Number.isNaN(Date.parse(value)), {
                error: 'must be a parseable instant',
              })
              .exactOptional(),
          })
          .strict(),
      )
      .exactOptional(),
  })
  .strict();

export const WorkerResultSchema: z.ZodType<WorkerResult> = z
  .object({
    model: z.string().exactOptional(),
    structuredOutput: z.unknown().optional(),
    usage: UsageSchema,
    costUSD: z.number().exactOptional(),
    costBasis: z.enum(['modeled', 'billed']).exactOptional(),
    sessionId: z.string().exactOptional(),
    denials: z.array(ToolDenialSchema),
    // Mirror-only tightening: the frozen doc says "message", not "non-empty" — and the producer bound is 500 chars plus the 13-char '… [truncated]' marker from PR-B's error-text.ts, so the mirror allows 513.
    error: z.string().min(1).max(513).exactOptional(),
    // Seam v2 (ADR-0002 §2.2): structured failure class on an error verdict,
    // and provider limit observations on ANY verdict.
    errorClass: WorkerErrorClassSchema.exactOptional(),
    providerSignals: ProviderSignalsSchema.exactOptional(),
    stopReason: DriverStopReasonSchema,
  })
  .strict()
  // DD-9 cost pairing, wire schema only: costBasis is present EXACTLY when
  // costUSD is — a priced result carries both, an unpriced result carries
  // neither. Mirror-only tightening (same recorded precedent as the
  // RunOptions bounds): the frozen WorkerResult type is untouched — the
  // type-level half of this coupling is a post-freeze note.
  .superRefine((result, ctx) => {
    if (result.costUSD !== undefined && result.costBasis === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'costBasis is required when costUSD is present',
        path: ['costBasis'],
      });
    }
    if (result.costUSD === undefined && result.costBasis !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'costBasis must be omitted when costUSD is absent',
        path: ['costBasis'],
      });
    }
    // Mirror the frozen type's documented contract: `error` rides only a
    // driver-level failure verdict (stopReason 'error').
    if (result.error !== undefined && result.stopReason !== 'error') {
      ctx.addIssue({
        code: 'custom',
        message: "error is only allowed when stopReason is 'error'",
        path: ['error'],
      });
    }
    // Seam v2 (ADR-0002 §2.2), ONE-DIRECTIONAL wire rule, same pattern as
    // `error` above: `errorClass` present ⇒ the verdict is 'error'. An
    // 'error' verdict WITHOUT a class still parses, so v1 records and
    // pre-S3 producers stay valid (the producer rule — every v2 error
    // verdict CARRIES a class — is a conformance obligation, not a mirror
    // constraint).
    if (result.errorClass !== undefined && result.stopReason !== 'error') {
      ctx.addIssue({
        code: 'custom',
        message: "errorClass is only allowed when stopReason is 'error'",
        path: ['errorClass'],
      });
    }
  });
