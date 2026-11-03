// Split provenance: test/driver/factory.test.ts was split by subject into
// factory.{resolution-defaults,resolution-bindings,alias,wrappers,retention,knobs,shape}.test.ts;
// this module holds the fixtures they share and declares no tests.
//
// The driver factory (ADR-0002 §2.5) — resolution + wrapping behavior.
//
// Pins: the conservative default bindings (every role → ai-sdk on the five
// default providers, never a host-CLI lane), configured bindings + the '*'
// wildcard winning over defaults, the DispatchError('config') on an
// unbound provider (never a silent fallback), the deprecated 'ai-sdk'
// provider alias (stderr notice + normalised resolved.modelSpec), the
// served-model assertion applied to EVERY resolved driver, reap-on-settle
// retention (fresh record reaped whatever the verdict; a sessionRef-resumed
// record never), and the plan-data knobs (lanes config, factory sessionsDir,
// request.harness, config.pricing) reaching the constructed lane.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, vi } from 'vitest';
import type { DriverFactoryConfig } from '../../src/driver/factory.js';
import type { OpInvocation } from '../../src/driver/types.js';

const FAKE_CLI = fileURLToPath(new URL('../fixtures/fake-agent-cli.mjs', import.meta.url));

export const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'drv-factory-'));
  temporary.push(root);
  return root;
}

export const invocation = (
  model = 'construction-model',
  provider = 'construction',
): OpInvocation => ({
  prompt: 'factory test',
  modelSpec: { provider, model },
  toolPolicy: { allow: [], mode: 'none' },
  sandboxPolicy: { level: 'none' },
  budget: {},
});

/** Claude-code-lane factory config driving the offline fake CLI through `env`. */
export const subprocessConfig = (dir: string, cliEnv: string[]): DriverFactoryConfig => ({
  bindings: { fixer: { construction: 'claude-code' } },
  sessionsDir: join(dir, 'sessions'),
  lanes: {
    claudeCode: {
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

export const stubKey = (): void => {
  vi.stubEnv('CQ_FACTORY_KEY', 'offline-fixture-key');
};

/**
 * CLASS PROBE: the served-model wrapper is outermost, so the constructed
 * lane class is not observable through instanceof. Every lane names itself
 * in a cheap PRE-DISPATCH throw — dispatching an unbound provider — which
 * proves which class actually runs without env, network, or a spawn.
 */
export const probe = async (
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
