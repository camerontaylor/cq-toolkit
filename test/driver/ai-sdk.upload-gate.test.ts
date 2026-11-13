// The worker upload gate (the former ai-sdk.test.ts upload tests): the
// pre-send scan refusal, serializeRequestForScan's lossy/cyclic payload
// contract, and the configured gitleaks upload policy.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { makeGitleaksFixture } from '../helpers/gitleaks-fixture.js';
import { invocation, textResult, toolCallResult } from './ai-sdk.helpers.js';
import { bindingsFromDispatch } from '../../src/ops/sweep/unit.js';
import { AiSdkDriver, serializeRequestForScan } from '../../src/driver/ai-sdk/index.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';

test.each(['initial', 'read', 'run'] as const)(
  'upload gate refuses %s bytes before the next provider send',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-upload-'));
    // The session binding file lives OUTSIDE the model-editable workspace
    // (Annex A, issue #1197): sessions stay at the scratch root, the bound
    // workspace is the child holding the model-visible fixture.
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    let sends = 0;
    const scanned: string[] = [];
    try {
      await writeFile(join(workspace, 'secret.txt'), 'DO_NOT_UPLOAD');
      const command = process.execPath + ' -e "process.stdout.write(\'DO_NOT_UPLOAD\')"';
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          sends++;
          return mode === 'read'
            ? toolCallResult('read', { path: 'secret.txt' })
            : mode === 'run'
              ? toolCallResult('run', { command })
              : textResult('ok');
        },
      });
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        sandboxConfig: {
          mode: 'off',
          backend: 'auto',
          network: 'allow',
          runTool: 'on',
          envPassthrough: [],
        },
        harnessConfig: {
          ...defaultHarnessConfig,
          tools: {
            ...defaultHarnessConfig.tools,
            bash: { ...defaultHarnessConfig.tools.bash, commandPatterns: ['re:^.*$'] },
          },
        },
        beforeRequest: async (text) => {
          scanned.push(text);
          if (text.includes('DO_NOT_UPLOAD')) throw new Error('upload refused');
        },
      });
      const result = await driver.run(
        invocation({
          prompt: mode === 'initial' ? 'DO_NOT_UPLOAD' : 'safe',
          workspace: { path: workspace },
          budget: {},
        }),
      );
      expect(result.stopReason).not.toBe('complete');
      expect(sends).toBe(mode === 'initial' ? 0 : 1);
      expect(scanned.at(-1)).toContain('DO_NOT_UPLOAD');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('upload serialization preserves undefined slots and refuses lossy or cyclic payloads', () => {
  expect(serializeRequestForScan({ prompt: ['safe', undefined], optional: undefined })).toBe(
    '{"prompt":["safe","[undefined]"],"optional":"[undefined]"}',
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const bad of [
    undefined,
    { text: NaN },
    { text: Infinity },
    { text: () => 'hidden' },
    { text: Symbol('hidden') },
    { text: 1n },
    { text: new Map([['hidden', 'secret']]) },
    { text: { hidden: 'secret', toJSON: () => 'safe' } },
    cyclic,
  ])
    expect(() => serializeRequestForScan(bad)).toThrow();
});

test.each(['private', 'public', 'newline', 'prompt'] as const)(
  'configured upload policy preserves source paths and decoded text (%s)',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-path-upload-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const gitleaks = await makeGitleaksFixture();
    vi.stubEnv('PATH', gitleaks.path);
    let sends = 0;
    try {
      await writeFile(
        join(root, 'patterns.yml'),
        [
          'rules:',
          '  - id: private-path',
          '    description: private fixture path',
          "    regex: '.+'",
          "    path: '(^|/)private\\.txt$'",
          "    sample: 'ordinary private bytes'",
          '  - id: bounded-word',
          '    description: bounded fixture token',
          "    regex: '\\bBLOCKEDWORD\\b'",
          "    sample: 'BLOCKEDWORD'",
          'clean_probes:',
          "  - 'ordinary public bytes'",
          '',
        ].join('\n'),
      );
      const file = mode === 'private' ? 'private.txt' : 'public.txt';
      // The model reads this through the driver workspace (the child);
      // the scanner config above resolves against the dispatch repoRoot.
      await writeFile(
        join(workspace, file),
        mode === 'newline' ? '\nBLOCKEDWORD' : 'ordinary private bytes',
      );
      const bindings = bindingsFromDispatch(
        {
          repoRoot: root,
          runPrefix: 'fixture',
          base: 'HEAD',
          package: 'fixture',
          fixer: 'fixture',
          files: [],
          mutex: { lockPath: join(root, 'mutex') },
          driver: { provider: 'mock', model: 'mock-1', budget: { wallClockMs: 10000 } },
          check: { adapter: 'vitest-json', command: 'node', args: [] },
          taskLoop: { denylistPatternsFile: 'patterns.yml' },
        },
        {
          resolve: ({ modelSpec }) => ({
            modelSpec,
            lane: 'ai-sdk',
            driver: {
              run: async () => {
                throw new Error('unused');
              },
            },
          }),
        },
      );
      expect(bindings.scanPrompt).toBeDefined();
      await expect(bindings.scanPrompt?.('safe')).resolves.toBeUndefined();
      await expect(bindings.scanPrompt?.('\nBLOCKEDWORD')).rejects.toThrow(
        'worker upload refused by denylist scan',
      );
      vi.stubEnv('CQ_TEST_GITLEAKS_EXIT', '2');
      await expect(bindings.scanPrompt?.('safe')).rejects.toThrow('gitleaks failed to run');
      vi.stubEnv('CQ_TEST_GITLEAKS_EXIT', '0');
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          sends++;
          return sends === 1 && mode !== 'prompt'
            ? toolCallResult('read', { path: file })
            : textResult('done');
        },
      });
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        ...(bindings.scanPrompt === undefined ? {} : { beforeRequest: bindings.scanPrompt }),
      });
      const result = await driver.run(
        invocation({
          prompt: mode === 'prompt' ? '\nBLOCKEDWORD' : 'safe',
          workspace: { path: workspace },
          budget: {},
        }),
      );
      expect(sends).toBe(mode === 'public' ? 2 : mode === 'prompt' ? 0 : 1);
      expect(result.stopReason === 'complete').toBe(mode === 'public');
      if (mode === 'prompt') expect(result.error).toContain('worker upload refused by scan');
      expect((await gitleaks.calls()).length).toBeGreaterThan(3);
    } finally {
      vi.unstubAllEnvs();
      await rm(gitleaks.root, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);
