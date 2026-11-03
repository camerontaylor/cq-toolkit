// Seam v2 (ADR-0002 §2.1/§2.4) — RunOptions.signal cancellation and the
// workspace binding (the former ai-sdk.test.ts seam-v2 describe).
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import {
  conformanceHarnessConfig,
  invocation,
  modelFor,
  textResult,
  thrownBy,
} from './ai-sdk.helpers.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { SessionStore } from '../../src/harness/session.js';

// ---------------------------------------------------------------------------
// Seam v2 (ADR-0002 §2.1/§2.4) — RunOptions.signal + the workspace binding
// ---------------------------------------------------------------------------

describe('ai-sdk driver seam v2: RunOptions.signal + workspace binding', () => {
  test('a PRE-ABORTED options.signal never dispatches: aborted, zero usage, no session state', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s2-'));
    try {
      let modelCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                modelCalls += 1;
                return textResult('must never run');
              },
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const controller = new AbortController();
      controller.abort();
      const result = await driver.run(invocation(), { signal: controller.signal });
      expect(result.stopReason).toBe('aborted');
      // ZERO usage, no denials, and NO sessionId: no record was created for
      // a run that never dispatched.
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.denials).toEqual([]);
      expect(result.sessionId).toBeUndefined();
      expect(modelCalls).toBe(0); // the scripted model was never called
      // No session state either — the store directory was never created.
      await expect(
        readdir(join(scratchDir, 'sessions')).catch((err: NodeJS.ErrnoException) => err),
      ).resolves.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an options.signal fired MID-RUN settles aborted — no governor in the loop', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s2-'));
    try {
      // No runLadder: the ambient governed context is UNDEFINED here, so the
      // only cancellation source is options.signal — the seam-v2 wiring.
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor({ kind: 'block-until-abort' }, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      const result = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }), {
        signal: controller.signal,
      });
      expect(result.stopReason).toBe('aborted');
      expect(result.error).toBeUndefined(); // the cancellation is not a failure
      // Usage observed so far: no step completed before the abort → zeros.
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace binding: the tool write lands in workspace.path; the record stays in sessionsDir recording the realpath', async () => {
    // realpath the scratch parent so the bound dir IS its own realpath
    // (macOS /var → /private/var) — the assertions then read literally.
    const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'aidrv-s2-')));
    try {
      const workspaceDir = join(scratchDir, 'ws');
      await mkdir(workspaceDir);
      const driver = new AiSdkDriver({
        providers: {
          mock: (modelId) =>
            modelFor(
              {
                kind: 'tool-then-reply',
                tool: 'run',
                input: { command: 'echo conformance-marker > note.txt' },
                reply: 'wrote note.txt',
              },
              modelId,
            ),
        },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sandboxConfig: {
          mode: 'off',
          backend: 'auto',
          network: 'model-only',
          runTool: 'on',
          envPassthrough: [],
        },
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['run'], mode: 'allowlist' },
          sandboxPolicy: { level: 'workspace-write' },
          workspace: { path: workspaceDir },
        }),
      );
      expect(result.stopReason).toBe('complete');
      // The record was created in the LANE's sessionsDir — never in the
      // workspace — and records the bound REALPATH as its workspace.
      const record = await new SessionStore(join(scratchDir, 'sessions')).load(
        result.sessionId as string,
      );
      expect(record?.workspace).toBe(workspaceDir);
      // The run tool really executed INSIDE the bound workspace.
      await expect(readFile(join(workspaceDir, 'note.txt'), 'utf8')).resolves.toContain(
        'conformance-marker',
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace + sessionRef: the same realpath resumes; a different one throws config PRE-DISPATCH', async () => {
    const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'aidrv-s2-')));
    try {
      const workspaceDir = join(scratchDir, 'ws');
      const otherDir = join(scratchDir, 'other');
      await mkdir(workspaceDir);
      await mkdir(otherDir);
      let modelCalls = 0;
      const freshDriver = (): AiSdkDriver =>
        new AiSdkDriver({
          providers: {
            mock: () =>
              new MockLanguageModelV4({
                modelId: 'mock-1',
                doGenerate: async () => {
                  modelCalls += 1;
                  return textResult('ok');
                },
              }),
          },
          sessionsDir: join(scratchDir, 'sessions'),
        });
      const run1 = await freshDriver().run(invocation({ workspace: { path: workspaceDir } }));
      expect(run1.stopReason).toBe('complete');
      const callsAfterRun1 = modelCalls;
      expect(callsAfterRun1).toBe(1);

      // The SAME workspace for its OWN session: resumes bound to the same dir.
      const run2 = await freshDriver().run(
        invocation({ workspace: { path: workspaceDir }, sessionRef: run1.sessionId as string }),
      );
      expect(run2.stopReason).toBe('complete');
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(modelCalls).toBe(callsAfterRun1 + 1);

      // A DIFFERENT workspace for the same session: a caller bug — a
      // pre-dispatch config throw; the model was never contacted.
      const err = await thrownBy(
        freshDriver().run(
          invocation({ workspace: { path: otherDir }, sessionRef: run1.sessionId as string }),
        ),
      );
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect(modelCalls).toBe(callsAfterRun1 + 1); // unchanged — never dispatched
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace.path that is relative or not an existing directory → DispatchError config, never dispatched', async () => {
    const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'aidrv-s2-')));
    try {
      const aFile = join(scratchDir, 'plain-file.txt');
      await writeFile(aFile, 'not a directory', 'utf8');
      let modelCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                modelCalls += 1;
                return textResult('ok');
              },
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      for (const badPath of ['relative/workspace', join(scratchDir, 'absent'), aFile]) {
        const err = await thrownBy(driver.run(invocation({ workspace: { path: badPath } })));
        expect(errorClassOf(err), `workspace.path '${badPath}'`).toBe('config');
      }
      expect(modelCalls).toBe(0); // none of them ever dispatched
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
