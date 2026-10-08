import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_REGISTRY } from '../../src/config/registry.js';
import { resolveConfig } from '../../src/config/resolve.js';

const root = '/workspace';
const state = '/tmp';
const sessions = '/tmp/cq-harness/sessions';
const baselineEnv = { XDG_STATE_HOME: '/tmp', TMPDIR: '/tmp' };
function resolve(input: Parameters<typeof resolveConfig>[0] = {}) {
  const platform = input.platform ?? 'posix';
  const fixtureRoot = platform === 'win32' ? 'C:\\workspace' : root;
  const fixtureState = platform === 'win32' ? 'C:\\tmp' : state;
  const separator = platform === 'win32' ? '\\' : '/';
  const fixtureLedger = `${fixtureState}${separator}cq${separator}approvals.ndjson`;
  const fixtureSessions = `${fixtureState}${separator}cq-harness${separator}sessions`;
  const env = {
    ...(platform === 'win32'
      ? { XDG_STATE_HOME: fixtureState, TMPDIR: fixtureState }
      : baselineEnv),
    ...input.env,
  };
  const customProfiles = Object.fromEntries(
    Object.entries(env)
      .filter(
        ([name, value]) =>
          /^CQ_PROVIDER_[A-Z0-9_]+_PROFILE$/.test(name) && value?.startsWith('custom:/'),
      )
      .map(([name, value]) => [
        name,
        {
          input: value!.slice('custom:'.length),
          realpath: value!.slice('custom:'.length),
        },
      ]),
  );
  return resolveConfig({
    ...input,
    env,
    workspaceRootRealpath: fixtureRoot,
    verifiedRealpaths: {
      CQ_APPROVAL_LEDGER: {
        input: fixtureLedger,
        realpath: fixtureLedger,
      },
      CQ_DRIVER_SESSIONS_DIR: { input: fixtureSessions, realpath: fixtureSessions },
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
        resolve({
          env: { CQ_PROVIDER_ZAI_GLM_CODING_WINDOW_FRACTIONS: 'coding:0.5' },
        }),
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
    expect(() => resolve({ env: { CQ_DRIVER_SESSIONS_DIR: '<x>' } })).toThrow(
      /expected an expanded absolute path/,
    );
    expect(() => resolve({ env: { CQ_APPROVAL_SIGNERS: '<x>' } })).toThrow(
      /expected an expanded absolute path/,
    );
    expect(() => resolve({ env: { CQ_DRIVER_SESSIONS_DIR: '$HOME/sessions' } })).toThrow(
      /unresolved absolute path variable/,
    );
    expect(() => resolveConfig({ env: { TMPDIR: '/tmp', XDG_STATE_HOME: '/tmp' } })).toThrow(
      /verified workspace path evidence required/,
    );
    expect(() =>
      resolve({
        env: { CQ_APPROVAL_SIGNERS: '/workspace/signers' },
        verifiedRealpaths: {
          CQ_APPROVAL_SIGNERS: {
            input: '/workspace/signers',
            realpath: '/workspace/signers',
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
    expect(entryValue('driver.acp.command', resolve())).toBe('<endpoint-argv>');
    expect(() => resolve({ env: { CQ_DRIVER_ACP_COMMAND: '<x>' } })).toThrow(/JSON argv/);
    expect(entryValue('driver.subprocess.routing', resolve())).toBe('<default-routing-table>');
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
        env: {
          CQ_PROVIDER_ZAI_GLM_CODING_QUOTA_ENDPOINT: 'https://attacker.example/usage',
        },
      }),
    ).toThrow(/no bundled credential-bearing usage endpoint host is registered/);
    expect(() =>
      resolve({
        env: {
          CQ_PROVIDER_DEEPSEEK_QUOTA_ENDPOINT: 'https://attacker.example/user/balance',
        },
      }),
    ).toThrow(/host must match the bundled provider usage endpoint/);
    expect(() =>
      resolve({
        env: {
          CQ_PROVIDER_DEEPSEEK_QUOTA_ENDPOINT: 'https://api.deepseek.com/user/balance',
        },
      }),
    ).not.toThrow();
  });

  it('accepts overnight UTC windows and independently optional multiplier or offset', () => {
    expect(() =>
      resolve({
        env: {
          CQ_PROVIDER_ZAI_GLM_CODING_PEAK_WINDOWS: 'Mon 23:00-02:00 UTC; mult=1.5',
        },
      }),
    ).not.toThrow();
    expect(() =>
      resolve({
        env: {
          CQ_PROVIDER_ZAI_GLM_CODING_PEAK_WINDOWS: 'Tue 08:00-09:00 Asia/Singapore; off=2',
        },
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

  describe('review-hardening of config resolution', () => {
    it('rejects lowercase provider variable names and malformed foreign base URLs', () => {
      expect(() => resolve({ env: { CQ_PROVIDER_deepseek_RPM: '12' } })).toThrow(
        /unknown configuration variable/,
      );
      expect(() => resolve({ env: { ZAI_BASE_URL: 'https://example.com:abc' } })).toThrow(
        /expected HTTPS URL/,
      );
    });

    it('treats whitespace-only CQ secrets as unset and denies passthrough case-insensitively', () => {
      expect(resolve({ env: { CQ_AUTOMATION_TOKEN: '   ' } }).secrets).toEqual({});
      expect(() => resolve({ env: { CQ_RUN_ENV_PASSTHROUGH: 'node_options' } })).toThrow(
        /cannot be passed through/,
      );
    });

    it('applies the registered list grammar to call-only lists', () => {
      const quarantine = (value: string) =>
        resolve({
          values: { 'budget.releaseQuarantine': value },
          optIn: ['budget.releaseQuarantine'],
        }).entries['budget.releaseQuarantine']?.value;
      expect(quarantine('none')).toEqual([]);
      expect(quarantine('run-b,run-a')).toEqual(['run-a', 'run-b']);
      expect(() => quarantine('run-a,,run-b')).toThrow(/empty list item/);
      expect(() => quarantine('run-a,run-a')).toThrow(/duplicate list item/);
    });

    it('judges per-call map values by their merged result', () => {
      const config = resolve({ values: { 'driver.bindings': { '*/zai': 'ai-sdk' } } });
      expect(config.entries['driver.bindings']?.layer).toBe('call');
      expect(() => resolve({ values: { 'driver.bindings': { '*/zai': 'claude-agent' } } })).toThrow(
        /explicit opt-in/,
      );
    });

    it('compares opt-in values to typed records and lists after parsing', () => {
      const bindings = resolve({
        values: { 'driver.bindings': { 'custom/vendor': 'ai-sdk' } },
        optIn: ['driver.bindings=custom/vendor:ai-sdk'],
      });
      expect(entryValue('driver.bindings', bindings)).toMatchObject({
        'custom/vendor': 'ai-sdk',
      });
      expect(
        entryValue(
          'run.envPassthrough',
          resolve({
            values: { 'run.envPassthrough': ['SAFE_B', 'SAFE_A'] },
            optIn: ['run.envPassthrough=SAFE_A,SAFE_B'],
          }),
        ),
      ).toEqual(['SAFE_A', 'SAFE_B']);
      expect(() =>
        resolve({
          values: { 'driver.bindings': { 'custom/vendor': 'ai-sdk' } },
          optIn: ['driver.bindings=custom/vendor:subprocess'],
        }),
      ).toThrow(/disagrees/);
    });

    it('treats blank foreign credentials as unset and ignores prototype names', () => {
      expect(resolve({ env: { GH_TOKEN: '', ZAI_API_KEY: '  ' } }).credentials).toEqual({});
      expect(() => resolve({ optIn: ['constructor'] })).toThrow(/unknown opt-in key/);
      expect(() => resolve({ values: { toString: 'x' } })).toThrow(/unknown per-call/);
      expect(
        entryValue(
          'provider.zai-glm-coding.windowFractions',
          resolve({ env: { CQ_PROVIDER_ZAI_GLM_CODING_WINDOW_FRACTIONS: 'constructor:0.5' } }),
        ),
      ).toEqual({ constructor: '0.5' });
    });
  });

  describe('address review: strictness gaps', () => {
    it('case-folds ACP env names and rejects unsafe ms integers', () => {
      expect(() => resolve({ env: { CQ_DRIVER_ACP_ENV_NAMES: 'cq_sandbox' } })).toThrow(
        /CQ_\* policy/,
      );
      expect(() => resolve({ env: { CQ_GH_TIMEOUT_MS: '9007199254740993' } })).toThrow(
        /out of range/,
      );
    });

    it('restricts bundled provider profile values', () => {
      expect(() => resolve({ env: { CQ_PROVIDER_DEEPSEEK_PROFILE: 'bundle' } })).toThrow(/bundled/);
    });

    it('accepts typed served-alias records and order-insensitive call-only opt-ins', () => {
      const config = resolve({
        optIn: ['driver.servedAliases'],
        values: { 'driver.servedAliases': { 'ai-sdk/provider/requested': 'served' } },
      });
      expect(entryValue('driver.servedAliases', config)).toEqual({
        'ai-sdk/provider/requested': 'served',
      });
      expect(() =>
        resolve({
          optIn: ['budget.releaseQuarantine=run-a,run-b'],
          values: { 'budget.releaseQuarantine': ['run-b', 'run-a'] },
        }),
      ).not.toThrow();
    });

    it('treats reap-on-settle as a tightening of session retention', () => {
      const config = resolve({ values: { 'driver.sessionRetention': 'reap-on-settle' } });
      expect(entryValue('driver.sessionRetention', config)).toBe('reap-on-settle');
    });
  });

  describe('conductor pass: review findings', () => {
    // F1 (predecessor CLI cycle 1): a provider key must be matched by its
    // underscore-separated suffix, and the derived provider id must not keep a
    // trailing separator.
    it('requires an underscore-separated provider key suffix (F1)', () => {
      for (const name of [
        'CQ_PROVIDER_DEEPSEEKRPM',
        'CQ_PROVIDER_DEEPSEEK__RPM',
        'CQ_PROVIDER_DEEPSEEK_RPMX',
      ]) {
        expect(() => resolve({ env: { [name]: '12' } })).toThrow(/unknown configuration variable/);
      }
      expect(() =>
        resolve({ env: { CQ_PROVIDER_ACMEPROFILE: 'custom:/opt/cq/acme.json' } }),
      ).toThrow(/unknown configuration variable/);
      expect(() =>
        resolve({ env: { CQ_PROVIDER_ACME__PROFILE: 'custom:/opt/cq/acme.json' } }),
      ).toThrow(/unknown configuration variable/);
      const custom = resolve({
        env: { CQ_PROVIDER_ACME_PROFILE: 'custom:/opt/cq/acme.json', CQ_PROVIDER_ACME_RPM: '7' },
      });
      expect(entryValue('provider.acme.rpm', custom)).toBe(7);
      expect(Object.keys(custom.entries).some((id) => id.startsWith('provider.acme-'))).toBe(false);
    });

    it('checks workspace evidence against the effective path only', () => {
      const ledger = '/var/lib/cq/approvals.ndjson';
      const sessionsDir = '/var/lib/cq/sessions';
      // Neither XDG_STATE_HOME nor TMPDIR is set: explicit overrides must still resolve.
      const config = resolveConfig({
        env: { CQ_APPROVAL_LEDGER: ledger, CQ_DRIVER_SESSIONS_DIR: sessionsDir },
        workspaceRootRealpath: root,
        verifiedRealpaths: {
          CQ_APPROVAL_LEDGER: { input: ledger, realpath: ledger },
          CQ_DRIVER_SESSIONS_DIR: { input: sessionsDir, realpath: sessionsDir },
        },
      });
      expect(entryValue('approval.ledger', config)).toBe(ledger);
      expect(config.entries['approval.ledger']?.changed).toBe(true);
      expect(entryValue('driver.sessionsDir', config)).toBe(sessionsDir);
      // A per-call sessions dir that differs from the default is verified on its own evidence.
      const perCall = resolve({
        values: { 'driver.sessionsDir': sessionsDir },
        verifiedRealpaths: {
          CQ_DRIVER_SESSIONS_DIR: { input: sessionsDir, realpath: sessionsDir },
        },
      });
      expect(entryValue('driver.sessionsDir', perCall)).toBe(sessionsDir);
      // Without an override the unset default variable still fails closed.
      expect(() => resolveConfig({ env: { TMPDIR: '/tmp' }, workspaceRootRealpath: root })).toThrow(
        /CQ_APPROVAL_LEDGER: unresolved absolute path variable/,
      );
    });

    it('rejects unbalanced or unsupported path-variable syntax', () => {
      for (const value of ['${TMPDIR:-/var/tmp}/cq', '${TMPDIR/cq', '$TMPDIR}/cq']) {
        expect(() => resolve({ env: { CQ_JOURNAL_DIR: value } })).toThrow(
          /expected an expanded absolute path/,
        );
      }
      expect(entryValue('journal.dir', resolve({ env: { CQ_JOURNAL_DIR: '${TMPDIR}/cq' } }))).toBe(
        '/tmp/cq',
      );
    });

    it('treats a drive-prefixed executable as path-like', () => {
      expect(() => resolve({ env: { CQ_DRIVER_SUBPROCESS_COMMAND: '["C:claude.exe"]' } })).toThrow(
        /argv/,
      );
    });

    it('requires an explicit opt-in for call-only relaxations', () => {
      for (const id of ['budget.raiseCap', 'budget.ungovernedOverGoverned']) {
        expect(() => resolve({ values: { [id]: true } })).toThrow(/requires explicit opt-in/);
        expect(resolve({ values: { [id]: true }, optIn: [id] }).entries[id]?.relaxed).toBe(true);
        expect(resolve({ values: { [id]: false } }).entries[id]?.relaxed).toBe(false);
      }
      expect(() => resolve({ values: { 'budget.breakLock': 'run-a' } })).toThrow(
        /requires explicit opt-in/,
      );
    });

    it('screens trimmed passthrough values for credential URLs', () => {
      expect(() =>
        resolve({
          env: {
            CQ_RUN_ENV_PASSTHROUGH: 'SAFE_ENDPOINT',
            SAFE_ENDPOINT: ' https://user:pass@example.test',
          },
        }),
      ).toThrow(/cannot be passed through/);
    });

    it('keeps the bundled solo-maintainer seed aligned with the registry solo values', () => {
      const text = readFileSync(
        new URL('../../policy/profiles/solo-maintainer.profile', import.meta.url),
        'utf8',
      );
      const seeded = Object.fromEntries(
        text
          .split('\n')
          .filter((line) => /^CQ_[A-Z0-9_]+=/.test(line))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      const fromRegistry = Object.fromEntries(
        CONFIG_REGISTRY.filter((key) => key.solo !== undefined && key.solo !== key.blank).map(
          (key) => [key.env, key.solo],
        ),
      );
      expect(seeded).toEqual(fromRegistry);
    });

    it('rejects driver bindings that name an unknown lane', () => {
      expect(() => resolve({ env: { CQ_DRIVER_BINDINGS: '*/zai:ai-skd' } })).toThrow(
        /invalid map token/,
      );
    });
  });

  describe('post-merge #256 follow-up: P2 review findings', () => {
    it('rejects noncanonical CQ_* spellings that Windows lookups would alias', () => {
      for (const name of ['cq_approval_max_ttl_ms', 'Cq_Profile', 'cQ_SANDBOX']) {
        expect(() => resolve({ env: { [name]: 'x' } })).toThrow(
          /expected canonical CQ_\* spelling/,
        );
      }
    });

    it('screens slashless URL-standard credential forms in passthrough values', () => {
      for (const value of ['https:user:pass@example.test', 'https:/user:pass@example.test']) {
        expect(() =>
          resolve({ env: { CQ_RUN_ENV_PASSTHROUGH: 'SAFE_ENDPOINT', SAFE_ENDPOINT: value } }),
        ).toThrow(/cannot be passed through/);
      }
    });

    it('requires the standalone gh executable to be a bare name or an absolute path', () => {
      expect(entryValue('gh.bin', resolve())).toBe('gh');
      expect(entryValue('gh.bin', resolve({ env: { CQ_GH_BIN: '/usr/local/bin/gh' } }))).toBe(
        '/usr/local/bin/gh',
      );
      for (const value of ['bin/gh', '.\\bin\\gh.exe', 'C:gh.exe']) {
        expect(() => resolve({ env: { CQ_GH_BIN: value } })).toThrow(/bare executable name/);
      }
    });

    it('validates served-alias lanes against the shipped lane set', () => {
      expect(() =>
        resolve({ env: { CQ_DRIVER_SERVED_ALIASES: 'ai-skd/provider/requested=served' } }),
      ).toThrow(/invalid served-alias entry/);
      expect(
        entryValue(
          'driver.servedAliases',
          resolve({ env: { CQ_DRIVER_SERVED_ALIASES: 'acp/provider/requested=served' } }),
        ),
      ).toEqual({ 'acp/provider/requested': 'served' });
    });

    it('reads caller records for own properties only', () => {
      const inheritedEnv = Object.assign(Object.create({ CQ_PROFILE: 'solo-maintainer' }), {
        XDG_STATE_HOME: '/tmp',
        TMPDIR: '/tmp',
      }) as Record<string, string | undefined>;
      const config = resolveConfig({
        env: inheritedEnv,
        workspaceRootRealpath: root,
        verifiedRealpaths: {
          CQ_APPROVAL_LEDGER: {
            input: `${state}/cq/approvals.ndjson`,
            realpath: `${state}/cq/approvals.ndjson`,
          },
          CQ_DRIVER_SESSIONS_DIR: { input: sessions, realpath: sessions },
        },
      });
      expect(config.profile).toBe('conservative');
      const inheritedValues = Object.create({ sandbox: 'off' }) as Exclude<
        NonNullable<Parameters<typeof resolveConfig>[0]>['values'],
        undefined
      >;
      expect(() =>
        resolveConfig({
          env: { ...baselineEnv },
          values: inheritedValues,
          workspaceRootRealpath: root,
          verifiedRealpaths: {
            CQ_APPROVAL_LEDGER: {
              input: `${state}/cq/approvals.ndjson`,
              realpath: `${state}/cq/approvals.ndjson`,
            },
            CQ_DRIVER_SESSIONS_DIR: { input: sessions, realpath: sessions },
          },
        }),
      ).not.toThrow();
    });

    it('rejects non-string scalars for list settings', () => {
      expect(() =>
        resolve({ values: { 'run.envPassthrough': true }, optIn: ['run.envPassthrough'] }),
      ).toThrow(/expected a string or string list/);
      expect(() =>
        resolve({
          values: { 'budget.releaseQuarantine': 42 },
          optIn: ['budget.releaseQuarantine'],
        }),
      ).toThrow(/expected a string or string list/);
    });

    it('case-folds structurally excluded bot logins', () => {
      for (const login of ['GitHub-Actions[bot]', 'CQ-Promoter[bot]']) {
        expect(() => resolve({ env: { CQ_MERGE_TRUSTED_BOTS: login } })).toThrow(
          /structurally excluded/,
        );
      }
    });

    it('deep-freezes secret presence records', () => {
      const config = resolve({ env: { CQ_AUTOMATION_TOKEN: 'private' } });
      expect(config.secrets.CQ_AUTOMATION_TOKEN).toEqual({ layer: 'env', set: true });
      expect(Object.isFrozen(config.secrets.CQ_AUTOMATION_TOKEN)).toBe(true);
    });
  });

  describe('post-merge #285 review findings', () => {
    // MAJOR (PRRT_kwDOUY73E86qLJRX): Object.fromEntries reintroduces
    // Object.prototype, so a polluted inherited name could be read back as
    // configuration on a direct lookup such as env.CQ_PROFILE.
    it('ignores Object.prototype pollution in caller records', () => {
      const proto = Object.prototype as Record<string, unknown>;
      proto.CQ_PROFILE = 'solo-maintainer';
      proto.CQ_APPROVAL_LEDGER = {
        input: `${state}/cq/approvals.ndjson`,
        realpath: `${state}/cq/approvals.ndjson`,
      };
      proto['run.envPassthrough'] = 'PATH';
      try {
        // The registry's path defaults need the state/tmp variables, so every
        // direct call here supplies them; the polluted names stay absent from
        // each record's own properties.
        const baseEnv = { XDG_STATE_HOME: '/tmp', TMPDIR: '/tmp' };
        const workspaceEvidence = {
          workspaceRootRealpath: root,
          verifiedRealpaths: {
            CQ_APPROVAL_LEDGER: {
              input: `${state}/cq/approvals.ndjson`,
              realpath: `${state}/cq/approvals.ndjson`,
            },
            CQ_DRIVER_SESSIONS_DIR: { input: sessions, realpath: sessions },
          },
        };
        expect(resolveConfig({ env: { ...baseEnv }, ...workspaceEvidence }).profile).toBe(
          'conservative',
        );
        expect(resolveConfig({ env: baseEnv, values: {}, ...workspaceEvidence }).profile).toBe(
          'conservative',
        );
        expect(() => resolve({ values: {} })).not.toThrow();
        expect(() =>
          resolve({
            env: { CQ_APPROVAL_LEDGER: `${state}/cq/approvals.ndjson` },
            verifiedRealpaths: {},
          }),
        ).toThrow(/verified workspace path evidence required/);
      } finally {
        delete proto.CQ_PROFILE;
        delete proto.CQ_APPROVAL_LEDGER;
        delete proto['run.envPassthrough'];
      }
    });

    // MAJOR (PRRT_kwDOUY73E86qLJRe): a copied Windows process.env snapshot has
    // no case-insensitive lookup, so a passthrough name must be screened
    // against the case-variant value it resolves to downstream.
    it('screens Windows passthrough names against case-variant values', () => {
      const credential = 'https://user:pass@example.test';
      expect(() =>
        resolve({ env: { CQ_RUN_ENV_PASSTHROUGH: 'gh_token', GH_TOKEN: credential } }),
      ).toThrow(/cannot be passed through/);
      expect(() =>
        resolve({ env: { CQ_RUN_ENV_PASSTHROUGH: 'safe_endpoint', SAFE_ENDPOINT: credential } }),
      ).not.toThrow();
      expect(() =>
        resolve({
          env: { CQ_RUN_ENV_PASSTHROUGH: 'safe_endpoint', SAFE_ENDPOINT: credential },
          platform: 'win32',
        }),
      ).toThrow(/cannot be passed through/);
    });

    // MINOR (PRRT_kwDOUY73E86qLJRf): a Windows drive path is a filename even
    // when it contains a colon and a '#'.
    it('does not treat drive-prefixed paths as credential URLs', () => {
      for (const value of ['C:\\cache#v1', 'C:/cache#v1']) {
        expect(
          entryValue(
            'run.envPassthrough',
            resolve({ env: { CQ_RUN_ENV_PASSTHROUGH: 'SAFE_CACHE', SAFE_CACHE: value } }),
          ),
        ).toEqual(['SAFE_CACHE']);
      }
      expect(() =>
        resolve({
          env: {
            CQ_RUN_ENV_PASSTHROUGH: 'SAFE_CACHE',
            SAFE_CACHE: 'https://user:pass@example.test',
          },
        }),
      ).toThrow(/cannot be passed through/);
    });

    // MINOR (PRRT_kwDOUY73E86qLJJy): path.win32 accepts root-relative paths,
    // which resolve against the current drive; a Windows executable location
    // must be drive-qualified, a full UNC path, or a bare name.
    it('requires a drive-qualified or UNC absolute executable path on Windows', () => {
      expect(
        entryValue(
          'gh.bin',
          resolve({ env: { CQ_GH_BIN: 'C:\\tools\\gh.exe' }, platform: 'win32' }),
        ),
      ).toBe('C:\\tools\\gh.exe');
      expect(
        entryValue(
          'gh.bin',
          resolve({ env: { CQ_GH_BIN: '\\\\server\\share\\gh.exe' }, platform: 'win32' }),
        ),
      ).toBe('\\\\server\\share\\gh.exe');
      for (const value of ['/usr/local/bin/gh', '\\bin\\gh.exe', 'C:bin\\gh.exe']) {
        expect(() => resolve({ env: { CQ_GH_BIN: value }, platform: 'win32' })).toThrow(
          /bare executable name/,
        );
      }
      expect(() =>
        resolve({
          env: { CQ_DRIVER_SUBPROCESS_COMMAND: '["/bin/claude.exe"]' },
          platform: 'win32',
        }),
      ).toThrow(/argv/);
      expect(
        entryValue(
          'driver.subprocess.command',
          resolve({
            env: { CQ_DRIVER_SUBPROCESS_COMMAND: '["C:\\\\bin\\\\claude.exe"]' },
            platform: 'win32',
          }),
        ),
      ).toEqual(['C:\\bin\\claude.exe']);
    });
  });
});
