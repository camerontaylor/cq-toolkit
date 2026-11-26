/**
 * Runs the PRODUCTION `judge-cq.mjs` under Node against a stub `cq_bin` tree
 * (a recording `AiSdkDriver`, an identity served-model wrapper and a default
 * harness config) and compares what it hands the driver and prints with the
 * TypeScript schema, system-prompt cap and stop mapping.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  judgeEnvelope,
  judgeOutputSchema,
  judgeSystemPromptCap,
} from '../../../src/policy/crq/triageJudge.js';

const BRIDGE = fileURLToPath(
  new URL('../../../apps/crq-python/crq_repair/judge-cq.mjs', import.meta.url),
);

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'crq-judge-bridge-'));
  mkdirSync(join(root, 'driver/ai-sdk'), { recursive: true });
  mkdirSync(join(root, 'harness'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(root, 'driver/ai-sdk/index.js'),
    `import {writeFileSync} from 'node:fs';
export class AiSdkDriver {
  constructor(options) { this.options = options; }
  async run(input) {
    writeFileSync(process.env.STUB_CAPTURE, JSON.stringify({options: this.options, input}));
    return JSON.parse(process.env.STUB_REPORT);
  }
}`,
  );
  writeFileSync(
    join(root, 'driver/served-model.js'),
    'export const withServedModelAssertion = (driver) => driver;',
  );
  writeFileSync(
    join(root, 'harness/config.js'),
    'export const defaultHarnessConfig = {promptBudget: {maxSystemPromptChars: 1, keep: 2}, other: 3};',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function runBridge(schema: string | undefined, report: unknown) {
  const request = join(root, 'request.json');
  const capture = join(root, 'capture.json');
  writeFileSync(
    request,
    JSON.stringify({
      cq_bin: join(root, 'cli.js'),
      modelSpec: { provider: 'p', model: 'm' },
      budget: { wallClockMs: 1 },
      prompt: 'P',
      ...(schema === undefined ? {} : { schema }),
    }),
  );
  const done = spawnSync('node', [BRIDGE, request], {
    encoding: 'utf8',
    env: { ...process.env, STUB_CAPTURE: capture, STUB_REPORT: JSON.stringify(report) },
  });
  expect(done.status, done.stderr).toBe(0);
  return {
    stdout: done.stdout,
    captured: JSON.parse(readFileSync(capture, 'utf8')) as {
      options: { harnessConfig?: { promptBudget: Record<string, number>; other: number } };
      input: Record<string, unknown>;
    },
  };
}

const REPORTS: Array<[string, Record<string, unknown>]> = [
  ['complete', { stopReason: 'complete', structuredOutput: { verdict: 'valid', reason: 'r' } }],
  ['rate-limit class', { stopReason: 'error', errorClass: 'rate-limit', error: 'e' }],
  ['quota class', { stopReason: 'error', errorClass: 'quota', error: 'e' }],
  ['other error class', { stopReason: 'error', errorClass: 'auth', error: 'denied' }],
  ['budget stop', { stopReason: 'budget', usage: { tokens: 3 }, providerSignals: ['s'] }],
  ['no structured output', { stopReason: 'complete' }],
  [
    'reason from output wins over error',
    {
      stopReason: 'complete',
      structuredOutput: { verdict: 'unsure', reason: 'x', stop: 'overridden' },
      error: 'ignored',
    },
  ],
  ['stop absent', {}],
];

describe('judge-cq.mjs against the TypeScript bridge model', () => {
  for (const schema of [undefined, 'crq.triage/v1', 'something-else']) {
    test(`output schema and prompt cap for ${String(schema)}`, () => {
      const { captured } = runBridge(schema, { stopReason: 'complete' });
      expect(captured.input.outputSchema).toEqual(judgeOutputSchema(schema));
      expect(captured.input.toolPolicy).toEqual({ mode: 'none', allow: [] });
      expect(captured.input.sandboxPolicy).toEqual({ level: 'read-only' });
      const cap = judgeSystemPromptCap(schema);
      if (cap === null) expect(captured.options.harnessConfig).toBeUndefined();
      else {
        expect(captured.options.harnessConfig).toEqual({
          promptBudget: { maxSystemPromptChars: cap, keep: 2 },
          other: 3,
        });
      }
    });
  }
  for (const [name, report] of REPORTS) {
    test(`envelope for ${name}`, () => {
      const { stdout } = runBridge(undefined, report);
      expect(stdout.trim()).toBe(judgeEnvelope(report));
    });
  }
});
