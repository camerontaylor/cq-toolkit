// Split provenance: test/ops/review/reviewSession-wire.test.ts was split into
// subject files sharing ./reviewSession-wire.helpers.ts. This file holds the
// tool-output hook suite: those hooks are scanned but never deliver a prompt.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { serializeRequestForScan } from '../../../src/driver/ai-sdk/index.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { WorkerResult } from '../../../src/driver/types.js';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import { runReviewSession } from '../../../src/ops/review/internal/reviewSession.js';
import {
  evidenceFor,
  expectUserPrompt,
  planFor,
  recordingScanner,
  runInput,
  scratch,
  textResult,
  toolCallResult,
  useScratchRoots,
  wireFactory,
  type WireCall,
} from './reviewSession-wire.helpers.js';

useScratchRoots();

describe('review session wire hook', () => {
  it('never delivers from a tool-output hook even when its text is the exact serialized prompt', async () => {
    const root = await scratch();
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    let firstSerialized = '';
    let generated = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        generated += 1;
        if (generated === 1) {
          firstSerialized = serializeRequestForScan(options);
          await writeFile(join(root, 'src/a.ts'), firstSerialized, 'utf8');
          return toolCallResult('read', { path: 'src/a.ts' });
        }
        return textResult(JSON.stringify({ findings: [] }));
      },
    });
    const evidence = evidenceFor();
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(generated).toBe(2);
    expect(calls.map((call) => call.kind)).toEqual([
      'model-request',
      'tool-output', // read result upload scan
      'tool-output', // retained assistant tool-call diagnostic scan
      'model-request',
    ]);
    expect(calls[1]!.text).not.toBe(calls[0]!.text);
    expect(calls[1]!.text.startsWith('--- src/a.ts ---\n')).toBe(true);
    expect(calls[1]!.text).toContain('     1: ');
    expect(calls[1]!.text).toContain(calls[0]!.text.slice(0, 1_000));
    expect(calls[1]!.text).toContain('… [line truncated at 2000 chars]');
    expect(firstSerialized).toBe(calls[0]!.text);
    expect(calls[1]!.contents.some((content) => content.text === plan.prompt)).toBe(false);
    expect(scanCalls).toHaveLength(4);
    expect(JSON.parse(calls[2]!.text)).toMatchObject({
      toolCalls: [{ toolName: 'read', input: { file_path: 'src/a.ts' } }],
    });
    expect(scanCalls[2]!.some((component) => component.text === 'src/a.ts')).toBe(true);
    // The model sees the numbered display; the guard also receives the raw
    // selected lines with path provenance.
    expect(scanCalls[1]!.some((component) => component.text === calls[1]!.text)).toBe(true);
    expect(
      scanCalls[1]!.some(
        (component) => component.path === 'src/a.ts' && component.text === firstSerialized,
      ),
    ).toBe(true);
    expect(evidence.requests).toHaveLength(2);
    expect(evidence.deliveries).toHaveLength(1);
    expect(evidence.status).toBe('complete');
    expect(evidence.denials).toBe(0);
    expect(typeof evidence.driverSessionId).toBe('string');
    expect(evidence.driverSessionId).not.toBe('');
  });

  it('a fake tool-output hook with the exact request and prompt is scanned but blocked', async () => {
    const root = await scratch();
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    const evidence = evidenceFor();
    const exactRequest = serializeRequestForScan({
      prompt: [{ role: 'user', content: [{ type: 'text', text: plan.prompt }] }],
    });
    expectUserPrompt(exactRequest, plan.prompt);
    const worker: WorkerResult = {
      stopReason: 'complete',
      structuredOutput: { findings: [] },
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      steps: 1,
      denials: [],
    };
    // Clearly fake: the only hook is a tool-output guard carrying the exact
    // serialized request and the exact decoded prompt. No model send exists.
    const factory: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
        driver: {
          run: async () => {
            await request.beforeRequest?.(exactRequest, [{ text: plan.prompt }], {
              kind: 'tool-output',
            });
            return worker;
          },
        },
      }),
    };
    const result = await runReviewSession(factory, {
      ...runInput(root, plan, evidence),
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('without scanned content delivery');
    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0]!.some((component) => component.text === exactRequest)).toBe(true);
    expect(scanCalls[0]!.some((component) => component.text === plan.prompt)).toBe(true);
    expect(evidence.requests).toHaveLength(0);
    expect(evidence.deliveries).toHaveLength(0);
    expect(evidence.status).toBe('error');
  });
});
