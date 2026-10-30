import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DriverFactory } from '../../../driver/factory.js';
import type { ModelSpec, Usage, WorkerErrorClass, WorkerResult } from '../../../driver/types.js';
import { toOutputSchema } from '../../../driver/common/structured.js';
import { boundedErrorText } from '../../../driver/error-text.js';
import { defaultHarnessConfig } from '../../../harness/config.js';
import { currentJobContext } from '../../../kernel/governor.js';
import type { OpResult } from '../../../kernel/types.js';
import type { DiffSecretScanner, ScanComponentInput } from '../../dev/denylist.js';
import type { Finding } from '../findings.js';
import type { ReviewCoverageV2 } from './reviewCoverageV2.js';

// A finding item STRIPS unknown keys (S7 attempts G/H: GLM added
// `rule_id_hint` / `rule_detail` to one finding and the strict item failed
// the whole review); every field check and the required severity/text still
// hold, and the top level stays strict. The emitted contract therefore
// leaves item `additionalProperties` open: the driver validates the reply
// against the SAME document it sent (ADR-0002 §2.3), so a closed item would
// reject the extra key before this parse could strip it.
const OutputSchema = z
  .object({
    findings: z.array(
      z.object({
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        rule: z.string().optional(),
        severity: z.enum(['high', 'medium', 'low']),
        text: z.string().min(1),
      }),
    ),
  })
  .strict();

export const totalUsage = (usage: Usage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);

const sumUsage = (a: ReviewCoverageV2['sessions'][number]['usage'], b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  ...(a.reasoning === undefined && b.reasoning === undefined
    ? {}
    : { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }),
});

export interface PlannedReviewSession {
  contextOnly?: boolean;
  id: string;
  prompt: string;
  placements: { component: string; start: number; end: number; offset: number }[];
  tools: boolean;
  maxSteps?: number;
}

/** Every scan input needs an explicit, clean verdict; an empty response proves nothing. */
export async function scanReviewUpload(
  scanner: DiffSecretScanner,
  components: readonly ScanComponentInput[],
): Promise<void> {
  const verdicts = await scanner(components);
  if (
    verdicts.length !== components.length ||
    new Set(verdicts.map((verdict) => verdict.component)).size !== components.length ||
    components.some(
      (component) => !verdicts.some((verdict) => verdict.component === component.component),
    ) ||
    verdicts.some((verdict) => verdict.hits.length > 0)
  )
    throw new Error(
      'agent review upload refused: protected content or incomplete scanner verdicts',
    );
}

/**
 * The hook also scans tool output. Delivery requires the actual serialized SDK
 * request, with an exact decoded user-text leaf; raw tool text is not evidence.
 * The caller has already scanned every nonexcluded original component with its
 * source path. This internal helper additionally scans every outbound request.
 * Resolve/run errors are caught by the caller's shared-budget/deadline boundary.
 */
function containsUserPrompt(serialized: string, prompt: string): boolean {
  let request: unknown;
  try {
    request = JSON.parse(serialized);
  } catch {
    return false;
  }
  if (request === null || typeof request !== 'object' || !('prompt' in request)) return false;
  if (!Array.isArray(request.prompt)) return false;
  return request.prompt.some((message: unknown) => {
    if (
      message === null ||
      typeof message !== 'object' ||
      !('role' in message) ||
      message.role !== 'user'
    )
      return false;
    if (!('content' in message)) return false;
    return (
      message.content === prompt ||
      (Array.isArray(message.content) &&
        message.content.some(
          (part: unknown) =>
            part !== null &&
            typeof part === 'object' &&
            'type' in part &&
            part.type === 'text' &&
            'text' in part &&
            part.text === prompt,
        ))
    );
  });
}

export async function runReviewSession(
  drivers: DriverFactory,
  input: {
    repoRoot: string;
    role: ModelSpec;
    severityMap: { high: string; medium: string; low?: string };
    maxTokens: number;
    maxSteps: number;
    maxPromptChars: number;
    signal: AbortSignal;
    scanSecrets: DiffSecretScanner;
    components: readonly ScanComponentInput[];
    plan: PlannedReviewSession;
    evidence: ReviewCoverageV2['sessions'][number];
    onUsage: (usage: Usage) => void;
    onAdvisories?: (advisories: readonly string[]) => void;
    searchTools: boolean;
    logToolFailures?: boolean;
    /** Per-request step bound for the ai-sdk lane (cq.json `budgets.step.wallMs`, capped). */
    stepTimeoutMs?: number;
    /** Remaining engine wall, sampled before backoff and again before retry. */
    remainingWallMs?: () => number;
    /** Injectable abortable delay for rate-limit backoff. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<OpResult<Finding[]> & { errorClass?: WorkerErrorClass; fatal?: boolean }> {
  const { plan, evidence, signal } = input;
  if (evidence.deliveries.length > 0 || evidence.requests.length > 0)
    throw new Error('agent review session evidence must start empty');
  const sources = new Map(input.components.map((component) => [component.component, component]));
  for (const placement of plan.placements) {
    const source = sources.get(placement.component);
    if (
      !source ||
      !Number.isInteger(placement.offset) ||
      placement.offset < 0 ||
      placement.start < 0 ||
      placement.end < placement.start ||
      placement.end > source.text.length ||
      placement.offset + placement.end - placement.start > plan.prompt.length ||
      plan.prompt.slice(placement.offset, placement.offset + placement.end - placement.start) !==
        source.text.slice(placement.start, placement.end)
    )
      throw new Error('agent review prompt placement does not match its planned component');
  }
  signal.throwIfAborted();
  const resolved = drivers.resolve({
    role: 'reviewer',
    modelSpec: input.role,
    ...(input.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: input.stepTimeoutMs }),
    harness: {
      ...defaultHarnessConfig,
      logToolFailures: input.logToolFailures ?? false,
      tools: {
        ...defaultHarnessConfig.tools,
        edit: { ...defaultHarnessConfig.tools.edit, enabled: false },
        bash: { ...defaultHarnessConfig.tools.bash, enabled: false },
        write: { ...defaultHarnessConfig.tools.write, enabled: false },
      },
      promptBudget: {
        ...defaultHarnessConfig.promptBudget,
        // The session surface is read plus the two read-only search tools
        // when allowed: `selectTools` orders edit/bash/write first, so a
        // tighter budget would silently hide the offered search tools and
        // the rg-capability probe with them. Withheld search (rg absent or
        // too old) stays visible as capability evidence, not a smaller
        // configured surface. This legacy field also bounds the operation's
        // user prompt; the driver keeps that prompt out of the system
        // message (prompt-once).
        maxTools: plan.tools && input.searchTools ? 3 : 1,
        maxSystemPromptChars: input.maxPromptChars,
      },
    },
    beforeRequest: async (text, contents = [], context) => {
      signal.throwIfAborted();
      // Copy primitive strings before awaiting a scanner; mutable adapter arrays
      // cannot change the evidence we use after its clean verdict.
      const frozenContents = contents.map((content) => Object.freeze({ ...content }));
      await scanReviewUpload(input.scanSecrets, [
        { component: 'request', path: 'review-request.json', text },
        ...frozenContents.map((content, index) => ({
          component: `request-content-${index}`,
          path: content.path ?? 'review-request.json',
          text: content.text,
        })),
      ]);
      signal.throwIfAborted();
      // Requests are clean model-send hooks, not attempted/refused uploads.
      // Unrecognized hook kinds still receive the full scan above.
      if (context?.kind !== 'model-request') return;
      evidence.requests.push({
        serializedChars: text.length,
        decodedChars: frozenContents.reduce((total, content) => total + content.text.length, 0),
      });
      if (
        !containsUserPrompt(text, plan.prompt) ||
        !frozenContents.some((content) => content.text === plan.prompt)
      )
        return;
      if (plan.contextOnly)
        evidence.contextSha256 = createHash('sha256').update(plan.prompt).digest('hex');
      // Tool steps and repair replay the prompt. They do not add coverage.
      if (evidence.deliveries.length > 0) return;
      for (const placement of plan.placements) {
        const source = sources.get(placement.component)!;
        evidence.deliveries.push({
          component: placement.component,
          start: placement.start,
          end: placement.end,
          sha256: createHash('sha256')
            .update(source.text.slice(placement.start, placement.end))
            .digest('hex'),
        });
      }
    },
  });
  // Other lanes cannot attest pre-upload scanning of their tool results.
  if (resolved.lane !== 'ai-sdk')
    return {
      status: 'needs-human',
      reason: 'agent review requires the ai-sdk pre-upload scan lane',
      fatal: true,
    };
  const runDriver = (maxTokens: number) =>
    resolved.driver.run(
      {
        prompt: plan.prompt,
        modelSpec: resolved.modelSpec,
        toolPolicy: {
          mode: plan.tools ? 'allowlist' : 'none',
          allow: plan.tools ? (input.searchTools ? ['read', 'grep', 'glob'] : ['read']) : [],
        },
        sandboxPolicy: { level: 'read-only' },
        workspace: { path: resolve(input.repoRoot) },
        budget: { maxTokens, maxSteps: plan.maxSteps ?? input.maxSteps },
        outputSchema: toOutputSchema('review.agent/v3', OutputSchema),
      },
      { signal },
    );
  // Settled spend still belongs to the governor after cancellation. The outer
  // run may already have returned a snapshot; do not mutate its local report or
  // session evidence after that boundary. Usage and steps sum across attempts.
  let spent = 0;
  const settle = (attempt: WorkerResult): void => {
    currentJobContext()?.reportResult({
      usage: attempt.usage,
      ...(attempt.costUSD === undefined ? {} : { costUSD: attempt.costUSD }),
    });
    signal.throwIfAborted();
    evidence.usage = sumUsage(evidence.usage, attempt.usage);
    if (attempt.steps !== undefined) evidence.steps = (evidence.steps ?? 0) + attempt.steps;
    if (attempt.sessionId !== undefined) evidence.driverSessionId = attempt.sessionId;
    evidence.toolFailures =
      (evidence.toolFailures ?? 0) + (attempt.toolFailures ?? attempt.denials.length);
    evidence.denials = (evidence.denials ?? 0) + attempt.denials.length;
    if (attempt.capabilities !== undefined)
      evidence.capabilities = structuredClone(attempt.capabilities);
    if (attempt.advisories !== undefined) input.onAdvisories?.(attempt.advisories);
    input.onUsage(attempt.usage);
    spent += totalUsage(attempt.usage);
  };
  let result = await runDriver(input.maxTokens);
  settle(result);
  // One retry total. Rate limits additionally need a bounded abortable backoff;
  // auth/quota and other refusals never enter either retry path. Requests and
  // spend cover both attempts; deliveries describe only the final attempt.
  const canRetry = () => !signal.aborted && input.maxTokens - spent > 0;
  let retry = result.stopReason === 'error' && result.errorClass === 'transient' && canRetry();
  // A rate limit that is not retried keeps the provider's wait and the cause,
  // so the block reason says why (#578): over the cap, past the wall, out of
  // tokens, or an unusable retry-after.
  let refused: { waitMs: number; cause: 'cap' | 'wall' | 'tokens' | 'invalid' } | undefined;
  if (result.stopReason === 'error' && result.errorClass === 'rate-limit' && !signal.aborted) {
    const waitMs = result.providerSignals?.retryAfterMs ?? 30_000;
    // A provider asking for more than two minutes is left blocked, never
    // retried earlier than its retry-after. Leave a second for actual work.
    const cause = !canRetry()
      ? 'tokens'
      : !Number.isFinite(waitMs) || waitMs < 0
        ? 'invalid'
        : waitMs > 120_000
          ? 'cap'
          : waitMs + 1000 >= (input.remainingWallMs?.() ?? 0)
            ? 'wall'
            : undefined;
    if (cause !== undefined) refused = { waitMs, cause };
    else {
      input.onAdvisories?.([
        `session ${plan.id}: rate-limit wait ${String(waitMs)}ms before retry 1`,
      ]);
      if (input.sleep) await input.sleep(waitMs, signal);
      else await delay(waitMs, undefined, { signal });
      signal.throwIfAborted();
      // Tokens cannot change during the wait and an abort has thrown, so a
      // refusal here is the wall running out.
      retry = canRetry() && (input.remainingWallMs?.() ?? 0) > 0;
      if (!retry) refused = { waitMs, cause: 'wall' };
    }
    if (refused)
      input.onAdvisories?.([
        `session ${plan.id}: rate-limit wait ${String(refused.waitMs)}ms not retried (${refused.cause})`,
      ]);
  }
  if (retry) {
    signal.throwIfAborted();
    evidence.deliveries = [];
    evidence.attempts = 2;
    if (result.errorClass === 'rate-limit')
      input.onAdvisories?.([`session ${plan.id}: rate-limit retry 1 dispatched`]);
    result = await runDriver(input.maxTokens - spent);
    settle(result);
  }
  evidence.status = result.stopReason;
  if (result.stopReason !== 'complete') {
    if (result.stopReason === 'budget') return { status: 'budget-exhausted' };
    const detail = result.error === undefined ? '' : `: ${boundedErrorText(result.error)}`;
    const wait =
      refused === undefined
        ? ''
        : `; rate-limit wait ${String(refused.waitMs)}ms not retried (${refused.cause})`;
    return {
      status: 'needs-human',
      reason: `agent review did not complete (${result.stopReason})${wait}${detail}`,
      ...(result.errorClass === undefined ? {} : { errorClass: result.errorClass }),
    };
  }
  const parsed = OutputSchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    evidence.status = 'error';
    return { status: 'failed', error: 'agent review returned invalid structured output' };
  }
  if (evidence.deliveries.length === 0 && !evidence.contextSha256) {
    evidence.status = 'error';
    return {
      status: 'needs-human',
      reason: 'agent review completed without scanned content delivery',
      fatal: true,
    };
  }
  return {
    status: 'ok',
    value: parsed.data.findings.map((item, index) => ({
      id: `${plan.id}-${index + 1}`,
      source: 'agent',
      ...(item.file !== undefined ? { file: item.file } : {}),
      ...(item.line ? { line: item.line } : {}),
      ...(item.rule !== undefined ? { rule: item.rule } : {}),
      severity: input.severityMap[item.severity] ?? 'minor',
      text: item.text,
      status: 'open',
    })),
  };
}
