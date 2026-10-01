import { describe, expect, it } from 'vitest';
import { CONFIG_REGISTRY } from '../../src/config/registry.js';
import { resolveConfig } from '../../src/config/resolve.js';

const root = '/workspace';
const state = '/tmp';
const sessions = '/tmp/cq-harness/sessions';
const baselineEnv = { XDG_STATE_HOME: '/tmp', TMPDIR: '/tmp' };
function resolve(input: Parameters<typeof resolveConfig>[0] = {}) {
  const env = { ...baselineEnv, ...input.env };
  const customProfiles = Object.fromEntries(
    Object.entries(env)
      .filter(
        ([name, value]) =>
          /^CQ_PROVIDER_[A-Z0-9_]+_PROFILE$/.test(name) && value?.startsWith('custom:/'),
      )
      .map(([name, value]) => [
        name,
        { input: value!.slice('custom:'.length), realpath: value!.slice('custom:'.length) },
      ]),
  );
  return resolveConfig({
    ...input,
    env,
    workspaceRootRealpath: root,
    verifiedRealpaths: {
      CQ_APPROVAL_LEDGER: {
        input: `${state}/cq/approvals.ndjson`,
        realpath: `${state}/cq/approvals.ndjson`,
      },
      CQ_DRIVER_SESSIONS_DIR: { input: sessions, realpath: sessions },
      ...customProfiles,
      ...(input.verifiedRealpaths ?? {}),
    },
  });
}

function entryValue(id: string, config: ReturnType<typeof resolveConfig>) {
  const entry = config.entries[id];
  if (!entry) throw new Error(`missing config entry ${id}`);
  return entry.value;
}

describe('pure configuration resolution', () => {
  it('uses built-ins for unset, empty, and whitespace values', () => {
    for (const value of [undefined, '', '  \t']) {
      const config = resolve({ env: { CQ_SANDBOX: value } });
      expect(entryValue('sandbox', config)).toBe('required');
    }
  });

  it('seeds project env from the bundled profile, then explicit env wins', () => {
    expect(entryValue('sandbox', resolve({ env: { CQ_PROFILE: 'solo-maintainer' } }))).toBe('off');
    const envOverride = resolve({
      env: { CQ_PROFILE: 'solo-maintainer', CQ_SANDBOX: 'required' },
    });
    expect(envOverride.entries.sandbox?.layer).toBe('env');
    expect(entryValue('sandbox', envOverride)).toBe('required');
  });

  it('rejects unknown CQ variables and invalid profile values', () => {
    expect(() => resolve({ env: { CQ_SANDBOX_NETWROK: 'allow' } })).toThrow(
      /did you mean CQ_SANDBOX_NETWORK/,
    );
    expect(() =>
      resolve({
        env: { CQ_SANDBOX_NETWROK: 'allow', CQ_MERGE_TRUSTED_BOTSX: 'x' },
      }),
    ).toThrow(/\n/);
    expect(() => resolve({ env: { CQ_PROFILE: 'custom' } })).toThrow(/unsupported profile/);
  });

  it('materializes provenance for every static and bundled-provider key', () => {
    const config = resolve();
    expect(Object.keys(config.entries)).toHaveLength(CONFIG_REGISTRY.length);
    for (const key of CONFIG_REGISTRY) expect(config.entries[key.id]).toBeDefined();
  });

  it('allows tightening without opt-in and requires a named key for relaxation', () => {
    expect(entryValue('sandbox', resolve({ values: { sandbox: 'required' } }))).toBe('required');
    expect(() => resolve({ values: { sandbox: 'off' } })).toThrow(/explicit opt-in/);
    expect(entryValue('sandbox', resolve({ values: { sandbox: 'off' }, optIn: ['sandbox'] }))).toBe(
      'off',
    );
    expect(() => resolve({ values: { 'sandbox.network': 'allow' } })).toThrow(/explicit opt-in/);
    expect(
      entryValue(
        'sandbox.network',
        resolve({
          values: { 'sandbox.network': 'allow' },
          optIn: ['sandbox.network=allow'],
        }),
      ),
    ).toBe('allow');
    expect(entryValue('run.tool', resolve({ values: { 'run.tool': 'off' } }))).toBe('off');
    expect(() => resolve({ values: { 'sandbox.backend': 'landlock' } })).toThrow(/explicit opt-in/);
  });

  it('resolves all static RS-15 keys plus the dynamic provider-key family', () => {
    const config = resolve({
      env: { CQ_PROVIDER_ZAI_GLM_CODING_RPM: '12', CQ_BUDGET_MAX_USD: '5.25' },
    });
    expect(entryValue('provider.zai-glm-coding.rpm', config)).toBe(12);
    expect(entryValue('budget.maxUsd', config)).toBe(5.25);
    expect(Object.keys(config.entries)).toContain('merge.trustedAssociations');
    expect(() => resolve({ env: { CQ_PROVIDER_ZAI_GLM_CODING_RMP: '12' } })).toThrow(
      /unknown configuration variable/,
    );
    const custom = resolve({
      env: {
        CQ_PROVIDER_CUSTOM_VENDOR_PROFILE: 'custom:/opt/cq/provider.json',
        CQ_PROVIDER_CUSTOM_VENDOR_RPM: '9',
      },
    });
    expect(entryValue('provider.custom-vendor.rpm', custom)).toBe(9);
  });

  it('records CQ secrets and foreign credentials by presence only', () => {
    const config = resolve({
      env: { CQ_AUTOMATION_TOKEN: 'private', ZAI_API_KEY: 'private' },
    });
    expect(config.secrets).toEqual({
      CQ_AUTOMATION_TOKEN: { layer: 'env', set: true },
    });
    expect(config.credentials).toEqual({ ZAI_API_KEY: 'set' });
    expect(JSON.stringify(config)).not.toContain('private');
  });

  it('accepts the RS-15 call-only governance inputs without env mirrors', () => {
    const config = resolve({
      optIn: ['attended', 'budget.raiseCap', 'budget.legacyJournal=reset'],
    });
    expect(entryValue('attended', config)).toBe(true);
    expect(entryValue('budget.raiseCap', config)).toBe(true);
    expect(entryValue('budget.legacyJournal', config)).toBe('reset');
    expect(() => resolve({ env: { CQ_BUDGET_RAISE_CAP: 'true' } })).toThrow(
      /unknown configuration variable/,
    );
  });

  it('treats blank as layer empty and the literal none as an explicit empty list', () => {
    expect(
      entryValue('run.envPassthrough', resolve({ env: { CQ_RUN_ENV_PASSTHROUGH: ' ' } })),
    ).toEqual([]);
    expect(
      entryValue('run.envPassthrough', resolve({ env: { CQ_RUN_ENV_PASSTHROUGH: 'none' } })),
    ).toEqual([]);
    expect(() => resolve({ env: { CQ_RUN_ENV_PASSTHROUGH: 'A,,B' } })).toThrow(/empty list item/);
  });

  it('validates binding grammar independently from fractional maps and accepts typed records', () => {
    expect(entryValue('driver.bindings', resolve())).toMatchObject({
      '*/zai': 'ai-sdk',
    });
    expect(
      entryValue(
        'driver.bindings',
        resolve({
          values: { 'driver.bindings': { 'custom/vendor': 'ai-sdk' } },
          optIn: ['driver.bindings'],
        }),
      ),
    ).toMatchObject({
      '*/zai': 'ai-sdk',
      '*/anthropic': 'ai-sdk',
      '*/openai': 'ai-sdk',
      '*/deepseek': 'ai-sdk',
      'custom/vendor': 'ai-sdk',
    });
    expect(() => resolve({ values: { 'driver.bindings': { bad: {} } as never } })).toThrow(
      /map values must be strings/,
    );
    expect(
      entryValue(
        'provider.zai-glm-coding.windowFractions',
        resolve({ env: { CQ_PROVIDER_ZAI_GLM_CODING_WINDOW_FRACTIONS: 'coding:0.5' } }),
      ),
    ).toEqual({ coding: '0.5' });
  });

  it('keeps CQ token values out of every resolved entry', () => {
    const config = resolve({ env: { CQ_AUTOMATION_TOKEN: 'secret-value' } });
    expect(config.entries['automation.token']?.value).toBeNull();
    expect(JSON.stringify(config)).not.toContain('secret-value');
  });

  it('denies credential, host-control, and credential-URL passthrough names', () => {
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'SSH_AUTH_SOCK',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'NODE_OPTIONS',
      'PATH',
      'DATABASE_URL',
    ]) {
      expect(() => resolve({ env: { CQ_RUN_ENV_PASSTHROUGH: name } })).toThrow(
        /cannot be passed through/,
      );
    }
    expect(() =>
      resolve({
        env: {
          CQ_RUN_ENV_PASSTHROUGH: 'SAFE_ENDPOINT',
          SAFE_ENDPOINT: 'https://user:pass@example.test',
        },
      }),
    ).toThrow(/cannot be passed through/);
    expect(() =>
      resolve({
        values: { 'run.envPassthrough': ['SAFE_ENDPOINT'] },
        optIn: ['run.envPassthrough'],
        env: { SAFE_ENDPOINT: 'https://user:pass@example.test' },
      }),
    ).toThrow(/cannot be passed through/);
  });

  it('requires expanded, caller-verified paths outside the workspace', () => {
    expect(() => resolve({ env: { CQ_DRIVER_SESSIONS_DIR: '$HOME/sessions' } })).toThrow(
      /unresolved absolute path variable/,
    );
    expect(() => resolveConfig({ env: { TMPDIR: '/tmp', XDG_STATE_HOME: '/tmp' } })).toThrow(
      /verified workspace path evidence required/,
    );
    expect(() =>
      resolve({
        env: { CQ_DRIVER_SESSIONS_DIR: '/workspace/sessions' },
        verifiedRealpaths: {
          CQ_DRIVER_SESSIONS_DIR: {
            input: '/workspace/sessions',
            realpath: '/workspace/sessions',
          },
        },
      }),
    ).toThrow(/outside the workspace/);
    const canonical = '/var/tmp/canonical-sessions';
    const expanded = resolve({
      env: { CQ_DRIVER_SESSIONS_DIR: '$TMPDIR/cq-harness/sessions' },
      verifiedRealpaths: {
        CQ_DRIVER_SESSIONS_DIR: { input: sessions, realpath: canonical },
      },
    });
    expect(entryValue('driver.sessionsDir', expanded)).toBe(canonical);
    expect(entryValue('approval.ledger', resolve())).toBe('/tmp/cq/approvals.ndjson');
  });

  it('rejects relative executable paths, non-HTTPS endpoints, and malformed semantic windows', () => {
    expect(() =>
      resolve({
        env: { CQ_DRIVER_SUBPROCESS_COMMAND: '["bin/claude"]' },
      }),
    ).toThrow(/argv/);
    expect(() =>
      resolve({
        env: {
          CQ_PROVIDER_ZAI_GLM_CODING_QUOTA_ENDPOINT: 'http://quota.example/api',
        },
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      resolve({
        env: { CQ_PROVIDER_ZAI_GLM_CODING_PEAK_WINDOWS: 'Mon 25:00-26:00 UTC' },
      }),
    ).toThrow(/invalid quota window/);
  });

  it('pins credential-bearing quota endpoints to registered bundled usage hosts', () => {
    expect(() =>
      resolve({
        env: { CQ_PROVIDER_ZAI_GLM_CODING_QUOTA_ENDPOINT: 'https://attacker.example/usage' },
      }),
    ).toThrow(/no bundled credential-bearing usage endpoint host is registered/);
    expect(() =>
      resolve({
        env: { CQ_PROVIDER_DEEPSEEK_QUOTA_ENDPOINT: 'https://attacker.example/user/balance' },
      }),
    ).toThrow(/host must match the bundled provider usage endpoint/);
    expect(() =>
      resolve({
        env: { CQ_PROVIDER_DEEPSEEK_QUOTA_ENDPOINT: 'https://api.deepseek.com/user/balance' },
      }),
    ).not.toThrow();
  });

  it('accepts overnight UTC windows and independently optional multiplier or offset', () => {
    expect(() =>
      resolve({
        env: { CQ_PROVIDER_ZAI_GLM_CODING_PEAK_WINDOWS: 'Mon 23:00-02:00 UTC; mult=1.5' },
      }),
    ).not.toThrow();
    expect(() =>
      resolve({
        env: { CQ_PROVIDER_ZAI_GLM_CODING_PEAK_WINDOWS: 'Tue 08:00-09:00 Asia/Singapore; off=2' },
      }),
    ).not.toThrow();
  });

  it('deep freezes returned arrays', () => {
    const value = entryValue(
      'run.envPassthrough',
      resolve({
        values: { 'run.envPassthrough': ['SAFE'] },
        optIn: ['run.envPassthrough'],
      }),
    );
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('marks path, argv, and executable registry items as unavailable to CI vars', () => {
    for (const key of CONFIG_REGISTRY.filter(
      (item) =>
        item.type === 'path' ||
        item.type === 'argv' ||
        ['CQ_GH_BIN', 'CQ_DRIVER_ACP_ENDPOINT'].includes(item.env),
    )) {
      expect(key.ci).toBe(false);
    }
  });
});
