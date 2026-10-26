import { defaultHarnessConfig } from '../../harness/config.js';
import type { DiffSecretScanner, ScanComponentInput } from '../dev/denylist.js';
import { partitionReview, type ReviewCoverage } from './internal/reviewPartitions.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { toOutputSchema } from '../../driver/common/structured.js';
import { boundedErrorText } from '../../driver/error-text.js';
import type { DriverFactory } from '../../driver/factory.js';
import type { WorkerResult } from '../../driver/types.js';
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

export interface AgentReviewerInput {
  repoRoot: string;
  head: string;
  branch: string;
  diff: string;
  components?: readonly ScanComponentInput[];
  base?: string;
  scope?: 'full' | 'uncommitted';
  scanSecrets: DiffSecretScanner;
  role: { provider: string; model: string };
  maxTokens: number;
  wallMs: number;
  searchTools?: boolean;
  signal?: AbortSignal;
  severityMap: { high: string; medium: string; low?: string };
}

/** Read-only structured review through the configured reviewer role. */
async function runPartition(
  drivers: DriverFactory,
  input: AgentReviewerInput & {
    receipt: string;
    onUsage: (usage: number) => void;
    onRequest: (serializedChars: number, decodedChars: number) => void;
  },
): Promise<
  OpResult<{ findings: Finding[]; usage: number }> & {
    /** Driver-observed capability evidence + advisories, when the driver surfaced them. */
    capabilities?: WorkerResult['capabilities'];
    advisories?: string[];
  }
> {
  if (input.signal?.aborted || currentJobContext()?.signal.aborted)
    return { status: 'needs-human', reason: 'agent review cancelled before dispatch' };
  let resolved: ReturnType<DriverFactory['resolve']>;
  try {
    resolved = drivers.resolve({
      role: 'reviewer',
      modelSpec: input.role,
      harness: defaultHarnessConfig,
      beforeRequest: async (text, contents = []) => {
        input.signal?.throwIfAborted();
        input.onRequest(
          text.length,
          contents.reduce((total, content) => total + content.text.length, 0),
        );
        await scanComplete(input.scanSecrets, [
          { component: 'request', path: 'review-request.json', text },
          ...contents.map((content, index) => ({
            component: `request-content-${index}`,
            path: content.path ?? 'review-request.json',
            text: content.text,
          })),
        ]);
        input.signal?.throwIfAborted();
      },
    });
  } catch (error) {
    return {
      status: 'needs-human',
      reason: `agent review could not dispatch: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const invocation: OpInvocation = {
    prompt: input.diff,
    modelSpec: resolved.modelSpec,
    toolPolicy: {
      mode: 'allowlist',
      allow: input.searchTools === false ? ['read'] : ['read', 'grep', 'glob'],
    },
    sandboxPolicy: { level: 'read-only' },
    workspace: { path: resolve(input.repoRoot) },
    budget: { maxTokens: input.maxTokens },
    outputSchema: toOutputSchema(
      'review.agent/v2',
      OutputSchema.extend({ receipt: z.literal(input.receipt) }),
    ),
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
  input.onUsage(
    result.usage.input +
      result.usage.output +
      result.usage.cacheRead +
      result.usage.cacheWrite +
      (result.usage.reasoning ?? 0),
  );
  // rg capability seam: ONE evidence object spread into EVERY post-settle
  // return (budget / needs-human / invalid / success) — no return drops it.
  const evidence = {
    ...(result.capabilities === undefined ? {} : { capabilities: result.capabilities }),
    ...(result.advisories === undefined ? {} : { advisories: result.advisories }),
  };
  if (result.stopReason !== 'complete') {
    if (result.stopReason === 'budget') return { status: 'budget-exhausted', ...evidence };
    // #484: carry the driver's failure detail (bounded + secret-redacted at
    // the seam) into the blocked reason the review log records — a bare
    // stop reason sent operators to the raw session log to find the cause.
    const detail = result.error === undefined ? '' : `: ${boundedErrorText(result.error)}`;
    return {
      status: 'needs-human',
      reason: `agent review did not complete (${result.stopReason})${detail}`,
      ...evidence,
    };
  }
  const parsed = OutputSchema.extend({ receipt: z.literal(input.receipt) }).safeParse(
    result.structuredOutput,
  );
  if (!parsed.success)
    return {
      status: 'failed',
      error: 'agent review returned invalid structured output',
      ...evidence,
    };
  return {
    status: 'ok',
    ...evidence,
    value: {
      usage:
        result.usage.input +
        result.usage.output +
        result.usage.cacheRead +
        result.usage.cacheWrite +
        (result.usage.reasoning ?? 0),
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

export interface AgentReviewReport {
  findings: Finding[];
  usage: number;
  coverage: ReviewCoverage;
  /**
   * Non-fatal run notes folded from the driver results (rg capability
   * seam): deduplicated, evidence-adjacent, never a verdict change. Present
   * only when a driver observed something worth surfacing.
   */
  advisories?: string[];
  /**
   * The driver capability evidence behind the advisories (rg seam), when any
   * partition's driver observed it. One record — every partition probes the
   * same host, so the last observation wins; consumers needing per-partition
   * detail read the session log.
   */
  capabilities?: WorkerResult['capabilities'];
}
export type AgentReviewResult = OpResult<AgentReviewReport> & {
  report?: AgentReviewReport;
  /** rg capability seam: evidence rides the top level too when a partition's driver observed it (failed returns carry it via runPartition). */
  capabilities?: WorkerResult['capabilities'];
  advisories?: string[];
};

async function scanComplete(
  scanner: DiffSecretScanner,
  components: readonly ScanComponentInput[],
): Promise<void> {
  const verdicts = await scanner(components);
  if (
    verdicts.length !== components.length ||
    new Set(verdicts.map((v) => v.component)).size !== components.length ||
    components.some((c) => !verdicts.some((v) => v.component === c.component)) ||
    verdicts.some((v) => v.hits.length > 0)
  )
    throw new Error(
      'agent review upload refused: protected content or incomplete scanner verdicts',
    );
}

/** Complete, bounded read-only review; every validated partition consumes the same budgets. */
export async function runAgentReviewer(
  drivers: DriverFactory,
  input: AgentReviewerInput,
): Promise<AgentReviewResult> {
  const signals = [input.signal, currentJobContext()?.signal].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  if (signals.some((s) => s.aborted))
    return { status: 'needs-human', reason: 'agent review cancelled before dispatch' };
  const controller = new AbortController();
  const parent = AbortSignal.any(signals);
  const relay = () => controller.abort(parent.reason);
  parent.addEventListener('abort', relay, { once: true });
  const deadline = Date.now() + input.wallMs;
  const ensureActive = () => {
    controller.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('agent review wall budget exhausted');
  };
  let report: AgentReviewReport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: (() => void) | undefined;
  try {
    const work = async (): Promise<AgentReviewResult> => {
      const originals = input.components ?? [
        { component: 'diff', path: 'review.diff', text: input.diff },
      ];
      const components = (
        originals.length
          ? originals
          : [{ component: 'empty-comparison', path: 'review.diff', text: '' }]
      ).map((component) => Object.freeze({ ...component }));
      if (new Set(components.map((c) => c.component)).size !== components.length)
        throw new Error('agent review component identities must be unique');
      const plan = partitionReview({
        head: input.head,
        base: input.base ?? input.head,
        scope: input.scope ?? 'full',
        components,
      });
      report = { findings: [], usage: 0, coverage: plan.coverage };
      if (plan.partitions.length === 0) throw new Error('agent review has no coverage partitions');
      await scanComplete(input.scanSecrets, components);
      for (const [index, part] of plan.partitions.entries()) {
        ensureActive();
        if (report.usage >= input.maxTokens) return { status: 'budget-exhausted', report };
        await scanComplete(input.scanSecrets, [
          { component: 'partition', path: 'review-request.txt', text: part.prompt },
        ]);
        ensureActive();
        const result = await runPartition(drivers, {
          ...input,
          components,
          diff: part.prompt,
          receipt: part.receipt,
          signal: controller.signal,
          maxTokens: input.maxTokens - report.usage,
          wallMs: Math.max(1, deadline - Date.now()),
          onUsage: (usage) => {
            report!.usage += usage;
          },
          onRequest: (serializedChars, decodedChars) => {
            report!.coverage.partitions[index]!.requests.push({ serializedChars, decodedChars });
          },
        });
        ensureActive();
        // rg capability seam: fold the partition's driver-observed evidence
        // into the report — advisories deduplicated, capabilities last-wins
        // (every partition probes the same host). Blocked results keep the
        // evidence too: the fold precedes the blocked return so a withheld
        // search tool is visible even on a run that did not complete.
        if (result.capabilities !== undefined) report.capabilities = result.capabilities;
        if (result.advisories !== undefined)
          report.advisories = [...new Set([...(report.advisories ?? []), ...result.advisories])];
        if (result.status !== 'ok') return { ...result, report };
        for (const finding of result.value.findings) {
          const same = (other: Finding) =>
            other.file === finding.file &&
            other.line === finding.line &&
            other.rule === finding.rule &&
            other.text === finding.text &&
            other.severity === finding.severity;
          if (!report.findings.some(same))
            report.findings.push({ ...finding, id: `agent-${index + 1}-${finding.id}` });
        }
        report.coverage.partitions[index]!.complete = true;
        if (report.usage > input.maxTokens) return { status: 'budget-exhausted', report };
      }
      return { status: 'ok', value: report };
    };
    const stopped = new Promise<never>((_resolve, reject) => {
      cancelled = () => reject(new Error('agent review cancelled or wall budget exhausted'));
      controller.signal.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(
        () => controller.abort(new Error('agent review wall budget exhausted')),
        Math.max(0, input.wallMs),
      );
    });
    return await Promise.race([work(), stopped]);
  } catch (error) {
    return {
      status: 'needs-human',
      reason: `agent review did not run: ${error instanceof Error ? error.message : String(error)}`,
      ...(report === undefined ? {} : { report }),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener('abort', relay);
    if (cancelled !== undefined) controller.signal.removeEventListener('abort', cancelled);
  }
}
