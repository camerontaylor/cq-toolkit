// The rg capability seam (the former ai-sdk.test.ts rg describes): the
// injected resolveRg resolver, the policy regressions on the probe decision,
// and the probe evidence carried on every post-probe verdict.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { conformanceHarnessConfig, invocation, modelFor, textResult } from './ai-sdk.helpers.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { WorkerResultSchema } from '../../src/kernel/schema.js';
import type { OpInvocation, WorkerResult } from '../../src/driver/types.js';
import type { AiSdkDriverOptions } from '../../src/driver/ai-sdk/index.js';

// ---------------------------------------------------------------------------
// N. rg capability seam (injected resolver, deterministic)
// ---------------------------------------------------------------------------

describe('rg capability seam (injected resolveRg)', () => {
  test('rg ok: grep/glob stay on the surface; result records probe ok with no advisory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-ok-'));
    // The session binding file lives OUTSIDE the model-editable workspace
    // (Annex A, issue #1197): sessions stay at the scratch root, the bound
    // workspace is the child. Cleanup (rm root) is unchanged.
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    try {
      let probes = 0;
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => {
          probes++;
          return { ok: true, version: '14.1.1' };
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.capabilities?.rg).toEqual({
        available: true,
        version: '14.1.1',
        minimum: '11.0.0',
        probe: 'ok',
      });
      expect(result.advisories).toBeUndefined();
      expect(probes).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rg absent: grep/glob WITHHELD, capability records absent, advisory carries the not-found line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-absent-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => ({ ok: false, reason: 'absent' }),
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.capabilities?.rg).toEqual({
        available: false,
        minimum: '11.0.0',
        probe: 'absent',
      });
      expect(result.advisories).toEqual(['search tools unavailable: ripgrep not found']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rg old: capability carries found; advisory names the minimum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-old-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => ({ ok: false, reason: 'old', found: '10.5.0' }),
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.capabilities?.rg).toEqual({
        available: false,
        found: '10.5.0',
        minimum: '11.0.0',
        probe: 'old',
      });
      expect(result.advisories).toEqual([
        'search tools unavailable: ripgrep older than minimum 11.0.0',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a policy that does not request grep never probes and records nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-silent-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    try {
      let probes = 0;
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => {
          probes++;
          return { ok: false, reason: 'absent' };
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.capabilities).toBeUndefined();
      expect(result.advisories).toBeUndefined();
      expect(probes).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the mirror accepts a result carrying the seam fields and one without (conformance absent-field rule)', async () => {
    const base = {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete' as const,
    };
    expect(WorkerResultSchema.parse(base)).toBeDefined();
    expect(
      WorkerResultSchema.parse({
        ...base,
        capabilities: {
          rg: { available: false, found: '13.0.0', minimum: '15.2.0', probe: 'old' },
        },
        advisories: ['search tools unavailable: ripgrep not found'],
      }).capabilities?.rg?.probe,
    ).toBe('old');
  });
});

describe('rg policy seam regressions (probe decision from candidates)', () => {
  const runCase = async (
    toolPolicy: OpInvocation['toolPolicy'],
    sandbox: 'none' | 'workspace-write' | 'read-only',
  ): Promise<{ result: WorkerResult; probes: number }> => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-seam-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    try {
      let probes = 0;
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => {
          probes++;
          return { ok: false, reason: 'absent' };
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy,
          sandboxPolicy: { level: sandbox },
        }),
      );
      return { result, probes };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test('glob-only allowlist still probes and withholds BOTH search tools', async () => {
    const { result, probes } = await runCase(
      { allow: ['read', 'glob'], mode: 'allowlist' },
      'read-only',
    );
    expect(probes).toBe(1);
    expect(result.capabilities?.rg?.available).toBe(false);
    expect(result.advisories).toEqual(['search tools unavailable: ripgrep not found']);
  });

  test('unrestricted policy probes (candidates include search on read-only)', async () => {
    const { result, probes } = await runCase({ allow: [], mode: 'unrestricted' }, 'read-only');
    expect(probes).toBe(1);
    expect(result.capabilities?.rg?.available).toBe(false);
  });

  test('workspace-write sandbox withholds search from candidates: NO probe, silent', async () => {
    const { result, probes } = await runCase(
      { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
      'workspace-write',
    );
    expect(probes).toBe(0);
    expect(result.capabilities).toBeUndefined();
    expect(result.advisories).toBeUndefined();
  });

  test('read/search-only policy (no search tool) never probes: silent', async () => {
    const { result, probes } = await runCase({ allow: ['read'], mode: 'allowlist' }, 'read-only');
    expect(probes).toBe(0);
    expect(result.capabilities).toBeUndefined();
    expect(result.advisories).toBeUndefined();
  });
});

describe('rg probe evidence on EVERY post-probe verdict', () => {
  const runAbsentoK = async (
    model: MockLanguageModelV4,
    resolveRg: NonNullable<AiSdkDriverOptions['resolveRg']>,
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-verdict-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg,
      });
      return await driver.run(
        invocation({
          workspace: { path: workspace },
          toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
          outputSchema: {
            name: 'test.verdict/v1',
            schema: {
              type: 'object',
              properties: { reply: { type: 'string' } },
              required: ['reply'],
              additionalProperties: false,
            },
          },
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test('REPAIR SUCCESS: the miss-flow verdict still carries the probe evidence', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls++;
        // First (main) call returns unparseable text; the repair returns valid JSON.
        return calls === 1
          ? textResult('this is not the requested object')
          : textResult('{"reply":"repaired"}');
      },
    });
    const result = await runAbsentoK(model, async () => ({ ok: false, reason: 'absent' }));
    expect(result.stopReason).toBe('complete');
    expect(result.capabilities?.rg).toMatchObject({ available: false, probe: 'absent' });
    expect(result.advisories).toEqual(['search tools unavailable: ripgrep not found']);
  });

  test('REPAIR FAILURE: the error verdict still carries the probe evidence', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => textResult('still not the object'),
    });
    const result = await runAbsentoK(model, async () => ({ ok: false, reason: 'absent' }));
    expect(result.stopReason).toBe('error');
    expect(result.errorClass).toBe('output-invalid');
    expect(result.capabilities?.rg).toMatchObject({ available: false, probe: 'absent' });
    expect(result.advisories).toEqual(['search tools unavailable: ripgrep not found']);
  });
});
