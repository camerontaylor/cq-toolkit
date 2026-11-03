// Split provenance: test/driver/factory.test.ts was split by subject; this
// file keeps the plan-data knob subject — lane config, factory/lane/log
// sessionsDir, request.harness, config.pricing and stepTimeoutMs reaching
// the constructed lane. The suite-wide header and shared fixtures live in
// ./factory.helpers.ts.
import { mkdir, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { createDriverFactory } from '../../src/driver/factory.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { SessionStore } from '../../src/harness/session.js';
import { invocation, scratch, stubKey, subprocessConfig } from './factory.helpers.js';

describe('driver factory — knobs reach the constructed lane', () => {
  test('lane binary + routingTable knobs drive the run (the transcript proves the configured binary)', async () => {
    stubKey();
    const dir = await scratch();
    const factory = createDriverFactory(subprocessConfig(dir, ['FAKE_AGENT_REPLY=knob-ok']));
    const verdict = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
      })
      .driver.run(invocation());
    expect(verdict.stopReason).toBe('complete');
    const record = await new SessionStore(join(dir, 'sessions')).load(verdict.sessionId as string);
    const reply = record?.messages.find((m) => m.role === 'assistant');
    expect(reply?.content).toBe('knob-ok');
  });

  test('request.harness reaches the lane (fresh workspaces under its workspaceRoot)', async () => {
    stubKey();
    const dir = await scratch();
    const workspaceRoot = join(dir, 'workspaces');
    await mkdir(workspaceRoot, { recursive: true });
    const factory = createDriverFactory(subprocessConfig(dir, []));
    const verdict = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
        harness: { ...defaultHarnessConfig, workspaceRoot },
      })
      .driver.run(invocation());
    expect(verdict.stopReason).toBe('complete');
    const record = await new SessionStore(join(dir, 'sessions')).load(verdict.sessionId as string);
    // The record's workspace carries tempWorkspace's mkdtemp prefix — the
    // CALLER's workspaceRoot spelling (/var/... on macOS, whose /var aliases
    // /private/var). Containment is a realpath fact, not a spelling fact:
    // normalize BOTH sides (the resumedRecordOrThrow discipline), never the
    // stored spelling alone. It is a path fact, not a string-prefix fact
    // either — a sibling root like `<root>-escape` shares the root's whole
    // prefix — so judge by path.relative: outside the root is a '..'-climbing
    // or absolute remainder.
    const rel = record && relative(realpathSync(workspaceRoot), realpathSync(record.workspace));
    expect(
      record !== undefined && rel !== undefined && !rel.startsWith('..') && !isAbsolute(rel),
    ).toBe(true);
  });

  test('the lane-specific sessionsDir overrides the factory-level one', async () => {
    stubKey();
    const dir = await scratch();
    const config = subprocessConfig(dir, []);
    const laneDir = join(dir, 'lane-sessions');
    const factory = createDriverFactory({
      ...config,
      lanes: { ...config.lanes, claudeCode: { ...config.lanes?.claudeCode, sessionsDir: laneDir } },
    });
    const verdict = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
      })
      .driver.run(invocation());
    expect(verdict.stopReason).toBe('complete');
    await expect(
      new SessionStore(laneDir).load(verdict.sessionId as string),
    ).resolves.toBeDefined();
  });

  test('sessionLogs.dir beats the factory-level sessionsDir for both the store and the reap (session-log 1.6)', async () => {
    stubKey();
    const dir = await scratch();
    const logsDir = join(dir, 'archive-sessions');
    const factory = createDriverFactory({
      ...subprocessConfig(dir, []),
      sessionLogs: { dir: logsDir },
    });
    const keep = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
      })
      .driver.run(invocation());
    expect(keep.stopReason).toBe('complete');
    await expect(new SessionStore(logsDir).load(keep.sessionId as string)).resolves.toBeDefined();
    // The reap wrapper resolves the SAME dir: a reaped record leaves no file there.
    const reaped = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
        sessionRetention: 'reap-on-settle',
      })
      .driver.run(invocation());
    expect(reaped.stopReason).toBe('complete');
    expect(reaped.sessionId).toBeUndefined();
    expect((await readdir(logsDir)).filter((name) => name.endsWith('.jsonl'))).toEqual([
      `${keep.sessionId}.jsonl`,
    ]);
  });

  test('config.pricing reaches the lane (cost derived off the observed served id)', async () => {
    stubKey();
    const dir = await scratch();
    const factory = createDriverFactory({
      ...subprocessConfig(dir, ['FAKE_AGENT_SERVED_MODEL=remapped']),
      pricing: (spec) =>
        spec.model === 'remapped'
          ? { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 }
          : undefined,
    });
    const verdict = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
      })
      .driver.run(invocation());
    // The assertion rewrites the verdict, but the spend facts stay — priced
    // off the SERVED id through the injected lookup.
    expect(verdict.stopReason).toBe('error');
    expect(verdict.errorClass).toBe('served-model-mismatch');
    expect(verdict.usage.input).toBeGreaterThan(0);
    expect(verdict.costUSD).toBeDefined();
    expect(verdict.costBasis).toBe('modeled');
  });
});

test('a request stepTimeoutMs reaches the ai-sdk lane as its per-request step bound', async () => {
  const root = await scratch();
  // A provider that answers only after 5 s, unless its request is aborted.
  const slow = new MockLanguageModelV4({
    modelId: 'slow',
    doGenerate: (options) =>
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the step bound never fired')), 5_000);
        options.abortSignal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(options.abortSignal?.reason);
          },
          { once: true },
        );
      }),
  });
  const factory = createDriverFactory({
    sessionsDir: join(root, 'sessions'),
    bindings: { reviewer: { slow: 'ai-sdk' } },
    lanes: { aiSdk: { providers: { slow: () => slow } } },
  });
  const resolved = factory.resolve({
    role: 'reviewer',
    modelSpec: { provider: 'slow', model: 'slow' },
    stepTimeoutMs: 50,
  });
  const verdict = await resolved.driver.run(invocation('slow', 'slow'));
  expect(verdict.stopReason).toBe('error');
  expect(verdict.errorClass).toBe('transient');
  expect(verdict.error).toContain('50ms');
});
