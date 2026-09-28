// The driver factory (ADR-0002 §2.5) — resolution + wrapping behavior.
//
// Pins: the conservative default bindings (every role → ai-sdk on the four
// default providers, never a host-CLI lane), configured bindings + the '*'
// wildcard winning over defaults, the DispatchError('config') on an
// unbound provider (never a silent fallback), the deprecated 'ai-sdk'
// provider alias (stderr notice + normalised resolved.modelSpec), the
// served-model assertion applied to EVERY resolved driver, reap-on-settle
// retention (fresh record reaped whatever the verdict; a sessionRef-resumed
// record never), and the plan-data knobs (lanes config, factory sessionsDir,
// request.harness, config.pricing) reaching the constructed lane.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import type { DriverFactoryConfig } from '../../src/driver/factory.js';
import type { OpInvocation } from '../../src/driver/types.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { SessionStore } from '../../src/harness/session.js';

const FAKE_CLI = fileURLToPath(new URL('../fixtures/fake-agent-cli.mjs', import.meta.url));

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'drv-factory-'));
  temporary.push(root);
  return root;
}

const invocation = (model = 'construction-model', provider = 'construction'): OpInvocation => ({
  prompt: 'factory test',
  modelSpec: { provider, model },
  toolPolicy: { allow: [], mode: 'none' },
  sandboxPolicy: { level: 'none' },
  budget: {},
});

/** Subprocess-lane factory config driving the offline fake CLI through `env`. */
const subprocessConfig = (dir: string, cliEnv: string[]): DriverFactoryConfig => ({
  bindings: { fixer: { construction: 'subprocess' } },
  sessionsDir: join(dir, 'sessions'),
  lanes: {
    subprocess: {
      binary: ['env', ...cliEnv, process.execPath, FAKE_CLI],
      routingTable: {
        endpoints: {
          construction: {
            baseUrlEnv: 'CQ_FACTORY_URL',
            baseUrlDefault: 'https://unused.invalid',
            keyEnv: 'CQ_FACTORY_KEY',
            models: ['construction-model'],
            notes: 'Offline fake CLI; no network calls',
          },
        },
      },
    },
  },
});

const stubKey = (): void => {
  vi.stubEnv('CQ_FACTORY_KEY', 'offline-fixture-key');
};

/**
 * CLASS PROBE: the served-model wrapper is outermost, so the constructed
 * lane class is not observable through instanceof. Every lane names itself
 * in a cheap PRE-DISPATCH throw — dispatching an unbound provider — which
 * proves which class actually runs without env, network, or a spawn.
 */
const probe = async (
  driver: { run(i: OpInvocation): Promise<unknown> },
  pattern: RegExp,
): Promise<void> => {
  await expect(
    driver.run({
      prompt: 'class probe',
      modelSpec: { provider: 'probe-no-such-provider', model: 'm' },
      toolPolicy: { allow: [], mode: 'none' },
      sandboxPolicy: { level: 'none' },
      budget: {},
    }),
  ).rejects.toThrow(pattern);
};

describe('driver factory — resolution', () => {
  test.each(['zai', 'anthropic', 'openai', 'deepseek'])(
    'default bindings: %s resolves ANY role to the ai-sdk lane',
    async (provider) => {
      const factory = createDriverFactory();
      for (const role of [
        'fixer',
        'conflict-resolver',
        'remediator',
        'classifier',
        'deploy-role',
      ]) {
        const resolved = factory.resolve({ role, modelSpec: { provider, model: 'm' } });
        expect(resolved.lane).toBe('ai-sdk');
        expect(resolved.modelSpec).toEqual({ provider, model: 'm' });
      }
      // The resolved driver IS the ai-sdk lane (class-named pre-dispatch throw).
      await probe(
        factory.resolve({ role: 'fixer', modelSpec: { provider, model: 'm' } }).driver,
        /ai-sdk driver: unknown provider/,
      );
    },
  );

  test('a configured binding wins over the default; unconfigured roles keep it', async () => {
    const factory = createDriverFactory({ bindings: { fixer: { zai: 'subprocess' } } });
    const resolved = factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'zai', model: 'glm-4.6' },
    });
    expect(resolved.lane).toBe('subprocess');
    await probe(resolved.driver, /routing: unknown provider/); // the SUBPROCESS router ran
    expect(
      factory.resolve({ role: 'classifier', modelSpec: { provider: 'zai', model: 'glm-4.6' } })
        .lane,
    ).toBe('ai-sdk');
  });

  test("the '*' wildcard binds every provider for its role", async () => {
    const factory = createDriverFactory({ bindings: { classifier: { '*': 'claude-agent' } } });
    for (const provider of ['zai', 'openai', 'anything-at-all']) {
      const resolved = factory.resolve({
        role: 'classifier',
        modelSpec: { provider, model: 'm' },
      });
      expect(resolved.lane).toBe('claude-agent');
    }
    await probe(
      factory.resolve({ role: 'classifier', modelSpec: { provider: 'zai', model: 'm' } }).driver,
      /claude-agent driver: unknown provider/,
    );
  });

  test('subprocess is never a default: an unbound non-default provider is a config throw', () => {
    const factory = createDriverFactory({ bindings: { fixer: { zai: 'subprocess' } } });
    const thrownBy = (): unknown => {
      try {
        factory.resolve({ role: 'classifier', modelSpec: { provider: 'nope', model: 'm' } });
        return undefined;
      } catch (err) {
        return err;
      }
    };
    const err = thrownBy();
    expect(err).toBeInstanceOf(DispatchError);
    expect(errorClassOf(err)).toBe('config');
    expect((err as Error).message).toMatch(
      /no lane binding for role 'classifier' on provider 'nope'/,
    );
  });

  test("the deprecated provider 'ai-sdk' alias normalises to provider 'zai' with a cq: stderr notice", async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const resolved = createDriverFactory().resolve({
      role: 'fixer',
      modelSpec: { provider: 'ai-sdk', model: 'glm-4.6' },
    });
    expect(resolved.lane).toBe('ai-sdk');
    // The NORMALISED spec is what ops put on the invocation — the alias
    // never reaches a lane or journal.
    expect(resolved.modelSpec).toEqual({ provider: 'zai', model: 'glm-4.6' });
    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain('cq:');
    expect(String(write.mock.calls[0]?.[0])).toContain('deprecated');
    await probe(resolved.driver, /ai-sdk driver: unknown provider/); // the AI-SDK lane ran
  });

  test('the acp and claude-agent lanes exist only through explicit bindings', async () => {
    const factory = createDriverFactory({
      bindings: { remediator: { vendor: 'acp' }, fixer: { vendor: 'claude-agent' } },
      lanes: {
        acp: {
          // A deliberately unresolvable binary: the lane's own pre-dispatch
          // throw names the class without spawning anything.
          endpoint: 'vendor-acp',
          endpointTable: {
            endpoints: {
              'vendor-acp': {
                command: ['/nonexistent/cq-factory-vendor-acp'],
                installHint: 'offline test fixture',
                notes: 'Offline factory-test fixture; never resolved',
              },
            },
          },
        },
      },
    });
    const acp = factory.resolve({
      role: 'remediator',
      modelSpec: { provider: 'vendor', model: 'm' },
    });
    expect(acp.lane).toBe('acp');
    await probe(acp.driver, /acp driver: the harness binary '.*vendor-acp' was not found/);
    const agent = factory.resolve({ role: 'fixer', modelSpec: { provider: 'vendor', model: 'm' } });
    expect(agent.lane).toBe('claude-agent');
    await probe(agent.driver, /claude-agent driver: unknown provider/);
  });
});

describe('driver factory — wrapping', () => {
  test('every resolved driver carries the served-model assertion (mismatch → served-model-mismatch)', async () => {
    stubKey();
    const dir = await scratch();
    // TREATMENT: the fake CLI serves a remapped id.
    const factory = createDriverFactory(
      subprocessConfig(dir, ['FAKE_AGENT_SERVED_MODEL=remapped']),
    );
    const resolved = factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'construction', model: 'construction-model' },
    });
    const verdict = await resolved.driver.run(invocation());
    expect(verdict.stopReason).toBe('error');
    expect(verdict.errorClass).toBe('served-model-mismatch');
    expect(verdict.error).toContain("requested 'construction-model', served 'remapped'");

    // CONTROL: an honest CLI completes on the same factory.
    const honest = createDriverFactory(subprocessConfig(await scratch(), []));
    const ok = await honest
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
      })
      .driver.run(invocation());
    expect(ok.stopReason).toBe('complete');
    expect(ok.model).toBe('construction-model');
  });

  test('reap-on-settle deletes the FRESH record after a completed run', async () => {
    stubKey();
    const dir = await scratch();
    const factory = createDriverFactory(subprocessConfig(dir, []));
    const resolved = factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'construction', model: 'construction-model' },
      sessionRetention: 'reap-on-settle',
    });
    const verdict = await resolved.driver.run(invocation());
    expect(verdict.stopReason).toBe('complete');
    expect(verdict.sessionId).toBeDefined();
    const store = new SessionStore(join(dir, 'sessions'));
    await expect(store.load(verdict.sessionId as string)).resolves.toBeUndefined();
  });

  test('reap-on-settle deletes the fresh record on an ERROR verdict too', async () => {
    stubKey();
    const dir = await scratch();
    const factory = createDriverFactory(subprocessConfig(dir, ['FAKE_AGENT_MODE=error-result']));
    const resolved = factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'construction', model: 'construction-model' },
      sessionRetention: 'reap-on-settle',
    });
    const verdict = await resolved.driver.run(invocation());
    expect(verdict.stopReason).toBe('error');
    expect(verdict.sessionId).toBeDefined();
    const store = new SessionStore(join(dir, 'sessions'));
    await expect(store.load(verdict.sessionId as string)).resolves.toBeUndefined();
  });

  test('a sessionRef-resumed record is NEVER reaped', async () => {
    stubKey();
    const dir = await scratch();
    const sessionsDir = join(dir, 'sessions');
    const store = new SessionStore(sessionsDir);
    const workspace = await mkdtemp(join(dir, 'ws-'));
    temporary.push(workspace);
    const resumed = await store.create(workspace);
    const factory = createDriverFactory(subprocessConfig(dir, []));
    const verdict = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
        sessionRetention: 'reap-on-settle',
      })
      .driver.run({ ...invocation(), sessionRef: resumed.sessionId });
    expect(verdict.stopReason).toBe('complete');
    expect(verdict.sessionId).toBe(resumed.sessionId); // the resumed record, not a fresh one
    await expect(store.load(resumed.sessionId)).resolves.toBeDefined();
  });

  test("the default retention is 'keep': the fresh record survives", async () => {
    stubKey();
    const dir = await scratch();
    const factory = createDriverFactory(subprocessConfig(dir, []));
    const verdict = await factory
      .resolve({
        role: 'fixer',
        modelSpec: { provider: 'construction', model: 'construction-model' },
      })
      .driver.run(invocation());
    expect(verdict.stopReason).toBe('complete');
    const store = new SessionStore(join(dir, 'sessions'));
    const record = await store.load(verdict.sessionId as string);
    expect(record).toBeDefined();
  });
});

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
    expect(record?.workspace.startsWith(realpathSync(workspaceRoot))).toBe(true);
  });

  test('the lane-specific sessionsDir overrides the factory-level one', async () => {
    stubKey();
    const dir = await scratch();
    const config = subprocessConfig(dir, []);
    const laneDir = join(dir, 'lane-sessions');
    const factory = createDriverFactory({
      ...config,
      lanes: { ...config.lanes, subprocess: { ...config.lanes?.subprocess, sessionsDir: laneDir } },
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

describe('driver factory — resolved shape', () => {
  test('resolve() is synchronous and returns the lane plus a runnable driver', () => {
    const factory = createDriverFactory();
    const resolved = factory.resolve({ role: 'fixer', modelSpec: { provider: 'zai', model: 'm' } });
    expect(resolved).not.toBeInstanceOf(Promise); // resolve is sync — construction throws, never rejects
    expect(resolved.lane).toBe('ai-sdk');
    expect(resolved.driver.run).toBeTypeOf('function');
  });
});
