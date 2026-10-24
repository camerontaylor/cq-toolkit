import { resolve } from 'node:path';
import { z } from 'zod';
import { toOutputSchema } from '../../driver/common/structured.js';
import type { DriverFactory } from '../../driver/factory.js';
import type { OpInvocation } from '../../driver/types.js';
import type { OpResult } from '../../kernel/types.js';
import { currentJobContext } from '../../kernel/governor.js';
import type { Finding } from './findings.js';

const OutputSchema = z
  .object({
    findings: z.array(
      z
        .object({
          file: z.string().optional(),
          line: z.number().int().positive().optional(),
          rule: z.string().optional(),
          severity: z.enum(['high', 'medium', 'low']),
          text: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
const outputSchema = toOutputSchema('review.agent/v1', OutputSchema);

export interface AgentReviewerInput {
  repoRoot: string;
  head: string;
  branch: string;
  diff: string;
  role: { provider: string; model: string };
  maxTokens: number;
  wallMs: number;
  signal?: AbortSignal;
  severityMap: { high: string; medium: string; low?: string };
}

/** Read-only structured review through the configured reviewer role. */
export async function runAgentReviewer(
  drivers: DriverFactory,
  input: AgentReviewerInput,
): Promise<OpResult<{ findings: Finding[]; usage: number }>> {
  if (input.signal?.aborted || currentJobContext()?.signal.aborted)
    return { status: 'needs-human', reason: 'agent review cancelled before dispatch' };
  let resolved: ReturnType<DriverFactory['resolve']>;
  try {
    resolved = drivers.resolve({ role: 'reviewer', modelSpec: input.role });
  } catch (error) {
    return {
      status: 'needs-human',
      reason: `agent review could not dispatch: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const invocation: OpInvocation = {
    prompt: `Review the supplied repository diff for actionable defects. Do not propose speculative style changes. Return only structured findings with repository-relative file, line, concise rule, severity (high, medium, or low), and evidence-based text.\n\n${input.diff}`,
    modelSpec: resolved.modelSpec,
    toolPolicy: { mode: 'none', allow: [] },
    sandboxPolicy: { level: 'read-only' },
    workspace: { path: resolve(input.repoRoot) },
    budget: { maxTokens: input.maxTokens },
    outputSchema,
  };
  let result: Awaited<ReturnType<typeof resolved.driver.run>>;
  const controller = new AbortController();
  const signals = [input.signal, currentJobContext()?.signal].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  const parentSignal = signals.length ? AbortSignal.any(signals) : undefined;
  const relayAbort = () => controller.abort(parentSignal?.reason);
  const rejectCancelled = () => new Error('agent review cancelled by parent job');
  let cancelReview: (() => void) | undefined;
  if (parentSignal?.aborted) relayAbort();
  else parentSignal?.addEventListener('abort', relayAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(
          new Error(`agent review exceeded ${String(input.wallMs)}ms wall deadline`),
        );
        reject(new Error(`agent review exceeded ${String(input.wallMs)}ms wall deadline`));
      }, input.wallMs);
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (parentSignal?.aborted) reject(rejectCancelled());
      else if (parentSignal !== undefined) {
        cancelReview = () => reject(rejectCancelled());
        parentSignal.addEventListener('abort', cancelReview, { once: true });
      }
    });
    result = await Promise.race([
      resolved.driver.run(invocation, { signal: controller.signal }),
      timed,
      cancelled,
    ]);
  } catch (error) {
    return {
      status: 'needs-human',
      reason: `agent review did not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', relayAbort);
    if (cancelReview !== undefined) parentSignal?.removeEventListener('abort', cancelReview);
  }
  currentJobContext()?.reportResult({
    usage: result.usage,
    ...(result.costUSD === undefined ? {} : { costUSD: result.costUSD }),
  });
  if (result.stopReason !== 'complete') {
    return result.stopReason === 'budget'
      ? { status: 'budget-exhausted' }
      : { status: 'needs-human', reason: `agent review did not complete (${result.stopReason})` };
  }
  const parsed = OutputSchema.safeParse(result.structuredOutput);
  if (!parsed.success)
    return { status: 'failed', error: 'agent review returned invalid structured output' };
  return {
    status: 'ok',
    value: {
      usage: result.usage.input + result.usage.output,
      findings: parsed.data.findings.map((item, index) => ({
        id: `agent-${index + 1}`,
        source: 'agent',
        ...(item.file ? { file: item.file } : {}),
        ...(item.line ? { line: item.line } : {}),
        ...(item.rule ? { rule: item.rule } : {}),
        severity: input.severityMap[item.severity] ?? 'minor',
        text: item.text,
        status: 'open' as const,
      })),
    },
  };
}
