import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.js';

describe('pure configuration resolution', () => {
  it('uses built-ins for unset, empty, and whitespace values', () => {
    for (const value of [undefined, '', '  \t']) {
      const config = resolveConfig({ env: { CQ_SANDBOX: value } });
      expect(config.entries.sandbox).toMatchObject({ value: 'required', layer: 'default' });
    }
  });

  it('seeds project env from the bundled profile, then explicit env wins', () => {
    expect(resolveConfig({ env: { CQ_PROFILE: 'solo-maintainer' } }).entries.sandbox)
      .toMatchObject({ value: 'off', layer: 'profile' });
    expect(resolveConfig({ env: { CQ_PROFILE: 'solo-maintainer', CQ_SANDBOX: 'required' } }).entries.sandbox)
      .toMatchObject({ value: 'required', layer: 'env' });
  });

  it('rejects unknown CQ variables and invalid profile values', () => {
    expect(() => resolveConfig({ env: { CQ_SANDBOX_NETWROK: 'allow' } })).toThrow(/unknown configuration variable/);
    expect(() => resolveConfig({ env: { CQ_PROFILE: 'custom' } })).toThrow(/unsupported profile/);
  });

  it('allows tightening without opt-in and requires a named key for relaxation', () => {
    expect(resolveConfig({ values: { sandbox: 'required' } }).entries.sandbox.value).toBe('required');
    expect(() => resolveConfig({ values: { sandbox: 'off' } })).toThrow(/explicit opt-in/);
    expect(resolveConfig({ values: { sandbox: 'off' }, optIn: ['sandbox'] }).entries.sandbox.value).toBe('off');
  });

  it('treats blank as layer empty and the literal none as an explicit empty list', () => {
    expect(resolveConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: ' ' } }).entries['run.envPassthrough'].value).toEqual([]);
    expect(resolveConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: 'none' } }).entries['run.envPassthrough'].value).toEqual([]);
    expect(() => resolveConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: 'A,,B' } })).toThrow(/empty list item/);
  });
});
