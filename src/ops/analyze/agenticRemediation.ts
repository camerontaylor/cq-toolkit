// Analyze lane G3 — agentic remediation through the DRIVER SEAM: the
// remediation path for clusters no mechanical rule can fix (the codemod
// path, analyze.astGrepCodemod / analyze.applyRemediation, owns the
// mechanical ones). Minimal v1 — this is the seam proof, not a product:
// the op derives a PROMPT deterministically from the cluster evidence,
// builds one frozen OpInvocation (src/driver/types.ts), runs it through
// the injected Driver, and returns the WorkerResult. That is ALL it does.
//
// Invariants honored here:
//   - The op NEVER applies anything itself: it carries no file seam, no
//     writer, no fixer — the WorkerResult comes back to the CALLER, who
//     decides what to do with it outside this op (and outside the plan
//     runner's autonomous path — G3 never dispatches remediation). The
//     invocation DEFAULTS to toolPolicy mode 'none' and sandbox
//     'read-only', so even a misbehaving consumer prompt cannot mutate the
//     workspace through this seam. WIDENING beyond read-only is an
//     APPROVAL-GATED decision like every other write path in this family:
//     a write-capable policy (tool mode ≠ 'none' OR sandbox level ≠
//     'read-only') is refused as `needs-human` unless the input carries
//     approved: true — "the caller widened it" is the decision, and the
//     decision carries a human flag.
//   - Determinism where the op owns it: the prompt is a pure function of
//     the cluster (members in report order, the canonical signature, the
//     confidence), with no clocks and no randomness. The MODEL's answer is
//     of course non-deterministic — that is exactly why this path is
//     agentic (per-cluster adopt-vs-build verdict: src/ops/analyze/NOTES.md,
//     which rejected model-driven CLUSTERING on the same determinism
//     grounds; remediation PROPOSALS are the deliberate, human-gated
//     exception the seam exists for).
//   - Honest result taxonomy over the driver's stop reasons (I9/I8): a
//     driver-level `error` is `failed`; a `budget` stop is
//     `budget-exhausted` (an honest stop, never fabricated as passed); an
//     `aborted` run is `indeterminate` (no verdict on partial work — the
//     frozen taxonomy's crash class); `complete` is `ok` with the
//     WorkerResult verbatim. A driver whose run() REJECTS never produced a
//     WorkerResult — `indeterminate`. And a factory built with NO driver
//     is `failed` naming the missing wiring — the missing driver surfaces
//     honestly, never as a fabricated run.
//   - I8 (rescue/escalation live in the runner): the driver executes ONE
//     invocation; this op adds no retries, no rescue, no session policy
//     beyond the caller-supplied sessionRef passthrough.
import type {
  Budget,
  Driver,
  ModelSpec,
  OpInvocation,
  SandboxPolicy,
  ToolPolicy,
  WorkerResult,
} from '../../driver/types.js';
import { z } from 'zod';
import type { Op } from '../../kernel/types.js';
import type { Cluster } from './clusterErrors.js';

/**
 * The remediation PROPOSAL the worker must return as structured output —
 * the op's entire purpose is obtaining one, so the bound driver carries
 * this schema (a plain-data request: `summary` required; `patch` carried
 * when the proposal is a concrete mechanical edit).
 */
export interface AgenticProposal {
  /** What the cluster is and the proposed fix, in prose. */
  summary: string;
  /** The concrete edit (unified diff or patch text), when the proposal is mechanical. */
  patch?: string;
}

/**
 * The zod form of {@link AgenticProposal}, bound into the registry's driver
 * construction (`new SubprocessDriver({ outputSchema: AGENTIC_PROPOSAL_SCHEMA })`):
 * the subprocess lane serializes it to `--json-schema` and validates the
 * settle-time structured_output against it before it lands in
 * `WorkerResult.structuredOutput` — so a dispatched run's ok result carries
 * the proposal. It is a REQUEST the DRIVER enforces, not something the op
 * can guarantee across lanes: a driver that cannot enforce schemas returns
 * a WorkerResult WITHOUT structuredOutput, and the ok result passes that
 * through verbatim (honest absence, never a fabricated proposal).
 */
export const AGENTIC_PROPOSAL_SCHEMA: z.ZodType<AgenticProposal> = z
  .object({
    summary: z.string().min(1),
    patch: z.string().min(1).exactOptional(),
  })
  .strict();

/** JSON-serializable input of the `analyze.agenticRemediation` op. */
export interface AgenticRemediationInput {
  /**
   * The cluster's stable id. Must EQUAL `cluster.id` (validated at the op
   * boundary — a mismatch is a `failed` result, the same fail-closed shape
   * as applyRemediation's unknown-cluster fault): the id only ever RIDES THE
   * DETERMINISTIC PROMPT, not a separate invocation field.
   */
  clusterId: string;
  /** The cluster to remediate (the sidecar/report's cluster, members in report order). */
  cluster: Cluster;
  /** Which model to ask (plain data — a model string + provider handle, never an SDK object). */
  modelSpec: ModelSpec;
  /**
   * Tool policy for the worker. NORMALIZED: an absent policy — or a policy
   * with the mode OMITTED (which the frozen seam would read as 'allowlist')
   * — is carried into the invocation as mode 'none' EXPLICITLY, so the
   * worker proposes and cannot touch the workspace. An EXPLICIT widen (any
   * explicit mode beyond 'none') is APPROVAL-GATED: refused as `needs-human`
   * unless {@link approved} is true.
   */
  toolPolicy?: ToolPolicy;
  /**
   * Sandbox preference. NORMALIZED: an absent policy or level is carried
   * into the invocation as 'read-only' EXPLICITLY; widening beyond it is
   * approval-gated (see {@link toolPolicy}).
   */
  sandboxPolicy?: SandboxPolicy;
  /** Budget caps for the one invocation; the driver enforces what it can locally. */
  budget?: Budget;
  /** Opaque driver session handle for multi-turn continuation, when supported. */
  sessionRef?: string;
  /**
   * Explicit human approval for a WRITE-CAPABLE policy (tool mode ≠ 'none'
   * OR sandbox level ≠ 'read-only'). Irrelevant for the read-only defaults,
   * which need no approval.
   */
  approved?: boolean;
}

/**
 * The deterministic invocation prompt: a pure function of the cluster —
 * id, tool, rule, confidence, the canonical signature, and every member in
 * report order. The worker is asked for a PROPOSAL only (it returns
 * structuredOutput; it changes nothing) — the human approval gate stays
 * upstream of any application, exactly as in the codemod path.
 */
export function agenticRemediationPrompt(input: AgenticRemediationInput): string {
  const { cluster } = input;
  const lines: string[] = [
    `You are proposing a remediation for one cluster of static-analysis failures.`,
    `Propose ONLY: do not modify any file; return your proposal as structured output.`,
    '',
    `cluster id: ${input.clusterId}`,
    `tool: ${cluster.tool}`,
    `ruleId: ${cluster.ruleId ?? '(none attributed)'}`,
    `confidence: ${cluster.confidence}`,
    `members: ${cluster.size}`,
    `signature: ${cluster.signature}`,
    '',
    'member failures (exact report order):',
  ];
  for (const failure of cluster.failures) {
    lines.push(
      `- ${failure.file ?? '-'}:${failure.line ?? '-'}:${failure.column ?? '-'} [${failure.severity}] ${failure.ruleId ?? '-'}: ${failure.message}`,
    );
  }
  lines.push(
    '',
    'Respond with a remediation proposal: the mechanical rule (if any), the exact',
    'edits it would produce, the risk of applying it blind, and whether you recommend',
    'a human look at the cluster first.',
  );
  return lines.join('\n');
}

/**
 * Build the `analyze.agenticRemediation` op over ONE injected driver. Per
 * call: assemble the frozen OpInvocation from the cluster context and the
 * input's plain-data policies, run it to completion, and map the outcome
 * onto the frozen taxonomy (see the module header). No state is kept
 * between calls; every invocation is fresh (I6).
 */
export function makeAgenticRemediation(
  driver: Driver | undefined,
): Op<AgenticRemediationInput, WorkerResult> {
  return async (input) => {
    // The id must name THE cluster it travels with — a mismatch would put
    // one cluster's evidence under another cluster's identity in the prompt.
    if (input.clusterId !== input.cluster.id) {
      return {
        status: 'failed',
        error: `agentic remediation: clusterId '${input.clusterId}' does not match cluster.id '${input.cluster.id}' — pass the cluster's own id`,
      };
    }
    // POLICY NORMALIZATION (the gate's belief must be what actually
    // executes): the FROZEN seam reads an OMITTED toolPolicy.mode as
    // 'allowlist' (driver/types.ts — and the shipped SubprocessDriver
    // enforces exactly that), so an input like { allow: ['Edit'] } with no
    // mode would otherwise clear a 'none'-reading gate while executing WITH
    // the Edit tool exposed. The op therefore NORMALIZES: an absent policy
    // or absent mode becomes mode 'none' EXPLICITLY, and an absent sandbox
    // level becomes 'read-only' EXPLICITLY — the invocation below carries
    // the normalized objects, so the driver enforces precisely what this
    // gate judged.
    const toolPolicy: ToolPolicy = {
      allow: input.toolPolicy?.allow ?? [],
      mode: input.toolPolicy?.mode ?? 'none',
    };
    const sandboxPolicy: SandboxPolicy = {
      level: input.sandboxPolicy?.level ?? 'read-only',
    };
    // WRITE-POLICY APPROVAL GATE: the normalized read-only, tool-less
    // defaults propose freely, but a caller EXPLICITLY WIDENING the
    // invocation past them (any explicit mode — allowlist reads as
    // allowlist now that normalization removed the ambiguity — or
    // unrestricted, or a sandbox beyond read-only) is a write-cap decision
    // on this family's one budget — refused as `needs-human` unless the
    // explicit approval flag rides the input (the same defense this family
    // applies to the codemod path; "the caller widened it" is the decision,
    // and the decision needs a human flag).
    const writeCapable = toolPolicy.mode !== 'none' || sandboxPolicy.level !== 'read-only';
    if (writeCapable && input.approved !== true) {
      return {
        status: 'needs-human',
        reason: `agentic remediation with a write-capable policy (tool mode '${toolPolicy.mode}', sandbox '${sandboxPolicy.level}') is an approval-gated decision — pass approved: true, or keep the read-only defaults (tool mode 'none', sandbox 'read-only')`,
      };
    }
    if (driver === undefined) {
      return {
        status: 'failed',
        error:
          'agentic remediation: no driver is wired — the op refuses to fabricate a run; wire a Driver through makeAgenticRemediation',
      };
    }
    const invocation: OpInvocation = {
      prompt: agenticRemediationPrompt(input),
      modelSpec: input.modelSpec,
      toolPolicy,
      sandboxPolicy,
      ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
      budget: input.budget ?? {},
    };
    let result: WorkerResult;
    try {
      result = await driver.run(invocation);
    } catch (err) {
      return {
        status: 'indeterminate',
        detail: `agentic remediation: the driver crashed before a WorkerResult existed — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    switch (result.stopReason) {
      case 'complete':
        return { status: 'ok', value: result };
      case 'error':
        return {
          status: 'failed',
          error: `agentic remediation: the driver reported a run error (model ${input.modelSpec.model})`,
        };
      case 'budget':
        // The honest stop: the invocation halted on a locally-enforced cap.
        // Nothing is fabricated — the partial WorkerResult is DISCARDED as
        // evidence (its usage may be untrustworthy mid-flight) and the stop
        // is what the caller sees.
        return { status: 'budget-exhausted' };
      case 'aborted':
        return {
          status: 'indeterminate',
          detail:
            'agentic remediation: the run was aborted before completion — no verdict on partial work',
        };
    }
  };
}
