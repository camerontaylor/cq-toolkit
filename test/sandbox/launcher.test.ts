// The run launcher boundary (W1.11 review findings 1–3):
//   1. the CQ_SANDBOX gate is the SHARED buildTools seam, so every harness
//      surface (ai-sdk, subprocess stock/MCP, the manifest surface) withholds
//      `run` identically when the environment expresses a required policy;
//   2. an ALLOWED command's child env is the default-deny scrub — a secret in
//      the entry process never reaches it, an explicit passthrough does, and a
//      CQ_* policy knob never does;
//   3. CQ_SANDBOX_NETWORK is ADVISORY: resolved and reported, never claimed as
//      an enforced transport boundary.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import {
  buildSandboxLauncherEnv,
  harnessRunGate,
  resolveSandboxConfig,
} from '../../src/sandbox/index.js';

/** Run config whose allowlist is exactly `patterns` (anchored re: for `env`). */
function runConfig(commandPatterns: string[]) {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      run: { enabled: true, commandPatterns, timeoutMs: 5_000, maxOutputChars: 10_000 },
    },
  };
}

/** The env names the policy knobs live under, saved/restored around each test. */
const POLICY_NAMES = [
  'CQ_SANDBOX',
  'CQ_SANDBOX_BACKEND',
  'CQ_SANDBOX_NETWORK',
  'CQ_RUN_TOOL',
  'CQ_RUN_ENV_PASSTHROUGH',
] as const;

const saved = POLICY_NAMES.map((name) => [name, process.env[name]] as const);
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the shared run gate withholds `run` on every harness surface', () => {
  test('a required CQ_SANDBOX policy with no certified launcher omits the tool', () => {
    process.env['CQ_SANDBOX'] = 'required';
    delete process.env['CQ_SANDBOX_BACKEND'];
    delete process.env['CQ_RUN_TOOL'];
    const gate = harnessRunGate();
    expect(gate.enabled).toBe(false);
    expect(gate.configHint).toMatch(/fail-closed/);
    const names = buildTools(runConfig(['env']), process.cwd(), 'workspace-write', gate).map(
      (tool) => tool.name,
    );
    expect(names).not.toContain('run');
    // The manifest surface selects through the same gate, so it never names
    // a tool the surface cannot serve.
    expect(buildTools(runConfig(['env']), process.cwd()).map((tool) => tool.name)).not.toContain(
      'run',
    );
  });

  test('an explicitly blank CQ_SANDBOX is still a required policy', () => {
    process.env['CQ_SANDBOX'] = '';
    expect(harnessRunGate().enabled).toBe(false);
    expect(harnessRunGate().configHint).toMatch(/certified backend launcher/);
  });

  test('CQ_RUN_TOOL=off withholds it even with the sandbox off', () => {
    process.env['CQ_SANDBOX'] = 'off';
    process.env['CQ_RUN_TOOL'] = 'off';
    expect(harnessRunGate().enabled).toBe(false);
  });

  test('CQ_SANDBOX=off keeps the tool, and an unexpressed environment is unchanged', () => {
    process.env['CQ_SANDBOX'] = 'off';
    delete process.env['CQ_RUN_TOOL'];
    expect(buildTools(runConfig(['env']), process.cwd()).map((t) => t.name)).toContain('run');
    for (const name of POLICY_NAMES) delete process.env[name];
    expect(harnessRunGate()).toEqual({ enabled: true, envPassthrough: [] });
    expect(buildTools(runConfig(['env']), process.cwd()).map((t) => t.name)).toContain('run');
  });

  test('the gate agrees with resolveSandboxConfig for a driver-supplied policy', () => {
    const config = resolveSandboxConfig({ env: { CQ_SANDBOX: 'required' }, platform: 'linux' });
    expect(harnessRunGate({ sandboxConfig: config }).enabled).toBe(false);
    const off = resolveSandboxConfig({ env: { CQ_SANDBOX: 'off' }, platform: 'linux' });
    expect(harnessRunGate({ sandboxConfig: off }).enabled).toBe(true);
  });
});

describe('the launcher env scrub reaches the actual run child', () => {
  test('an allowed command sees no secret, sees the passthrough, never a CQ_ knob', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-sandbox-env-'));
    const names = {
      secret: 'CQ_TEST_SECRET',
      keep: 'CQ_TEST_KEEP',
      knob: 'CQ_SANDBOX',
    } as const;
    const prior = Object.fromEntries(Object.values(names).map((name) => [name, process.env[name]]));
    try {
      process.env[names.secret] = 'super-secret-value';
      process.env[names.keep] = 'kept-value';
      process.env[names.knob] = 'required';
      const run = buildTools(runConfig(['re:^env$']), scratch, 'workspace-write', {
        enabled: true,
        envPassthrough: [names.keep],
      }).find((tool) => tool.name === 'run');
      const result = await run?.execute({ command: 'env' });
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.output).toContain('PATH=');
        expect(result.output).toContain(`${names.keep}=kept-value`);
        expect(result.output).not.toContain('super-secret-value');
        expect(result.output).not.toContain(names.secret);
        expect(result.output).not.toContain(`${names.knob}=`);
      }
    } finally {
      for (const [n, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('the launcher keeps Windows executable essentials while scrubbing secrets', () => {
    const env = buildSandboxLauncherEnv(
      {
        Path: 'C:\\Windows',
        SystemRoot: 'C:\\Windows',
        COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: '.COM;.EXE',
        GH_TOKEN: 'secret',
      },
      { envPassthrough: [] },
    );
    expect(env).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE',
    });
  });

  test('a policy knob is refused on the passthrough and on a declared manifest name', () => {
    const parent = { PATH: '/bin', CQ_SANDBOX: 'required', CQ_TEST_KEEP: 'kept' };
    expect(() => buildSandboxLauncherEnv(parent, { envPassthrough: ['CQ_RUN_TOOL'] })).toThrow(
      /not permitted/,
    );
    expect(() =>
      buildSandboxLauncherEnv(parent, { envPassthrough: [], declaredEnvNames: ['CQ_SANDBOX'] }),
    ).toThrow(/not permitted/);
    // A declared non-knob name rides the same seam (the manifest envNames
    // contract the MCP surface already relies on).
    expect(
      buildSandboxLauncherEnv(parent, { envPassthrough: [], declaredEnvNames: ['CQ_TEST_KEEP'] }),
    ).toEqual({ PATH: '/bin', CQ_TEST_KEEP: 'kept' });
  });

  test('an invalid policy passthrough fails before run is exposed', () => {
    expect(() =>
      buildTools(runConfig(['env']), process.cwd(), 'workspace-write', {
        enabled: true,
        envPassthrough: ['CQ_SANDBOX'],
      }),
    ).toThrow(/not permitted/);
    expect(() =>
      resolveSandboxConfig({
        env: { CQ_SANDBOX: 'off', CQ_RUN_ENV_PASSTHROUGH: 'CQ_SANDBOX' },
        platform: 'linux',
      }),
    ).toThrow(/may not expose policy env/);
  });
});

describe('CQ_SANDBOX_NETWORK is advisory, not an enforced boundary', () => {
  test('the resolved value is reported, and the gate does not depend on it', () => {
    const modelOnly = resolveSandboxConfig({
      env: { CQ_SANDBOX: 'off', CQ_SANDBOX_NETWORK: 'model-only' },
      platform: 'linux',
    });
    const allow = resolveSandboxConfig({
      env: { CQ_SANDBOX: 'off', CQ_SANDBOX_NETWORK: 'allow' },
      platform: 'linux',
    });
    expect(modelOnly.network).toBe('model-only');
    expect(allow.network).toBe('allow');
    // Same gate either way: no transport boundary exists, so the value is
    // recorded intent for a future certified launcher, never a claim.
    expect(harnessRunGate({ sandboxConfig: modelOnly }).enabled).toBe(
      harnessRunGate({ sandboxConfig: allow }).enabled,
    );
    expect(() =>
      resolveSandboxConfig({ env: { CQ_SANDBOX_NETWORK: 'closed' }, platform: 'linux' }),
    ).toThrow(/CQ_SANDBOX_NETWORK/);
  });
});
