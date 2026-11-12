// Prompt shaping and reply parsing (part of the former ai-sdk.test.ts
// "ai-sdk driver specifics (mock model)"): the system preamble and per-turn
// wording (#483, #468), response_format vs prompted schemas, the repair's
// retained tool evidence, and the parseReplyJson tool-call-markup contract.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  bindGenerateTextCapture,
  generateTextArgsFromEnd,
  invocation,
  lastGenerateTextArgs,
  modelFor,
  offeredToolCount,
  textResult,
  toolCallResult,
} from './ai-sdk.helpers.js';
import { AiSdkDriver, DEFAULT_MAX_STEPS, parseReplyJson } from '../../src/driver/ai-sdk/index.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';

// ---------------------------------------------------------------------------
// The transparent generateText spy (accessors live in ai-sdk.helpers.ts).
// Vitest hoists vi.mock per test file, so the registration is declared here,
// verbatim from the original file, and bound to the shared capture holder.
// ---------------------------------------------------------------------------

const captured = vi.hoisted(() => ({ generateTextArgs: [] as unknown[] }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (args: Parameters<typeof actual.generateText>[0]) => {
      captured.generateTextArgs.push(args);
      return actual.generateText(args);
    },
  };
});

bindGenerateTextCapture(captured.generateTextArgs);

describe('ai-sdk driver specifics (mock model)', () => {
  test('prompted schema final step retains tools and repairs invalid output (Refs #505)', async () => {
    const requests: Array<{
      prompt: unknown;
      tools?: readonly unknown[];
      responseFormat?: unknown;
    }> = [];
    const mock = new MockLanguageModelV4({
      modelId: 'deepseek-v4.1-flash',
      doGenerate: async (options) => {
        requests.push(options);
        if (requests.length === 1) return toolCallResult('read', { path: 'absent.txt' });
        return textResult(requests.length === 2 ? '{"fixed":"yes"}' : '{"fixed":true}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-prompted-final-'));
    try {
      const driver = new AiSdkDriver({
        providers: { 'opencode-go': () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          modelSpec: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
          budget: { maxSteps: 2 },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/prompted-final/v1',
            z.object({ fixed: z.boolean() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true });
      expect(result.steps).toBe(3);
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => request.responseFormat === undefined)).toBe(true);
      expect(JSON.stringify(requests[1]!.prompt)).toContain('This is your final step');
      expect(JSON.stringify(requests[1]!.prompt)).toContain('JSON Schema');
      expect(requests.map((request) => request.tools)).toEqual(Array(3).fill(requests[0]!.tools));
      expect(requests[0]!.tools!.length).toBeGreaterThan(0);
      const main = generateTextArgsFromEnd(1);
      const repair = generateTextArgsFromEnd(0);
      expect(repair.system).toEqual(main.system);
      expect(JSON.stringify(repair.tools)).toEqual(JSON.stringify(main.tools));
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('prompted-schema providers never send response_format: the schema rides the prompt and the reply text is validated (dogfood C, 2026-10-25)', async () => {
    const formats: unknown[] = [];
    const contracts: boolean[] = [];
    const promptCopies: number[] = [];
    const scans: string[] = [];
    let toolFree = 0;
    const gateway = new MockLanguageModelV4({
      modelId: 'deepseek-v4.1-flash',
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        formats.push(options.responseFormat);
        contracts.push(promptText.includes('Use the tools to complete the task first'));
        promptCopies.push(promptText.match(/driver-specific run/g)?.length ?? 0);
        if (offeredToolCount(options) > 0 && formats.length === 1) {
          return toolCallResult('read', { path: 'absent.txt' });
        }
        toolFree += 1;
        return toolFree === 1
          ? textResult('Done.\n```json\n{"fixed":"yes"}\n```')
          : textResult('```json\n{"fixed":true,"notes":"ok"}\n```');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-prompted-'));
    try {
      const driver = new AiSdkDriver({
        providers: { 'opencode-go': () => gateway, mock: () => gateway },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (text) => {
          scans.push(text);
        },
      });
      const schema = toOutputSchema(
        'test/prompted/v1',
        z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
      );
      const result = await driver.run(
        invocation({
          modelSpec: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: schema,
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      // tool step, schema-invalid final text, one repair (same tools and system, #502)
      expect(formats).toHaveLength(3);
      expect(formats.every((format) => format === undefined)).toBe(true);
      expect(promptCopies).toEqual(formats.map(() => 1));
      const promptedArgs = lastGenerateTextArgs();
      expect(promptedArgs.system).toBe(
        'You are a cq-toolkit worker executing one task. Work inside the provided workspace directory; use the available tools to read, edit, and run. Tool refusals arrive as denial text — adapt instead of retrying the same call.',
      );
      expect(promptedArgs.system).not.toContain('driver-specific run');
      expect(
        promptedArgs.messages?.filter(
          (message) => message.role === 'user' && message.content === 'driver-specific run',
        ),
      ).toHaveLength(1);
      expect(contracts).toEqual([true, true, false]); // the repair turn carries its own JSON contract
      expect(scans.some((text) => text.includes('Use the tools to complete the task first'))).toBe(
        true,
      );
      // CONTROL: a native-schema provider still sends the json response format.
      formats.length = 0;
      contracts.length = 0;
      promptCopies.length = 0;
      scans.length = 0;
      toolFree = 1;
      await driver.run(invocation({ outputSchema: schema }));
      expect(formats[0]).toMatchObject({ type: 'json' });
      expect(contracts.length).toBeGreaterThan(0);
      expect(contracts.every((present) => !present)).toBe(true);
      expect(promptCopies).toEqual(formats.map(() => 1));
      const nativeArgs = lastGenerateTextArgs();
      expect(nativeArgs.system).not.toContain('driver-specific run');
      expect(
        nativeArgs.messages?.filter(
          (message) => message.role === 'user' && message.content === 'driver-specific run',
        ),
      ).toHaveLength(1);
      expect(
        scans.every((text) => !text.includes('Use the tools to complete the task first')),
      ).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each([false, true])('main wording matches offered tools: %s (#483)', async (hasTools) => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-tool-wording-'));
    const schema = toOutputSchema('test/wording/v1', z.object({ answer: z.string() }));
    try {
      const driver = new AiSdkDriver({
        providers: { 'opencode-go': () => modelFor({ kind: 'reply', text: '{"answer":"ok"}' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      await driver.run(
        invocation({
          prompt: 'Review the supplied patch.',
          modelSpec: { provider: 'opencode-go', model: 'mock-1' },
          toolPolicy: hasTools
            ? { mode: 'allowlist', allow: ['read'] }
            : { mode: 'none', allow: [] },
          outputSchema: schema,
        }),
      );
      const args = lastGenerateTextArgs();
      const preamble = hasTools
        ? 'You are a cq-toolkit worker executing one task. Work inside the provided workspace directory; use the available tools to read, edit, and run. Tool refusals arrive as denial text — adapt instead of retrying the same call.'
        : 'You are a cq-toolkit worker executing one task. You have no tools: everything you need is in the messages below. Answer directly.';
      expect(args.system).toBe(preamble);
      expect(args.system).not.toContain('Review the supplied patch.');
      expect(args.tools === undefined).toBe(!hasTools);
      const userPromptTurns = args.messages?.filter(
        (message) => message.role === 'user' && message.content === 'Review the supplied patch.',
      );
      expect(userPromptTurns).toHaveLength(1);
      const prefix = hasTools
        ? 'Use the tools to complete the task first. When you are done, reply with ONLY one JSON object — no prose, no code fences —'
        : 'Reply with ONLY one JSON object — no prose, no code fences, no tool calls —';
      expect(args.messages?.at(-1)?.content).toBe(
        `${prefix} that validates against this JSON Schema (draft 2020-12):\n${JSON.stringify(schema.schema)}`,
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each(['mock', 'opencode-go'])(
    'repair retains tool evidence exactly once: %s (#483)',
    async (provider) => {
      const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-evidence-'));
      // The session binding file lives OUTSIDE the model-editable workspace
      // (Annex A, issue #1197): sessions stay at the scratch root, the bound
      // workspace is the child holding the model-visible fixture.
      const workspace = join(scratchDir, 'workspace');
      await mkdir(workspace);
      await writeFile(join(workspace, 'evidence.txt'), 'observed evidence 483');
      let calls = 0;
      const mock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          calls += 1;
          if (calls === 1) return toolCallResult('read', { path: 'evidence.txt' });
          return textResult(
            calls === 2 ? 'I reviewed the evidence.' : '{"answer":"observed evidence 483"}',
          );
        },
      });
      try {
        const driver = new AiSdkDriver({
          providers: { [provider]: () => mock },
          sessionsDir: join(scratchDir, 'sessions'),
        });
        const result = await driver.run(
          invocation({
            modelSpec: { provider, model: 'mock-1' },
            workspace: { path: workspace },
            toolPolicy: { mode: 'allowlist', allow: ['read'] },
            outputSchema: toOutputSchema('test/evidence/v1', z.object({ answer: z.string() })),
          }),
        );
        expect(result.stopReason).toBe('complete');
        expect(calls).toBe(3);
        const args = lastGenerateTextArgs();
        // The repair keeps the session's definitions, without executors (#502).
        expect(Object.keys(args.tools ?? {})).toEqual(['read']);
        expect(
          (args.tools as Record<string, { execute?: unknown }> | undefined)?.read?.execute,
        ).toBeUndefined();
        expect(args.system).toBe(
          'You are a cq-toolkit worker executing one task. Work inside the provided workspace directory; use the available tools to read, edit, and run. Tool refusals arrive as denial text — adapt instead of retrying the same call.',
        );
        expect(args.system).not.toContain('driver-specific run');
        const messages = args.messages ?? [];
        expect(
          messages.filter(
            (message) => message.role === 'user' && message.content === 'driver-specific run',
          ),
        ).toHaveLength(1);
        expect(messages.filter((message) => message.role === 'tool')).toHaveLength(1);
        const serialized = JSON.stringify(messages);
        expect(serialized.match(/conformance-call-1/g)).toHaveLength(2);
        expect(serialized.match(/I reviewed the evidence\./g)).toHaveLength(1);
        expect(serialized).toContain('observed evidence 483');
        expect(serialized).not.toContain('Use the tools to complete');
        expect(messages.at(-1)?.content).toContain('no tool calls');
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );

  test('forced final step keeps the request and adds the final-step turn (#468, #502)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-final-contract-'));
    // The session binding file lives OUTSIDE the model-editable workspace
    // (Annex A, issue #1197): sessions stay at the scratch root, the bound
    // workspace is the child holding the model-visible fixture.
    const workspace = join(scratchDir, 'workspace');
    await mkdir(workspace);
    const hookKinds: string[] = [];
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        const text = JSON.stringify(options.prompt);
        expect(text.match(/driver-specific run/g)).toHaveLength(1);
        if (offeredToolCount(options) > 0) {
          expect(text).toContain('Use the tools to complete the task first');
          return toolCallResult('read', { path: 'evidence.txt' });
        }
        expect(options.tools?.length).toBe(1);
        expect(text).not.toContain('You have no tools:');
        expect(text).toContain('Use the tools to complete the task first');
        expect(text.match(/This is your final step: do not call any more tools/g)).toHaveLength(1);
        expect(text).toContain('validates against this JSON Schema');
        return textResult('{"answer":"ok"}');
      },
    });
    try {
      await writeFile(join(workspace, 'evidence.txt'), 'safe tool output');
      const driver = new AiSdkDriver({
        providers: { 'opencode-go': () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (_text, _contents, context) => {
          hookKinds.push(context?.kind ?? 'missing');
        },
      });
      const result = await driver.run(
        invocation({
          modelSpec: { provider: 'opencode-go', model: 'mock-1' },
          workspace: { path: workspace },
          toolPolicy: { mode: 'allowlist', allow: ['read'] },
          outputSchema: toOutputSchema('test/final/v1', z.object({ answer: z.string() })),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(calls).toBe(DEFAULT_MAX_STEPS);
      expect(hookKinds.filter((kind) => kind === 'model-request')).toHaveLength(DEFAULT_MAX_STEPS);
      expect(hookKinds).toContain('tool-output');
      expect(hookKinds.at(-1)).toBe('model-request');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each(['<｜DSML｜ calls>', '<|DSML| calls>', '<tool_call>', '<function_call>'])(
    'markup parse failure has a precise diagnostic: %s',
    (markup) =>
      expect(() => parseReplyJson(`${markup}not JSON`)).toThrow(
        'model emitted tool-call markup instead of the JSON reply',
      ),
  );

  test.each(['<｜DSML｜ calls>', '<|DSML| calls>', '<tool_call>', '<function_call>'])(
    'markup-wrapped schema-shaped JSON is rejected: %s',
    (markup) =>
      expect(() => parseReplyJson(`${markup}{"answer":"ok"}</tool_call>`)).toThrow(
        'model emitted tool-call markup instead of the JSON reply',
      ),
  );

  test('literal markup inside a JSON value remains ordinary data', () => {
    const value = { answer: '<tool_call>' };
    for (const text of [
      JSON.stringify(value),
      `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
      `Answer: ${JSON.stringify(value)}`,
    ]) {
      expect(parseReplyJson(text)).toEqual(value);
    }
  });

  test('markup parse failure is repaired once and survives a failed repair (#483)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-markup-'));
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        return textResult('<｜DSML｜ calls>not JSON');
      },
    });
    try {
      const driver = new AiSdkDriver({
        providers: { 'opencode-go': () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          modelSpec: { provider: 'opencode-go', model: 'mock-1' },
          toolPolicy: { mode: 'none', allow: [] },
          outputSchema: toOutputSchema('test/markup/v1', z.object({ answer: z.string() })),
        }),
      );
      expect(calls).toBe(2);
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('model emitted tool-call markup instead of the JSON reply');
      expect(lastGenerateTextArgs().system).toBe(generateTextArgsFromEnd(1).system);
      expect(JSON.stringify(lastGenerateTextArgs())).not.toContain('Use the tools to complete');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('parseReplyJson accepts bare, fenced and embedded objects and refuses prose', () => {
    expect(parseReplyJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseReplyJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseReplyJson('Result: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => parseReplyJson('no json here')).toThrow();
  });
});
