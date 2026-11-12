// Structured output and the bounded tool loop (part of the former
// ai-sdk.test.ts "ai-sdk driver specifics (mock model)"): the final-step
// contract (#203, #502), the fixed prepared definitions, the legacy Anthropic
// JSON-tool fallback, final-step/repair tool denials, and the
// token-cap/priced-miss verdicts on structured runs.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { invocation, offeredToolCount, textResult, toolCallResult } from './ai-sdk.helpers.js';
import { AiSdkDriver, DEFAULT_MAX_STEPS } from '../../src/driver/ai-sdk/index.js';
import { SessionStore } from '../../src/harness/session.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';

describe('ai-sdk driver specifics (mock model)', () => {
  test('structured output is decoupled from the tool loop: the final step asks for the answer (#203, #502)', async () => {
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        return offeredToolCount(options) > 0
          ? toolCallResult('read', { path: 'absent.txt' })
          : textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const request = invocation({
        toolPolicy: { allow: ['read'], mode: 'allowlist' },
        outputSchema: toOutputSchema(
          'test/multi-step/v1',
          z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
        ),
      });
      const result = await driver.run(request);
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      expect(result.steps).toBe(DEFAULT_MAX_STEPS); // omitted maxSteps preserves the default
      // With tools live every step the model answers tool-calls forever and
      // never emits the object; the final-step instruction turn is what makes the
      // structured output reachable — the model is called exactly to the cap.
      expect(calls).toBe(DEFAULT_MAX_STEPS);
      calls = 0;
      const clamped = await driver.run({
        ...request,
        budget: { maxSteps: DEFAULT_MAX_STEPS + 1 },
      });
      expect(clamped.steps).toBe(DEFAULT_MAX_STEPS);
      expect(calls).toBe(DEFAULT_MAX_STEPS); // a caller cannot raise the hard SDK ceiling
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each([undefined, false, true])('late reviewer countdown is opt-in (%s)', async (enabled) => {
    const hints: Array<number | undefined> = [];
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        const text = JSON.stringify(options.prompt);
        expect(text).not.toContain('1 tool steps left');
        hints.push(Number(/(\d+) tool steps? left/.exec(text)?.[1]) || undefined);
        return text.includes('This is your final step')
          ? textResult('{"fixed":true}')
          : toolCallResult('read', { path: 'absent.txt' });
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-countdown-'));
    try {
      const driver = new AiSdkDriver({ providers: { mock: () => mock }, sessionsDir: scratchDir });
      const result = await driver.run(
        invocation({
          budget: { maxSteps: 5 },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema('test/countdown/v1', z.object({ fixed: z.boolean() })),
        }),
        enabled === undefined ? {} : { reviewerStepCountdown: enabled },
      );
      expect(result.stopReason).toBe('complete');
      expect(hints).toEqual(enabled ? [undefined, 3, 2, 1, undefined] : Array(5).fill(undefined));
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a small maxSteps budget is honoured: the last step is invited to answer instead of calling tools', async () => {
    const toolCounts: number[] = [];
    let resuming = false;
    let sawReplay = false;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        if (resuming) {
          const assistantTexts = options.prompt
            .filter((message) => message.role === 'assistant')
            .flatMap((message) =>
              message.content.filter((part) => part.type === 'text').map((part) => part.text),
            );
          expect(assistantTexts.every((text) => text.trim() !== '')).toBe(true);
          expect(assistantTexts.some((text) => text.includes('"toolName":"read"'))).toBe(true);
          sawReplay = true;
        }
        const tools = offeredToolCount(options);
        toolCounts.push(tools);
        if (tools > 0) {
          const reply = toolCallResult('read', { path: 'absent.txt' });
          return {
            ...reply,
            content: [{ type: 'text' as const, text: 'Reading evidence.' }, ...reply.content],
          };
        }
        return textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-small-steps-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const request = invocation({
        budget: { maxSteps: 3 },
        toolPolicy: { allow: ['read'], mode: 'allowlist' },
        outputSchema: toOutputSchema(
          'test/small-steps/v1',
          z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
        ),
      });
      const result = await driver.run(request);
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      expect(result.steps).toBe(3);
      expect(toolCounts.map((count) => count > 0)).toEqual([true, true, false]);
      const record = await new SessionStore(join(scratchDir, 'sessions')).load(
        result.sessionId as string,
      );
      const steps = record?.messages.filter(
        (message) => message.role === 'assistant' && message.usage !== undefined,
      );
      expect(steps).toHaveLength(3);
      expect(steps?.map((message) => message.usage)).toEqual([
        { input: 100, output: 12, cacheRead: 15, cacheWrite: 5 },
        { input: 100, output: 12, cacheRead: 15, cacheWrite: 5 },
        { input: 100, output: 12, cacheRead: 15, cacheWrite: 5 },
      ]);
      expect(steps?.slice(0, 2).every((message) => message.toolCalls?.includes('read'))).toBe(true);
      expect(steps?.[2]?.toolCalls).toBeUndefined();
      expect(steps?.[0]?.content).toContain('Reading evidence.');
      expect(steps?.[0]?.content).not.toContain('absent.txt');
      resuming = true;
      const resumed = await driver.run({ ...request, sessionRef: result.sessionId as string });
      expect(resumed.stopReason).toBe('complete');
      expect(sawReplay).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each(['opencode-go', 'zai', 'ai-sdk'])(
    'the complete prepared definitions stay fixed through final and repair: %s (#502)',
    async (provider) => {
      const requests: {
        definitions: string;
        choice: string;
        system: string;
        tail: string;
        schemaBytes: number;
        syntheticBytes: number;
      }[] = [];
      const mock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async (options) => {
          const system = options.prompt.find((message) => message.role === 'system');
          const last = options.prompt.at(-1);
          const prepared = {
            tools: options.tools,
            toolChoice: options.toolChoice,
            system: typeof system?.content === 'string' ? system.content : '',
          };
          requests.push({
            definitions: JSON.stringify(options.tools),
            choice: JSON.stringify(options.toolChoice),
            system: prepared.system,
            tail: last?.role === 'user' ? JSON.stringify(last.content) : String(last?.role),
            schemaBytes:
              options.tools?.reduce(
                (total, entry) =>
                  total +
                  ('inputSchema' in entry
                    ? Buffer.byteLength(JSON.stringify(entry.inputSchema), 'utf8')
                    : 0),
                0,
              ) ?? 0,
            // Serialized request shape only: these are NOT provider tokens or billed bytes.
            syntheticBytes: Buffer.byteLength(JSON.stringify(prepared), 'utf8'),
          });
          if (offeredToolCount(options) > 0) return toolCallResult('read', { path: 'absent.txt' });
          // The final step's text misses the schema, so the repair call runs too.
          return requests.length === 3
            ? textResult('not a JSON object')
            : textResult('{"fixed":true,"notes":"ok"}');
        },
      });
      const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-final-fixed-'));
      try {
        const driver = new AiSdkDriver({
          providers: { [provider]: () => mock },
          sessionsDir: join(scratchDir, 'sessions'),
        });
        const result = await driver.run(
          invocation({
            modelSpec: { provider, model: 'mock-1' },
            budget: { maxSteps: 3 },
            toolPolicy: { allow: ['read'], mode: 'allowlist' },
            outputSchema: toOutputSchema(
              'test/final-fixed/v1',
              z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
            ),
          }),
        );
        expect(result.stopReason).toBe('complete');
        expect(requests).toHaveLength(4);
        // Compare whole prepared definitions, not just names or tool counts.
        expect(JSON.parse(requests[0]!.definitions)).toMatchObject([{ name: 'read' }]);
        expect(requests[0]!.schemaBytes).toBe(410);
        expect(requests[0]!.syntheticBytes).toBeGreaterThan(0);
        for (const request of requests) {
          expect(request.definitions).toBe(requests[0]?.definitions);
          expect(request.choice).toBe(requests[0]?.choice);
          expect(request.system).toBe(requests[0]?.system);
          expect(request.schemaBytes).toBe(requests[0]?.schemaBytes);
          expect(request.syntheticBytes).toBe(requests[0]?.syntheticBytes);
        }
        expect(requests[0]?.choice).toBe('{"type":"auto"}');
        expect(requests.reduce((total, request) => total + request.syntheticBytes, 0)).toBe(
          4 * requests[0]!.syntheticBytes,
        );
        expect(requests.reduce((total, request) => total + request.schemaBytes, 0)).toBe(1640);
        expect(requests[0]?.system).toContain('use the available tools');
        // Only the trailing instruction turn differs.
        expect(requests[2]?.tail).toContain('This is your final step');
        expect(requests[3]?.tail).toContain('did not satisfy the required JSON contract');
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );

  test.each([false, true])(
    'a structured miss persists each main step once (budget stop: %s)',
    async (budgetStop) => {
      const root = await mkdtemp(join(tmpdir(), 'aidrv-miss-transcript-'));
      try {
        const mock = new MockLanguageModelV4({
          modelId: 'mock-1',
          doGenerate: [textResult('not JSON'), textResult('{"answer":"repaired"}')],
        });
        const driver = new AiSdkDriver({
          providers: { zai: () => mock },
          sessionsDir: join(root, 'sessions'),
        });
        const result = await driver.run(
          invocation({
            modelSpec: { provider: 'zai', model: 'mock-1' },
            toolPolicy: { mode: 'none', allow: [] },
            budget: budgetStop ? { maxTokens: 1 } : {},
            outputSchema: toOutputSchema(
              'test/miss-transcript/v1',
              z.object({ answer: z.string() }),
            ),
          }),
        );
        expect(result.stopReason).toBe(budgetStop ? 'budget' : 'complete');
        expect(mock.doGenerateCalls).toHaveLength(budgetStop ? 1 : 2);
        const record = await new SessionStore(join(root, 'sessions')).load(
          result.sessionId as string,
        );
        const assistants = record?.messages.filter((message) => message.role === 'assistant');
        expect(assistants).toHaveLength(budgetStop ? 1 : 2);
        expect(assistants?.filter((message) => message.content === 'not JSON')).toHaveLength(1);
        expect(assistants?.[0]?.usage).toBeDefined();
        if (!budgetStop) expect(assistants?.[1]?.content).toBe('{"answer":"repaired"}');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test('legacy Anthropic JSON-tool fallback is present on the offline wire (#505)', async () => {
    const requests: Record<string, unknown>[] = [];
    const offlineFetch: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'offline fixture stop' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    };
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-anthropic-offline-'));
    try {
      const anthropic = createAnthropic({ apiKey: 'offline-fixture', fetch: offlineFetch });
      const driver = new AiSdkDriver({
        providers: { anthropic: () => anthropic.languageModel('claude-sonnet-4-20250514') },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          modelSpec: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
          toolPolicy: { mode: 'allowlist', allow: ['read'] },
          outputSchema: toOutputSchema(
            'test/anthropic-legacy/v1',
            z.object({ answer: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(requests).toHaveLength(1);
      const tools = requests[0]?.tools;
      expect(tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'json' })]));
      expect(tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'read' })]));
      expect(requests[0]).not.toHaveProperty('output_config');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a tool call on the final step is denied, not executed (#502)', async () => {
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        // Ignores the final-step instruction and calls a tool anyway.
        if (calls <= 2) return toolCallResult('read', { path: 'absent.txt' });
        if (JSON.stringify(options.prompt).includes('This is your final step') && calls === 3) {
          return toolCallResult('read', { path: 'final.txt' });
        }
        return textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-final-deny-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          budget: { maxSteps: 3 },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/final-deny/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      const finalDenials = result.denials.filter((denial) =>
        denial.reason.includes('disabled on the final step'),
      );
      expect(finalDenials).toEqual([
        {
          tool: 'read',
          reason: 'FINAL_STEP: tool calls are disabled on the final step; reply with the answer',
        },
      ]);
      // The two earlier reads ran (and were denied as absent), the final one never executed.
      expect(result.denials.filter((denial) => denial.reason.includes('final.txt'))).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a tool call inside the repair is not executed and settles output-invalid (#502)', async () => {
    let calls = 0;
    const executed: string[] = [];
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        // Main loop: prose instead of the object; repair: a tool call instead of the object.
        return calls === 1
          ? textResult('not a JSON object')
          : toolCallResult('read', { path: 'evidence.txt' });
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-repair-tool-'));
    // The session binding file lives OUTSIDE the model-editable workspace
    // (Annex A, issue #1197): sessions stay at the scratch root, the bound
    // workspace is the child holding the model-visible fixture.
    const workspace = join(scratchDir, 'workspace');
    await mkdir(workspace);
    try {
      await writeFile(join(workspace, 'evidence.txt'), 'must not be read by the repair');
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (_text, _contents, context) => {
          if (context?.kind === 'tool-output') executed.push('tool-output');
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema('test/repair-tool/v1', z.object({ answer: z.string() })),
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(calls).toBe(2);
      expect(result.steps).toBe(2); // one main step, plus the one repair step
      expect(executed).toEqual([]); // the repair's tool call never ran
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the repair sends the same tool names as the main loop, aliases included (#502)', async () => {
    const toolNames: string[][] = [];
    const preparedDefinitions: string[] = [];
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        toolNames.push((options.tools ?? []).map((t) => ('name' in t ? t.name : '')).sort());
        preparedDefinitions.push(JSON.stringify(options.tools));
        return toolNames.length === 1
          ? textResult('not a JSON object')
          : textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-repair-alias-'));
    // The session binding file lives OUTSIDE the model-editable workspace
    // (Annex A, issue #1197): sessions stay at the scratch root, the bound
    // workspace is the child. Cleanup (rm scratchDir) is unchanged.
    const workspace = join(scratchDir, 'workspace');
    await mkdir(workspace);
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { allow: ['read', 'bash'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/repair-alias/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(toolNames).toHaveLength(2);
      expect(toolNames[0]).toContain('run');
      expect(toolNames[1]).toEqual(toolNames[0]);
      expect(preparedDefinitions[1]).toBe(preparedDefinitions[0]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('maxSteps=1 makes the final step the first main step and counts the repair step separately', async () => {
    const toolCounts: number[] = [];
    const hookKinds: string[] = [];
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        toolCounts.push(offeredToolCount(options));
        return toolCounts.length === 1
          ? textResult('not a JSON object')
          : textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-max-steps-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (_text, _contents, context) => {
          hookKinds.push(context?.kind ?? 'missing');
        },
      });
      const result = await driver.run(
        invocation({
          budget: { maxSteps: 1 },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/max-steps/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.steps).toBe(2); // one main step, plus the one repair step
      expect(toolCounts).toHaveLength(2);
      expect(toolCounts[0]).toBe(0); // maxSteps=1 makes the first main step the final step
      expect(toolCounts[1]).toBe(0); // repair remains one step that executes no tools
      expect(hookKinds).toEqual(['model-request', 'model-request']);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a token cap that leaves the final step on tool-calls reports budget, not error (#203)', async () => {
    const alwaysToolCalls = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => toolCallResult('read', { path: 'absent.txt' }),
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => alwaysToolCalls },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      // Per-step usage folds 132 tokens, so the 200 cap trips after step 2 and
      // the final step stays on tool-calls — the missing object is the cap's
      // consequence, not a driver failure.
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          budget: { maxTokens: 200 },
          outputSchema: toOutputSchema(
            'test/token-cap/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('budget');
      expect(result.error).toBeUndefined();
      // The carve-out is NOT a failure verdict: no errorClass rides it
      // (the one-directional producer rule — classes only on 'error').
      expect(result.errorClass).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a priced structured-output miss derives cost from the full result usage (#203)', async () => {
    const alwaysToolCalls = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => toolCallResult('read', { path: 'absent.txt' }),
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => alwaysToolCalls },
        sessionsDir: join(scratchDir, 'sessions'),
        pricing: () => ({ input: 3, output: 15 }),
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/priced-miss/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(typeof result.costUSD).toBe('number');
      expect(result.costBasis).toBe('modeled');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
