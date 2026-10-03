import { describe, expect, it } from 'vitest';
import {
  assertRunToolAvailable,
  buildSandboxLauncherEnv,
  certifiedAutoOrder,
  resolveSandboxConfig,
} from '../../src/sandbox/index.js';

describe('CQ sandbox policy', () => {
  it('defaults blank CQ_SANDBOX to required and withholds run without certification', () => {
    const config = resolveSandboxConfig({ env: {}, platform: 'linux' });
    expect(config.mode).toBe('required');
    expect(config.runTool).toBe('withheld');
    expect(config.configHint).toMatch(/CQ_SANDBOX=off/);
    expect(() => assertRunToolAvailable(config)).toThrow(/certified backend launcher/);
  });

  it('resolves explicit per-call opt-ins over project env', () => {
    const config = resolveSandboxConfig({
      env: { CQ_SANDBOX: 'off', CQ_SANDBOX_NETWORK: 'allow', CQ_RUN_TOOL: 'on' },
      optIn: { sandbox: 'required', 'sandbox.network': 'model-only', run: 'off' },
      platform: 'darwin',
      certifiedBackends: ['seatbelt'],
    });
    expect(config).toMatchObject({ mode: 'required', network: 'model-only', runTool: 'off' });
  });

  it('uses the accepted auto order and refuses uncertified explicit backends', () => {
    expect(certifiedAutoOrder('linux')).toEqual(['landlock', 'bwrap', 'container']);
    expect(certifiedAutoOrder('darwin')).toEqual(['seatbelt', 'container']);
    expect(() =>
      resolveSandboxConfig({
        env: { CQ_SANDBOX_BACKEND: 'bwrap' },
        platform: 'linux',
        certifiedBackends: ['landlock'],
      }),
    ).toThrow(/not certified/);
    expect(() =>
      resolveSandboxConfig({
        env: { CQ_SANDBOX_BACKEND: 'not-certified' },
        platform: 'linux',
      }),
    ).toThrow(/uncertified backend/);
  });

  it('never ships cc-native and scrubs the launcher environment', () => {
    expect(() =>
      resolveSandboxConfig({
        env: { CQ_SANDBOX_BACKEND: 'cc-native' },
        platform: 'linux',
        certifiedBackends: ['cc-native'],
      }),
    ).toThrow(/driver-scoped only/);
    const env = buildSandboxLauncherEnv(
      { PATH: '/bin', GH_TOKEN: 'secret', CQ_SANDBOX: 'off', NPM_CONFIG_REGISTRY: 'npm' },
      { envPassthrough: ['NPM_CONFIG_REGISTRY'] },
    );
    expect(env).toEqual({ PATH: '/bin', NPM_CONFIG_REGISTRY: 'npm' });
  });

  it('honors CQ_RUN_TOOL=off even with sandbox off', () => {
    const config = resolveSandboxConfig({ env: { CQ_SANDBOX: 'off', CQ_RUN_TOOL: 'off' } });
    expect(config.runTool).toBe('off');
    expect(() => assertRunToolAvailable(config)).toThrow(/run tool is disabled/);
  });

  it('enables run for a certified backend and rejects a backend on the wrong platform', () => {
    expect(
      resolveSandboxConfig({
        env: { CQ_SANDBOX: 'required', CQ_SANDBOX_BACKEND: 'landlock', CQ_RUN_TOOL: 'on' },
        platform: 'linux',
        certifiedBackends: ['landlock'],
      }),
    ).toMatchObject({ runTool: 'withheld', selectedBackend: 'landlock' });
    expect(
      resolveSandboxConfig({
        env: { CQ_SANDBOX: 'required', CQ_SANDBOX_BACKEND: 'landlock' },
        platform: 'linux',
        certifiedBackends: ['landlock'],
      }).configHint,
    ).toMatch(/fail-closed until a certified backend launcher/);
    expect(() =>
      resolveSandboxConfig({
        env: { CQ_SANDBOX_BACKEND: 'landlock' },
        platform: 'darwin',
        certifiedBackends: ['landlock'],
      }),
    ).toThrow(/not available on darwin/);
  });
});
