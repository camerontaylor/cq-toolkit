import { describe, expect, it } from 'vitest';
import { trustedOptIn } from '../../src/config/optin.js';
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
      optIn: trustedOptIn({ sandbox: 'required', 'sandbox.network': 'model-only', run: 'off' }),
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

describe('resolveSandboxConfig with an invalid snapshot', () => {
  it('an error for a sandbox key is refused, not defaulted', async () => {
    const { readCqEnv } = await import('../../src/config/env.js');
    expect(() => resolveSandboxConfig({ cqEnv: readCqEnv({ CQ_SANDBOX: 'of' }) })).toThrow(
      /CQ_SANDBOX/,
    );
  });

  it('a snapshot error is refused even when only the run snapshot is in scope', async () => {
    const { readCqEnv } = await import('../../src/config/env.js');
    const { runWithCqEnv } = await import('../../src/config/run-env.js');
    expect(() =>
      runWithCqEnv(readCqEnv({ CQ_SANDBOX: 'of' }), () => resolveSandboxConfig()),
    ).toThrow(/CQ_SANDBOX/);
  });
});

describe('resolveSandboxConfig reads the run snapshot, not the ambient environment', () => {
  it('an ambient CQ_SANDBOX change after entry is invisible inside the run context', async () => {
    const { readCqEnv } = await import('../../src/config/env.js');
    const { runWithCqEnv } = await import('../../src/config/run-env.js');
    const snapshot = readCqEnv({ CQ_SANDBOX: 'off', CQ_RUN_TOOL: 'on' });
    const previous = process.env['CQ_SANDBOX'];
    try {
      runWithCqEnv(snapshot, () => {
        // Ambiently flip the knob AFTER the snapshot was taken.
        process.env['CQ_SANDBOX'] = 'required';
        expect(resolveSandboxConfig({ platform: 'linux' })).toMatchObject({
          mode: 'off',
          runTool: 'on',
        });
        expect(resolveSandboxConfig({ env: {}, platform: 'linux' })).toMatchObject({
          mode: 'required',
          runTool: 'withheld',
        });
      });
    } finally {
      if (previous === undefined) delete process.env['CQ_SANDBOX'];
      else process.env['CQ_SANDBOX'] = previous;
    }
  });

  it('an explicit raw env injection overrides the snapshot (foreign environment)', async () => {
    const { readCqEnv } = await import('../../src/config/env.js');
    const { runWithCqEnv } = await import('../../src/config/run-env.js');
    const snapshot = readCqEnv({ CQ_SANDBOX: 'off' });
    runWithCqEnv(snapshot, () => {
      expect(
        resolveSandboxConfig({ env: { CQ_SANDBOX: 'required' }, platform: 'linux' }),
      ).toMatchObject({ mode: 'required' });
      // The injected env REPLACES the env layer entirely: no CQ_SANDBOX there
      // means blank → required, the snapshot's 'off' is not merged in.
      expect(resolveSandboxConfig({ env: { PATH: '/bin' }, platform: 'linux' })).toMatchObject({
        mode: 'required',
      });
    });
  });

  it('harnessRunGate holds the entry snapshot against an ambient CQ_RUN_TOOL flip', async () => {
    const { harnessRunGate } = await import('../../src/sandbox/index.js');
    const { readCqEnv } = await import('../../src/config/env.js');
    const { runWithCqEnv } = await import('../../src/config/run-env.js');
    const snapshot = readCqEnv({ CQ_SANDBOX: 'off' });
    const previous = process.env['CQ_RUN_TOOL'];
    try {
      runWithCqEnv(snapshot, () => {
        process.env['CQ_RUN_TOOL'] = 'off';
        expect(harnessRunGate()).toMatchObject({ enabled: true });
        process.env['CQ_RUN_TOOL'] = 'on';
        // Still the snapshot: the ambient widen does not apply either.
        expect(harnessRunGate()).toMatchObject({ enabled: true, envPassthrough: [] });
      });
      // Outside the run context an explicit raw env is the full env layer:
      // CQ_RUN_TOOL=off there disables the gate (no snapshot merge).
      process.env['CQ_RUN_TOOL'] = 'off';
      expect(harnessRunGate({ env: { CQ_SANDBOX: 'off', CQ_RUN_TOOL: 'off' } })).toMatchObject({
        enabled: false,
      });
    } finally {
      if (previous === undefined) delete process.env['CQ_RUN_TOOL'];
      else process.env['CQ_RUN_TOOL'] = previous;
    }
  });
});
