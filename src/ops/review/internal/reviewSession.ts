import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DriverFactory } from '../../../driver/factory.js';
import type { ModelSpec, Usage } from '../../../driver/types.js';
import { toOutputSchema } from '../../../driver/common/structured.js';
import { boundedErrorText } from '../../../driver/error-text.js';
import { defaultHarnessConfig } from '../../../harness/config.js';
import { currentJobContext } from '../../../kernel/governor.js';
import type { OpResult } from '../../../kernel/types.js';
import type { DiffSecretScanner, ScanComponentInput } from '../../dev/denylist.js';
import type { Finding } from '../findings.js';
import type { ReviewCoverageV2 } from './reviewCoverageV2.js';

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

export interface PlannedReviewSession {
  id: string;
  prompt: string;
  placements: { component: string; start: number; end: number; offset: number }[];
  tools: boolean;
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
    searchTools: boolean;
  },
): Promise<OpResult<Finding[]>> {
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
    harness: {
      ...defaultHarnessConfig,
      tools: {
        ...defaultHarnessConfig.tools,
        edit: { ...defaultHarnessConfig.tools.edit, enabled: false },
        bash: { ...defaultHarnessConfig.tools.bash, enabled: false },
        write: { ...defaultHarnessConfig.tools.write, enabled: false },
      },
      promptBudget: {
        ...defaultHarnessConfig.promptBudget,
        maxTools: 3,
        // This legacy field also bounds the operation's user prompt. The
        // driver keeps that prompt out of the system message (prompt-once).
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
    };
  const result = await resolved.driver.run(
    {
      prompt: plan.prompt,
      modelSpec: resolved.modelSpec,
      toolPolicy: {
        mode: plan.tools ? 'allowlist' : 'none',
        allow: plan.tools ? (input.searchTools ? ['read', 'grep', 'glob'] : ['read']) : [],
      },
      sandboxPolicy: { level: 'read-only' },
      workspace: { path: resolve(input.repoRoot) },
      budget: { maxTokens: input.maxTokens, maxSteps: input.maxSteps },
      outputSchema: toOutputSchema('review.agent/v3', OutputSchema),
    },
    { signal },
  );
  // Settled spend still belongs to the governor after cancellation. The outer
  // run may already have returned a snapshot; do not mutate its local report or
  // session evidence after that boundary.
  currentJobContext()?.reportResult({
    usage: result.usage,
    ...(result.costUSD === undefined ? {} : { costUSD: result.costUSD }),
  });
  signal.throwIfAborted();
  evidence.usage = { ...result.usage };
  if (result.steps !== undefined) evidence.steps = result.steps;
  if (result.sessionId !== undefined) evidence.driverSessionId = result.sessionId;
  evidence.denials = result.denials.length;
  input.onUsage(result.usage);
  evidence.status = result.stopReason;
  if (result.stopReason !== 'complete') {
    if (result.stopReason === 'budget') return { status: 'budget-exhausted' };
    const detail = result.error === undefined ? '' : `: ${boundedErrorText(result.error)}`;
    return {
      status: 'needs-human',
      reason: `agent review did not complete (${result.stopReason})${detail}`,
    };
  }
  const parsed = OutputSchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    evidence.status = 'error';
    return { status: 'failed', error: 'agent review returned invalid structured output' };
  }
  if (evidence.deliveries.length === 0) {
    evidence.status = 'error';
    return {
      status: 'needs-human',
      reason: 'agent review completed without scanned content delivery',
    };
  }
  return {
    status: 'ok',
    value: parsed.data.findings.map((item, index) => ({
      id: `${plan.id}-${index + 1}`,
      source: 'agent',
      ...(item.file ? { file: item.file } : {}),
      ...(item.line ? { line: item.line } : {}),
      ...(item.rule ? { rule: item.rule } : {}),
      severity: input.severityMap[item.severity] ?? 'minor',
      text: item.text,
      status: 'open',
    })),
  };
}
