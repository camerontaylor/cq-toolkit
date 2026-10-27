import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { SessionStore, SessionLineSchema } from '../../src/harness/session.js';
import type { OpInvocation } from '../../src/driver/types.js';
import { WorkerResultSchema } from '../../src/driver/schema.js';
import { CqConfigSchema } from '../../src/ops/analyze/cqConfig.js';
import { resolveCqConfigDefaults } from '../../src/ops/analyze/cqConfigDefaults.js';

function reply(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
  };
}
function call(name: string, input: unknown, id = 'call-1'): LanguageModelV4GenerateResult {
  return {
    ...reply(''),
    content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: undefined },
  };
}

async function run(
  steps: LanguageModelV4GenerateResult[],
  flag: boolean,
  overrides: Partial<OpInvocation> = {},
  scan = true,
) {
  const root = await mkdtemp(join(tmpdir(), 'cq-failures-'));
  const sessions = join(root, 'sessions');
  const store = new SessionStore(sessions);
  const record = await store.create(root);
  const guard = vi.fn(
    (text: string, contents?: readonly { text: string }[], context?: { kind: string }) => {
      if (
        context?.kind === 'tool-output' &&
        [text, ...(contents ?? []).map((content) => content.text)].some((value) =>
          /\bPRIVATE_SENTINEL\b/.test(value),
        )
      )
        throw new Error('secret');
    },
  );
  await writeFile(join(root, 'sample.txt'), 'sample text');
  const model = new MockLanguageModelV4({ modelId: 'mock', doGenerate: steps });
  const driver = new AiSdkDriver({
    providers: { mock: () => model },
    sessionsDir: sessions,
    harnessConfig: {
      ...defaultHarnessConfig,
      logToolFailures: flag,
      tools: {
        ...defaultHarnessConfig.tools,
        bash: { enabled: true, commandPatterns: ['false', 'pwd', 're:^while .*'], timeoutMs: 15 },
      },
    },
    ...(scan ? { beforeRequest: guard } : {}),
  });
  try {
    const result = await driver.run({
      prompt: 'Complete the task',
      modelSpec: { provider: 'mock', model: 'mock' },
      sessionRef: record.sessionId,
      toolPolicy: { mode: 'unrestricted', allow: [] },
      sandboxPolicy: { level: 'workspace-write' },
      budget: { maxSteps: 3 },
      ...overrides,
    });
    const raw = await readFile(join(sessions, `${record.sessionId}.jsonl`), 'utf8');
    const lines = raw
      .trim()
      .split('\n')
      .map((line) => SessionLineSchema.parse(JSON.parse(line)));
    const loaded = await store.load(record.sessionId);
    expect(WorkerResultSchema.safeParse(result).success).toBe(true);
    return {
      result,
      requests: model.doGenerateCalls,
      lines,
      failures: lines.filter((line) => line.type === 'tool-failure'),
      loaded,
      raw,
      guard,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('tool failure evidence', () => {
  test('advertises only canonical fields while aliases validate and execute', async () => {
    const { result, requests, loaded } = await run(
      [call('read', { filePath: 'sample.txt', file_path: 'sample.txt' }), reply('done')],
      true,
    );
    expect(result.toolFailures).toBe(0);
    expect(
      loaded?.messages.some(
        (message) => message.role === 'tool' && message.content.includes('sample text'),
      ),
    ).toBe(true);
    const tools = requests[0]!.tools!;
    const expected = {
      read: ['file_path', 'offset', 'limit'],
      edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
      write: ['file_path', 'content'],
      bash: ['command', 'timeout', 'description', 'workdir', 'run_in_background'],
      run: ['command', 'timeout', 'description', 'workdir', 'run_in_background'],
    };
    for (const descriptor of tools) {
      if (descriptor.type !== 'function') continue;
      const schema = descriptor.inputSchema as unknown as {
        properties: Record<string, unknown>;
        additionalProperties: boolean;
      };
      expect(Object.keys(schema.properties ?? {})).toEqual(
        expected[descriptor.name as keyof typeof expected],
      );
      expect(schema.additionalProperties).toBe(false);
    }
    expect(
      tools
        .filter((descriptor) => descriptor.type === 'function')
        .map((descriptor) => descriptor.name)
        .sort(),
    ).toEqual(Object.keys(expected).sort());
  });

  test.each([false, true])(
    'invalid schema input logs only with flag=%s and counts once',
    async (flag) => {
      const { result, failures, loaded } = await run(
        [call('read', { file_path: 'x', unknown_option: true }), reply('done')],
        flag,
      );
      expect(result.toolFailures).toBe(1);
      expect(failures).toHaveLength(flag ? 1 : 0);
      if (flag)
        expect(failures[0]).toMatchObject({
          kind: 'invalid-input',
          tool: 'read',
          inputSummary: expect.stringContaining('unknown_option') as unknown,
          step: 0,
        });
      expect(loaded?.messages.every((message) => message.role !== 'tool')).toBe(true);
    },
  );

  test('unknown tools and harness denials are logged once each', async () => {
    const unknown = await run([call('not_a_tool', { path: 'x' }), reply('done')], true);
    expect(unknown.result.toolFailures).toBe(1);
    expect(unknown.failures[0]).toMatchObject({ kind: 'unknown-tool', tool: 'not_a_tool' });
    const denied = await run([call('read', { file_path: '../outside' }), reply('done')], true);
    expect(denied.result.toolFailures).toBe(1);
    expect(denied.failures[0]).toMatchObject({
      kind: 'denial',
      reason: expect.stringContaining('path escape') as unknown,
    });
  });

  test('execution failures, timeouts, and advisory bash descriptions are recorded', async () => {
    for (const command of ['false', 'while true; do :; done']) {
      const { result, failures, loaded } = await run(
        [call('bash', { command, description: 'Run diagnostic' }), reply('done')],
        true,
      );
      expect(result.toolFailures).toBe(command === 'false' ? 0 : 1);
      if (command === 'false') expect(failures).toHaveLength(0);
      else expect(failures[0]).toMatchObject({ kind: 'execution' });
      expect(loaded?.messages.find((message) => message.toolName === 'bash')?.description).toBe(
        'Run diagnostic',
      );
    }
  });

  test('final-step calls and repair-step calls stay unexecuted and log even reused call IDs', async () => {
    const schema = {
      name: 'answer',
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    };
    const { result, failures } = await run(
      [call('read', { file_path: 'not-read' }), call('read', { file_path: 'not-read' })],
      true,
      { budget: { maxSteps: 1 }, outputSchema: schema },
    );
    expect(result.toolFailures).toBe(2);
    expect(failures.map((failure) => failure.kind)).toEqual(['final-step', 'repair-step']);
    expect(failures.map((failure) => failure.step)).toEqual([0, 1]);
  });

  test('a rejected diagnostic scan redacts the entire record; no scanner omits values', async () => {
    // Diagnostics are scanned independently of model requests.
    const scanned = await run(
      [call('not_a_tool', { secret: 'PRIVATE_SENTINEL' }), reply('done')],
      true,
    );
    expect(scanned.result.stopReason).toBe('complete');
    expect(scanned.failures[0]).toMatchObject({
      tool: '[redacted]',
      reason: '[redacted: diagnostic scan refused]',
      inputSummary: '[redacted: diagnostic scan refused]',
    });
    expect(scanned.raw).not.toContain('PRIVATE_SENTINEL');
    const noScan = await run(
      [call('not_a_tool', { secret: 'PRIVATE_SENTINEL' }), reply('done')],
      true,
      {},
      false,
    );
    expect(noScan.result.stopReason).toBe('complete');
    expect(noScan.raw).not.toContain('PRIVATE_SENTINEL');
    expect(noScan.failures[0]?.inputSummary).toContain('omitted');
  });

  test.each([{ nested: ['\nPRIVATE_SENTINEL'] }, { nested: { ['\nPRIVATE_SENTINEL']: 'value' } }])(
    'diagnostic scans include decoded nested strings and keys: %j',
    async (input) => {
      const scanned = await run([call('not_a_tool', input), reply('done')], true);
      expect(scanned.result.stopReason).toBe('complete');
      expect(scanned.failures[0]?.inputSummary).toBe('[redacted: diagnostic scan refused]');
      expect(scanned.raw).not.toContain('PRIVATE_SENTINEL');
    },
  );

  test('failure line survives store append/load and old session schemas still parse', async () => {
    const { failures, loaded } = await run(
      [call('read', { unexpected: 'x' }), reply('done')],
      true,
    );
    expect(failures).toHaveLength(1);
    expect(loaded?.messages.at(-1)?.role).toBe('assistant');
    expect(
      SessionLineSchema.safeParse({
        type: 'message',
        message: { role: 'user', content: 'old', at: 'then' },
      }).success,
    ).toBe(true);
  });

  test('cq.json opt-in resolves through defaults and remains strict', async () => {
    const config = {
      schemaVersion: 2 as const,
      checks: [{ adapter: 'tsc-lines' as const, command: { command: 'tsc', args: [] } }],
    };
    expect(
      CqConfigSchema.safeParse({ ...config, harness: { logToolFailures: true } }).success,
    ).toBe(true);
    expect(
      resolveCqConfigDefaults(config, { packageName: 'fixture' }).harness.logToolFailures,
    ).toBe(false);
    expect(
      resolveCqConfigDefaults(
        { ...config, harness: { logToolFailures: true } },
        { packageName: 'fixture' },
      ).harness.logToolFailures,
    ).toBe(true);
    expect(CqConfigSchema.safeParse({ ...config, harness: { unknown: true } }).success).toBe(false);
  });
});
