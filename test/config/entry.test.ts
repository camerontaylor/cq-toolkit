// C3a: entry helpers and the readers that now take a CqEnv snapshot.
import { describe, expect, test } from 'vitest';
import { assertCqEnv, checkEntryEnv, CqEnvError, enterWithCqEnv } from '../../src/config/entry.js';
import { readCqEnv } from '../../src/config/env.js';
import { resolveSandboxConfig } from '../../src/sandbox/config.js';
import { harnessRunGate } from '../../src/sandbox/index.js';
import { resolveSelfhostDrivers } from '../../src/selfhost/config.js';
import { resolveGhBin } from '../../src/adapters/forge-github/ghBin.js';

describe('entry helpers', () => {
  test('checkEntryEnv renders errors and warnings separately', () => {
    const check = checkEntryEnv({ CQ_SANDBOX: 'of', CQ_RUN_TOOL: 'maybe', CQ_SANBOX: 'off' });
    expect(check.errorLines).toHaveLength(2);
    expect(check.warningLines).toHaveLength(1);
    expect(check.warningLines[0]).toContain('CQ_SANDBOX');
  });

  test('enterWithCqEnv prints warnings once and returns the snapshot', () => {
    const lines: string[] = [];
    const cqEnv = enterWithCqEnv((text) => lines.push(text), { CQ_SANBOX: 'off' });
    expect(cqEnv).toBeDefined();
    expect(lines).toHaveLength(1);
  });

  test('enterWithCqEnv prints every error and returns undefined', () => {
    const lines: string[] = [];
    const cqEnv = enterWithCqEnv((text) => lines.push(text), {
      CQ_SANDBOX: 'of',
      CQ_RUN_TOOL: 'maybe',
    });
    expect(cqEnv).toBeUndefined();
    expect(lines).toHaveLength(2);
  });

  test('assertCqEnv throws one CqEnvError naming every bad key', () => {
    const cqEnv = readCqEnv({ CQ_SANDBOX: 'of', CQ_RUN_TOOL: 'maybe' });
    expect(() => assertCqEnv(cqEnv, 'x')).toThrow(CqEnvError);
    expect(() => assertCqEnv(cqEnv, 'x')).toThrow(/CQ_RUN_TOOL.*CQ_SANDBOX/);
  });
});

describe('readers take the snapshot', () => {
  test('sandbox: a misspelled name leaves the mode required', () => {
    const cqEnv = readCqEnv({ CQ_SANBOX: 'off' });
    expect(resolveSandboxConfig({ cqEnv }).mode).toBe('required');
  });

  test('sandbox: snapshot values form the env layer; optIn still wins', () => {
    const cqEnv = readCqEnv({ CQ_SANDBOX: 'off', CQ_SANDBOX_NETWORK: 'allow' });
    expect(resolveSandboxConfig({ cqEnv }).mode).toBe('off');
    expect(resolveSandboxConfig({ cqEnv }).network).toBe('allow');
    expect(resolveSandboxConfig({ cqEnv, optIn: { sandbox: 'required' } }).mode).toBe('required');
  });

  test('harnessRunGate reads policy from the snapshot', () => {
    expect(harnessRunGate({ cqEnv: readCqEnv({}) }).enabled).toBe(true);
    expect(harnessRunGate({ cqEnv: readCqEnv({ CQ_SANDBOX: 'required' }) }).enabled).toBe(false);
  });

  test('selfhost drivers come from the snapshot', () => {
    const cqEnv = readCqEnv({ CQ_SELFHOST_DRIVER: 'zai/glm-5' });
    expect(resolveSelfhostDrivers(cqEnv).offPeak).toEqual({ provider: 'zai', model: 'glm-5' });
    expect(resolveSelfhostDrivers(readCqEnv({})).offPeak).toEqual(
      resolveSelfhostDrivers({}).offPeak,
    );
  });

  test('CQ_GH_BIN comes from the snapshot, defaulting to gh', () => {
    expect(resolveGhBin(readCqEnv({ CQ_GH_BIN: '/opt/fake-gh' }))).toBe('/opt/fake-gh');
    expect(resolveGhBin(readCqEnv({}))).toBe('gh');
  });
});
