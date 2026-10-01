import { describe, expect, it } from 'vitest';
import { CONFIG_REGISTRY } from '../../src/config/registry.js';
import { resolveConfig } from '../../src/config/resolve.js';

function entryValue(id: string, config: ReturnType<typeof resolveConfig>) {
  const entry = config.entries[id];
  if (!entry) throw new Error(`missing config entry ${id}`);
  return entry.value;
}

describe('pure configuration resolution', () => {
  it('uses built-ins for unset, empty, and whitespace values', () => {
    for (const value of [undefined, '', '  \t']) {
      const config = resolveConfig({ env: { CQ_SANDBOX: value } });
      expect(entryValue('sandbox', config)).toBe('required');
    }
  });

  it('seeds project env from the bundled profile, then explicit env wins', () => {
    expect(entryValue('sandbox', resolveConfig({ env: { CQ_PROFILE: 'solo-maintainer' } }))).toBe(
      'off',
    );
    const envOverride = resolveConfig({
      env: { CQ_PROFILE: 'solo-maintainer', CQ_SANDBOX: 'required' },
    });
    expect(envOverride.entries.sandbox?.layer).toBe('env');
    expect(entryValue('sandbox', envOverride)).toBe('required');
  });

  it('rejects unknown CQ variables and invalid profile values', () => {
    expect(() => resolveConfig({ env: { CQ_SANDBOX_NETWROK: 'allow' } })).toThrow(
      /did you mean CQ_SANDBOX_NETWORK/,
    );
    expect(() =>
      resolveConfig({ env: { CQ_SANDBOX_NETWROK: 'allow', CQ_MERGE_TRUSTED_BOTSX: 'x' } }),
    ).toThrow(/\n/);
    expect(() => resolveConfig({ env: { CQ_PROFILE: 'custom' } })).toThrow(/unsupported profile/);
  });

  it('materializes provenance for every static and bundled-provider key', () => {
    const config = resolveConfig();
    expect(Object.keys(config.entries)).toHaveLength(CONFIG_REGISTRY.length);
    for (const key of CONFIG_REGISTRY) expect(config.entries[key.id]).toBeDefined();
  });

  it('allows tightening without opt-in and requires a named key for relaxation', () => {
    expect(entryValue('sandbox', resolveConfig({ values: { sandbox: 'required' } }))).toBe(
      'required',
    );
    expect(() => resolveConfig({ values: { sandbox: 'off' } })).toThrow(/explicit opt-in/);
    expect(
      entryValue('sandbox', resolveConfig({ values: { sandbox: 'off' }, optIn: ['sandbox'] })),
    ).toBe('off');
    expect(() => resolveConfig({ values: { 'sandbox.network': 'allow' } })).toThrow(
      /explicit opt-in/,
    );
    expect(
      entryValue(
        'sandbox.network',
        resolveConfig({ values: { 'sandbox.network': 'allow' }, optIn: ['sandbox.network=allow'] }),
      ),
    ).toBe('allow');
    expect(entryValue('run.tool', resolveConfig({ values: { 'run.tool': 'off' } }))).toBe('off');
    expect(() => resolveConfig({ values: { 'sandbox.backend': 'landlock' } })).toThrow(
      /explicit opt-in/,
    );
  });

  it('resolves all static RS-15 keys plus the dynamic provider-key family', () => {
    const config = resolveConfig({
      env: { CQ_PROVIDER_ZAI_GLM_CODING_RPM: '12', CQ_BUDGET_MAX_USD: '5.25' },
    });
    expect(entryValue('provider.zai-glm-coding.rpm', config)).toBe(12);
    expect(entryValue('budget.maxUsd', config)).toBe(5.25);
    expect(Object.keys(config.entries)).toContain('merge.trustedAssociations');
    expect(() => resolveConfig({ env: { CQ_PROVIDER_ZAI_GLM_CODING_RMP: '12' } })).toThrow(
      /unknown configuration variable/,
    );
    const custom = resolveConfig({
      env: {
        CQ_PROVIDER_CUSTOM_VENDOR_PROFILE: 'custom:/opt/cq/provider.json',
        CQ_PROVIDER_CUSTOM_VENDOR_RPM: '9',
      },
    });
    expect(entryValue('provider.custom-vendor.rpm', custom)).toBe(9);
  });

  it('records CQ secrets and foreign credentials by presence only', () => {
    const config = resolveConfig({
      env: { CQ_AUTOMATION_TOKEN: 'private', ZAI_API_KEY: 'private' },
    });
    expect(config.secrets).toEqual({ CQ_AUTOMATION_TOKEN: { layer: 'env', set: true } });
    expect(config.credentials).toEqual({ ZAI_API_KEY: 'set' });
    expect(JSON.stringify(config)).not.toContain('private');
  });

  it('accepts the RS-15 call-only governance inputs without env mirrors', () => {
    const config = resolveConfig({
      optIn: ['attended', 'budget.raiseCap', 'budget.legacyJournal=reset'],
    });
    expect(entryValue('attended', config)).toBe(true);
    expect(entryValue('budget.raiseCap', config)).toBe(true);
    expect(entryValue('budget.legacyJournal', config)).toBe('reset');
    expect(() => resolveConfig({ env: { CQ_BUDGET_RAISE_CAP: 'true' } })).toThrow(
      /unknown configuration variable/,
    );
  });

  it('treats blank as layer empty and the literal none as an explicit empty list', () => {
    expect(
      entryValue('run.envPassthrough', resolveConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: ' ' } })),
    ).toEqual([]);
    expect(
      entryValue('run.envPassthrough', resolveConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: 'none' } })),
    ).toEqual([]);
    expect(() => resolveConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: 'A,,B' } })).toThrow(
      /empty list item/,
    );
  });
});
