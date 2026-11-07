// Split provenance: test/ops/review/reviewSession-wire.test.ts was split into
// subject files sharing ./reviewSession-wire.helpers.ts. This file holds the
// model-request delivery hook suite.
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { RunOptions, WorkerResult } from '../../../src/driver/types.js';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import { runReviewSession } from '../../../src/ops/review/internal/reviewSession.js';
import {
  DIFF,
  evidenceFor,
  expectUserPrompt,
  planFor,
  recordingScanner,
  runInput,
  scratch,
  sha,
  textResult,
  useScratchRoots,
  wireFactory,
  type WireCall,
} from './reviewSession-wire.helpers.js';

useScratchRoots();

describe('review session wire hook', () => {
  it('delivers on the model-request hook that carries the exact prompt', async () => {
    const root = await scratch();
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () =>
        textResult(
          JSON.stringify({
            findings: [
              { file: 'src/a.ts', line: 2, rule: 'wire', severity: 'high', text: 'grounded' },
            ],
          }),
        ),
    });
    const evidence = evidenceFor();
    let used = 0;
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      scanSecrets: recordingScanner(scanCalls),
      onUsage: (usage) => {
        used +=
          usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);
      },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('model-request');
    expect(calls[0]!.contents.some((content) => content.text === plan.prompt)).toBe(true);
    expectUserPrompt(calls[0]!.text, plan.prompt);
    expect(scanCalls).toHaveLength(1);
    expect(evidence.requests).toHaveLength(1);
    expect(evidence.deliveries).toEqual([
      { component: 'tracked:src/a.ts', start: 0, end: DIFF.length, sha256: sha(DIFF) },
    ]);
    expect(evidence.status).toBe('complete');
    expect(evidence.denials).toBe(0);
    expect(typeof evidence.driverSessionId).toBe('string');
    expect(evidence.driverSessionId).not.toBe('');
    expect(used).toBeGreaterThan(0);
    expect(result.value[0]).toMatchObject({
      id: 'session-1-1',
      file: 'src/a.ts',
      line: 2,
      rule: 'wire',
      severity: 'major',
      text: 'grounded',
      status: 'open',
    });
  });

  it('records a clean model-request with a non-matching prompt but never delivers', async () => {
    const root = await scratch();
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    const evidence = evidenceFor();
    const worker: WorkerResult = {
      stopReason: 'complete',
      structuredOutput: { findings: [] },
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      steps: 1,
      denials: [],
    };
    const factory: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
        driver: {
          run: async () => {
            const other = 'a different user turn';
            await request.beforeRequest?.(other, [{ text: other }], {
              kind: 'model-request',
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
    expect(evidence.requests).toHaveLength(1);
    expect(evidence.deliveries).toHaveLength(0);
    expect(evidence.status).toBe('error');
  });
});

it.each([undefined, true])(
  'review session forwards countdown opt-in (%s)',
  async (stepCountdown) => {
    const root = await scratch();
    const optionsSeen: Array<RunOptions | undefined> = [];
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => textResult('{"findings":[]}'),
    });
    const underlying = wireFactory(root, model, []);
    const factory: DriverFactory = {
      resolve(request) {
        const resolved = underlying.resolve(request);
        return {
          ...resolved,
          driver: {
            run: async (invocation, options) => {
              optionsSeen.push(options);
              return resolved.driver.run(invocation, options);
            },
          },
        };
      },
    };
    const result = await runReviewSession(factory, {
      ...runInput(root, planFor(), evidenceFor()),
      scanSecrets: recordingScanner([]),
      onUsage: () => {},
      ...(stepCountdown === undefined ? {} : { stepCountdown }),
    });
    expect(result.status).toBe('ok');
    expect(optionsSeen).toHaveLength(1);
    if (stepCountdown === undefined)
      expect(optionsSeen[0]).not.toHaveProperty('reviewerStepCountdown');
    else expect(optionsSeen[0]).toHaveProperty('reviewerStepCountdown', true);
  },
);

it('binds a context-only hash to the planned prompt across evidence repair', async () => {
  const root = await scratch();
  const calls: WireCall[] = [];
  const plan = { ...planFor(), contextOnly: true, placements: [] };
  const finding = {
    file: 'src/a.ts',
    line: 2,
    rule: 'wire',
    severity: 'high',
    text: 'grounded',
  };
  let turn = 0;
  const model = new MockLanguageModelV4({
    modelId: 'mock-1',
    doGenerate: async () => {
      turn++;
      return textResult(
        JSON.stringify({
          findings: [
            turn === 1
              ? finding
              : {
                  ...finding,
                  evidenceV1: {
                    version: 1,
                    failureScenario: 'the value stays zero',
                    primary: {
                      file: 'src/a.ts',
                      side: 'head',
                      start: 1,
                      end: 1,
                      quote: 'export const value = 1;',
                    },
                    supporting: [],
                  },
                },
          ],
        }),
      );
    },
  });
  const evidence = evidenceFor();
  const result = await runReviewSession(wireFactory(root, model, calls), {
    ...runInput(root, plan, evidence),
    scanSecrets: recordingScanner([]),
    onUsage: () => {},
    evidenceContext: {
      blobs: new Map([
        [
          'src/a.ts',
          {
            base: undefined,
            head: 'export const value = 1;\n',
            baseHunks: [],
            headHunks: [{ start: 1, end: 2 }],
          },
        ],
      ]),
      renames: new Map(),
    },
  });
  expect(result.status).toBe('ok');
  expect(calls).toHaveLength(2);
  expect(evidence.requests).toHaveLength(2);
  expect(evidence.contextSha256).toBe(sha(plan.prompt));
});
