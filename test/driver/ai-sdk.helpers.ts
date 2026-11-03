// Shared fixtures and helpers for the split ai-sdk driver test files (the
// former test/driver/ai-sdk.test.ts). A non-`.test` module: vitest never
// collects it as tests. The `vi.mock('ai', ...)` spy REGISTRATION cannot
// live here — Vitest hoists vi.mock per test file — so each spy-using
// sibling file declares its own (verbatim from the original) and binds its
// hoisted capture to `generateTextCapture` via `bindGenerateTextCapture`;
// the accessor functions below read through that holder.
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import type { AiSdkDriverOptions } from '../../src/driver/ai-sdk/index.js';
import { CONFORMANCE_PROVIDER, SESSIONS_DIR } from '../../src/driver/conformance.js';
import type { ConformanceSpec, ModelDirective } from '../../src/driver/conformance.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { OpInvocation } from '../../src/driver/types.js';

// ---------------------------------------------------------------------------
// generateText arg capture — a TRANSPARENT spy over the real 'ai' module:
// tests assert what the driver actually PASSED (system preamble,
// stopWhen conditions, conversation messages) without signature churn.
// ---------------------------------------------------------------------------

/** The shared capture holder: each spy-using test file points this at its own hoisted array. */
export const generateTextCapture: { generateTextArgs: unknown[] } = { generateTextArgs: [] };

/** Bind THIS test file's hoisted capture to the shared holder (see the spy note above). */
export function bindGenerateTextCapture(args: unknown[]): void {
  generateTextCapture.generateTextArgs = args;
}

/** The args of the MOST RECENT generateText call (one per driver.run). */
export function lastGenerateTextArgs(): {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
  stopWhen?: unknown;
  maxRetries?: number;
  timeout?: unknown;
  tools?: Record<string, unknown>;
} {
  const last =
    generateTextCapture.generateTextArgs[generateTextCapture.generateTextArgs.length - 1];
  if (last === undefined) throw new Error('no generateText call was captured');
  return last as {
    system?: string;
    messages?: Array<{ role: string; content: string }>;
    stopWhen?: unknown;
    maxRetries?: number;
    timeout?: unknown;
    tools?: Record<string, unknown>;
  };
}

/**
 * The args of a generateText call counted from the END (0 = most recent,
 * 1 = the one before it — the main call of a run that also repaired).
 */
export function generateTextArgsFromEnd(offsetFromEnd: number): {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
  stopWhen?: unknown;
  maxRetries?: number;
  tools?: Record<string, unknown>;
} {
  const args =
    generateTextCapture.generateTextArgs[
      generateTextCapture.generateTextArgs.length - 1 - offsetFromEnd
    ];
  if (args === undefined) throw new Error(`no generateText call at offset ${offsetFromEnd}`);
  return args as {
    system?: string;
    messages?: Array<{ role: string; content: string }>;
    stopWhen?: unknown;
    maxRetries?: number;
    tools?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Mock-model scripting (the conformance contract, wired onto ai/test mocks)
// ---------------------------------------------------------------------------

/** The scripted model's per-step token usage — numbers the usage contract can assert on. */
export function mockUsage(): LanguageModelV4GenerateResult['usage'] {
  // The mock serves the REQUESTED id (its modelId) as the response's model —
  // the conformance observed-model check (leg m) asserts exactly that.
  return {
    inputTokens: { total: 120, noCache: 100, cacheRead: 15, cacheWrite: 5 },
    outputTokens: { total: 12, text: 10, reasoning: 2 },
  };
}

/**
 * Tools the model is still invited to call on this request. The tool set is
 * fixed per session (#502): the forced final step and the repair carry the same
 * definitions and differ only by their trailing instruction turn.
 */
export function offeredToolCount(options: {
  tools?: readonly unknown[];
  prompt?: unknown;
}): number {
  const promptText = JSON.stringify(options.prompt ?? '');
  const answerTurn =
    promptText.includes('This is your final step') ||
    promptText.includes('did not satisfy the required JSON contract');
  return answerTurn ? 0 : (options.tools?.length ?? 0);
}

export function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

/** A text reply carrying provider limit headers on the response metadata (RS-14). */
export function textResultWithHeaders(
  text: string,
  headers: Record<string, string>,
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: mockUsage(),
    warnings: [],
    response: { headers },
  };
}

/** A RESOLVED step whose finish reason is a provider-level failure (no throw). */
export function finishResult(
  unified: 'error' | 'content-filter',
  text = 'the reply never satisfied anything',
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified, raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

export function toolCallResult(tool: string, input: unknown): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'conformance-call-1',
        toolName: tool,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

/** A plain reply model carrying ARBITRARY per-step token usage (custom usage-shape tests). */
export function usageModel(
  usage: LanguageModelV4GenerateResult['usage'],
  modelId = 'mock-1',
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    },
  });
}

/**
 * Build the mock model for one directive (see conformance.ts for the script
 * contract). `servedModel` threads the factory's modelId so the mock's
 * response reports the REQUESTED id as served — the observed-model fact
 * WorkerResult.model carries.
 */
export function modelFor(
  directive: ModelDirective | undefined,
  servedModel?: string,
): MockLanguageModelV4 {
  switch (directive?.kind) {
    case 'block-until-abort': {
      const abortError = (): Error =>
        Object.assign(new Error('run aborted by the governed signal'), { name: 'AbortError' });
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: async (options) => {
          const signal = options.abortSignal;
          if (signal?.aborted) throw abortError();
          return new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        },
      });
    }
    case 'fail':
      // The lane's OWN vendor quota-with-reset shape: a funded-allowance 429
      // whose response headers carry the claude unified window — the script
      // behind the conformance suite's leg s (the mock's fail emits the
      // vendor quota signals where the vendor supports them). The driver
      // must still RETURN stopReason 'error', never throw past the seam.
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: async () => {
          throw quota429Error();
        },
      });
    case 'tool-then-reply':
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: [toolCallResult(directive.tool, directive.input), textResult(directive.reply)],
      });
    case 'reply':
    case undefined:
    default:
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: textResult(directive?.text ?? 'ok'),
      });
    case 'reply-invalid-json':
      // A reply that is NOT the JSON object a structured-output schema
      // demands (the output-invalid legs' script — no legs ship yet).
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: textResult('this reply is prose, not the required JSON object'),
      });
  }
}

/** Conformance harness config: the conformance write permitted via an anchored re: pattern (token patterns deny redirects by design); workspaces inside scratchDir. */
export function conformanceHarnessConfig(
  scratchDir: string,
): NonNullable<AiSdkDriverOptions['harnessConfig']> {
  return {
    ...defaultHarnessConfig,
    workspaceRoot: join(scratchDir, 'workspaces'),
    tools: {
      ...defaultHarnessConfig.tools,
      bash: {
        ...defaultHarnessConfig.tools.bash,
        // `echo conformance-marker > note.txt` redirects — the shell-
        // metacharacter guard (fix 1) denies that under a token pattern, so
        // the conformance write rides the documented escape hatch: an
        // anchored re: pattern matching exactly the isolation write.
        commandPatterns: ['re:^echo .* > note\\.txt$'],
      },
    },
  };
}

/** Fresh mock-backed AiSdkDriver honoring the ConformanceSpec contract. */
export function makeDriver(spec: ConformanceSpec): AiSdkDriver {
  return new AiSdkDriver({
    // The suite's canonical modelSpec handle resolves to the scripted mock,
    // as does the priced handle when the suite brings one; the factory's
    // modelId IS the served id the mock reports (leg m).
    providers: {
      [CONFORMANCE_PROVIDER]: (modelId) => modelFor(spec.directive, modelId),
      ...(spec.pricedModel !== undefined
        ? { [spec.pricedModel.provider]: (modelId) => modelFor(spec.directive, modelId) }
        : {}),
    },
    // The priced handle flows through the price lookup so the conformance
    // suite can assert a derived costUSD; everything else stays unpriced.
    // PRICING KEYING (issue #18): the lookup matches provider AND model —
    // at the spec-declared rates when the suite declares them — so the
    // suite's exact-figure assertion computes from the same numbers.
    ...(spec.pricedModel !== undefined
      ? {
          pricing: (modelSpec: { provider: string; model: string }) =>
            modelSpec.provider === spec.pricedModel?.provider &&
            modelSpec.model === spec.pricedModel.model
              ? (spec.pricedModel.rates ?? { input: 3, output: 15 })
              : undefined,
        }
      : {}),
    sessionsDir: join(spec.scratchDir, SESSIONS_DIR),
    harnessConfig: conformanceHarnessConfig(spec.scratchDir),
    sandboxConfig: {
      mode: 'off',
      backend: 'auto',
      network: 'model-only',
      runTool: 'on',
      envPassthrough: [],
    },
  });
}

/** Minimal invocation for the driver-specific tests. */
export function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
  return {
    prompt: 'driver-specific run',
    modelSpec: { provider: 'mock', model: 'mock-1' },
    toolPolicy: { allow: [], mode: 'unrestricted' },
    sandboxPolicy: { level: 'none' },
    budget: {},
    ...overrides,
  };
}

/** A run that is expected to THROW — resolves with the thrown value (errorClassOf fodder). */
export async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (err) {
    return err;
  }
}

/** A quota 429 with the claude unified limit headers (RS-14 §1.2 shape). */
export function quota429Error(): APICallError {
  return new APICallError({
    message: 'rate limit exceeded: insufficient quota',
    url: 'https://provider.test/v1/messages',
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: {
      'anthropic-ratelimit-unified-5h-percent-remaining': '0',
      'anthropic-ratelimit-unified-5h-reset': '2026-09-28T12:00:00Z',
    },
    data: { error: { code: 'insufficient_quota' } },
    isRetryable: false,
  });
}
