// Read/grep scan provenance (parts of the former ai-sdk.test.ts): the
// executor-provenance normalization on the upload scan (under the
// "ai-sdk driver specifics" describe) and the raw-scan vs persisted-display
// stripping contract.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { invocation, offeredToolCount, textResult, toolCallResult } from './ai-sdk.helpers.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { probeRgVersion } from '../../src/harness/tools.js';

// grep needs a runnable rg >= RG_MINIMUM_VERSION; the driver withholds grep
// otherwise, so this leg can only exercise the raw-scan path where rg works.
const rgUsable = (await probeRgVersion()).ok === true;

describe('ai-sdk driver specifics (mock model)', () => {
  test('read upload scanning uses normalized executor provenance for file_path', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-read-provenance-'));
    // The session binding file lives OUTSIDE the model-editable workspace
    // (Annex A, issue #1197): sessions stay at the scratch root, the bound
    // workspace is the child holding the model-visible fixture.
    const workspace = join(scratchDir, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'secret.ts'), 'api_key = "fixture-secret"\n', 'utf8');
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        if (calls === 1 && offeredToolCount(options) > 0) {
          return toolCallResult('read', { file_path: 'secret.ts', offset: 1, limit: 1 });
        }
        return textResult('read complete');
      },
    });
    const guarded: { text: string; path?: string }[] = [];
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (_text, contents = []) => {
          guarded.push(...contents);
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { mode: 'allowlist', allow: ['read'] },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      const guardedSecret = guarded.find((content) => content.path === 'secret.ts');
      expect(guardedSecret).toBeDefined();
      expect(guardedSecret?.text).toContain('fixture-secret');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('grep upload scanning uses normalized executor provenance for matched files', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-grep-provenance-'));
    const workspace = join(scratchDir, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'secret.ts'), 'api_key = "fixture-secret"\n', 'utf8');
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        if (calls === 1 && offeredToolCount(options) > 0) {
          return toolCallResult('grep', { pattern: 'fixture-secret' });
        }
        return textResult('search complete');
      },
    });
    const guarded: { text: string; path?: string }[] = [];
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        // The provenance test needs grep SERVED: inject an ok rg (the host's
        // rg may be older than the documented minimum).
        resolveRg: async () => ({ ok: true, version: '15.2.0' }),
        beforeRequest: async (_text, contents = []) => {
          guarded.push(...contents);
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { mode: 'allowlist', allow: ['grep'] },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      const guardedSecret = guarded.find((content) => content.path === 'secret.ts');
      expect(guardedSecret).toBeDefined();
      expect(guardedSecret?.text).toContain('fixture-secret');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

describe('read/grep raw scan provenance + persist stripping', () => {
  test('read: guard receives RAW unformatted lines under the real path (line-anchored rules match)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rawread-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    try {
      // The numbered display shifts the line: '^CONFIDENTIAL:' anchors on the
      // RAW source line, which the display '     1: CONFIDENTIAL: x' breaks.
      await writeFile(join(workspace, 'secret.txt'), 'CONFIDENTIAL: top-secret-value\n', 'utf8');
      const guarded: { text: string; path?: string }[] = [];
      let modelCalls = 0;
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async (options) => {
          modelCalls++;
          if (modelCalls === 1 && offeredToolCount(options) > 0) {
            return toolCallResult('read', { path: 'secret.txt' });
          }
          return textResult('done');
        },
      });
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        beforeRequest: async (_text, contents = []) => {
          guarded.push(...contents);
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      const raw = guarded.find((c) => c.path === 'secret.txt');
      expect(raw).toBeDefined();
      // The RAW line: a ^CONFIDENTIAL: rule matches; the numbered display line would not.
      expect(raw?.text).toBe('CONFIDENTIAL: top-secret-value');
      expect(raw?.text).not.toContain('     1:');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('read: sourceContents are scan-only — NOT persisted into the session transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-nopersist-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    try {
      await writeFile(join(workspace, 'secret.txt'), 'CONFIDENTIAL: top-secret-value\n', 'utf8');
      let modelCalls = 0;
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async (options) => {
          modelCalls++;
          if (modelCalls === 1 && offeredToolCount(options) > 0) {
            return toolCallResult('read', { path: 'secret.txt' });
          }
          return textResult('done');
        },
      });
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        beforeRequest: async () => {}, // guard present (scan runs), contract unconditional
      });
      await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      // Every persisted tool message: no sourceContents key anywhere.
      const storeDir = join(root, 'sessions');
      const persisted: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) await walk(p);
          else if (entry.name.endsWith('.jsonl')) persisted.push(await readFile(p, 'utf8'));
        }
      };
      await walk(storeDir);
      expect(persisted.length).toBeGreaterThan(0);
      for (const body of persisted) expect(body).not.toContain('sourceContents');
      // The DISPLAY output is persisted (the model needs it on replay).
      expect(persisted.some((b) => b.includes('CONFIDENTIAL: top-secret-value'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!rgUsable)(
    'grep: guard receives RAW matched lines (anchors intact), display stays numbered',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'aidrv-rawgrep-'));
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      try {
        await writeFile(join(workspace, 'secret.txt'), 'CONFIDENTIAL: grep-secret-value\n', 'utf8');
        const guarded: { text: string; path?: string }[] = [];
        let modelCalls = 0;
        const model = new MockLanguageModelV4({
          modelId: 'mock-1',
          doGenerate: async (options) => {
            modelCalls++;
            if (modelCalls === 1 && offeredToolCount(options) > 0) {
              return toolCallResult('grep', { pattern: 'grep-secret-value' });
            }
            return textResult('done');
          },
        });
        const driver = new AiSdkDriver({
          providers: { mock: () => model },
          sessionsDir: join(root, 'sessions'),
          beforeRequest: async (_text, contents = []) => {
            guarded.push(...contents);
          },
        });
        const result = await driver.run(
          invocation({
            workspace: { path: workspace },
            toolPolicy: { allow: ['grep'], mode: 'allowlist' },
            sandboxPolicy: { level: 'read-only' },
          }),
        );
        expect(result.stopReason).toBe('complete');
        const raw = guarded.find((c) => c.path === 'secret.txt');
        expect(raw).toBeDefined();
        expect(raw?.text).toBe('CONFIDENTIAL: grep-secret-value');
        expect(raw?.text).not.toContain('     1:');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
