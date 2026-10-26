import { defaultHarnessConfig } from '../../harness/config.js';
import type { DiffSecretScanner, ScanComponentInput } from '../dev/denylist.js';
import { partitionReview, type ReviewCoverage } from './internal/reviewPartitions.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { toOutputSchema } from '../../driver/common/structured.js';
import type { DriverFactory } from '../../driver/factory.js';
import type { OpInvocation } from '../../driver/types.js';
import type { OpResult } from '../../kernel/types.js';
import { currentJobContext } from '../../kernel/governor.js';
import type { Finding } from './findings.js';

// A finding item STRIPS unknown keys (S7 attempt G: one GLM finding carried
// `rule_id_hint` and the strict item blocked the whole review); every field
// check and the required severity/text still hold, and the top level stays
// strict with its receipt. The emitted contract therefore leaves item
// `additionalProperties` open: the driver validates the reply against the
// SAME document it sent (ADR-0002 §2.3), so a closed item in the contract
// would reject the extra key before this parse could strip it.
const FindingItemSchema = z.object({
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  rule: z.string().optional(),
  severity: z.enum(['high', 'medium', 'low']),
  text: z.string().min(1),
});
const FINDING_KEYS = new Set(Object.keys(FindingItemSchema.shape));
const OutputSchema = z.object({ findings: z.array(FindingItemSchema) }).strict();

/** Count the extra finding keys the parse strips, so tolerance stays visible. */
function strippedFindingKeys(raw: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  const findings = (raw as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) return counts;
  for (const item of findings as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    for (const key of Object.keys(item))
      if (!FINDING_KEYS.has(key)) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

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
  /** cq.json `budgets.step.wallMs`: the per-request step bound, capped at the remaining `wallMs`. */
  stepWallMs?: number;
  signal?: AbortSignal;
  severityMap: { high: string; medium: string; low?: string };
}

/** Collapse driver error text to one bounded line for a record reason. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ERROR_DETAIL_CHARS ? `${flat.slice(0, ERROR_DETAIL_CHARS)}…` : flat;
}
const ERROR_DETAIL_CHARS = 500;

/** Read-only structured review through the configured reviewer role. */
async function runPartition(
  drivers: DriverFactory,
  input: AgentReviewerInput & {
    receipt: string;
    onUsage: (usage: number) => void;
    onRequest: (serializedChars: number, decodedChars: number) => void;
  },
): Promise<OpResult<{ findings: Finding[]; usage: number; strippedKeys: Record<string, number> }>> {
  if (input.signal?.aborted || currentJobContext()?.signal.aborted)
    return { status: 'needs-human', reason: 'agent review cancelled before dispatch' };
  let resolved: ReturnType<DriverFactory['resolve']>;
  try {
    resolved = drivers.resolve({
      role: 'reviewer',
      modelSpec: input.role,
      harness: defaultHarnessConfig,
      ...(input.stepWallMs === undefined
        ? {}
        : { stepTimeoutMs: Math.max(1, Math.floor(Math.min(input.stepWallMs, input.wallMs))) }),
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
    toolPolicy: { mode: 'none', allow: [] },
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
  if (result.stopReason !== 'complete') {
    if (result.stopReason === 'budget') return { status: 'budget-exhausted' };
    // #484: the driver's errorClass and bounded error text are the only
    // evidence of WHY the reviewer stopped; drop them and the record is blind.
    const detail = [result.errorClass, result.error && oneLine(result.error)]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' — ');
    return {
      status: 'needs-human',
      reason: `agent review did not complete (${result.stopReason}${detail === '' ? '' : `: ${detail}`})`,
    };
  }
  const parsed = OutputSchema.extend({ receipt: z.literal(input.receipt) }).safeParse(
    result.structuredOutput,
  );
  if (!parsed.success)
    return { status: 'failed', error: 'agent review returned invalid structured output' };
  return {
    status: 'ok',
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
      strippedKeys: strippedFindingKeys(result.structuredOutput),
    },
  };
}

export interface AgentReviewReport {
  findings: Finding[];
  usage: number;
  coverage: ReviewCoverage;
  /** Extra finding keys stripped from replies (key → count); absent when none. */
  strippedKeys?: Record<string, number>;
}
export type AgentReviewResult = OpResult<AgentReviewReport> & { report?: AgentReviewReport };

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
  // The partition in flight, named in every blocked reason (#484).
  let where = '';
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
        const component = plan.coverage.partitions[index]?.ranges[0]?.component;
        where = ` [partition ${String(index + 1)}/${String(plan.partitions.length)}${
          component === undefined ? '' : `: ${plan.coverage.components[component]?.path ?? '?'}`
        }]`;
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
        if (result.status !== 'ok') {
          if (result.status === 'needs-human')
            return { ...result, reason: `${result.reason}${where}`, report };
          if (result.status === 'failed')
            return { ...result, error: `${result.error}${where}`, report };
          return { ...result, report };
        }
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
        for (const [key, count] of Object.entries(result.value.strippedKeys))
          (report.strippedKeys ??= {})[key] = (report.strippedKeys[key] ?? 0) + count;
        report.coverage.partitions[index]!.complete = true;
        if (report.usage > input.maxTokens) return { status: 'budget-exhausted', report };
      }
      where = '';
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
      reason: `agent review did not run: ${error instanceof Error ? error.message : String(error)}${where}`,
      ...(report === undefined ? {} : { report }),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener('abort', relay);
    if (cancelled !== undefined) controller.signal.removeEventListener('abort', cancelled);
  }
}
