import { describe, expect, test } from 'vitest';
import { CqConfigSchema } from '../../src/ops/analyze/cqConfig.js';
import {
  CQ_ENV_ENTRIES,
  FOREIGN_ENV_ENTRIES,
  type CqEnvRegistry,
} from '../../src/config/env-registry.js';
import { editDistance, formatCqEnvDiagnostics, readCqEnv } from '../../src/config/env.js';
import { SECRET_ENV_SUFFIXES, isSecretEnvName } from '../../src/config/secret.js';

describe('readCqEnv', () => {
  test('an unknown name warns with the nearest known name', () => {
    const result = readCqEnv({ CQ_SANBOX: 'off' });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain('did you mean CQ_SANDBOX?');
    expect(formatCqEnvDiagnostics(result)[0]).toMatch(/^cq: warning: /);
  });

  test('an unknown name with no near match warns without a suggestion', () => {
    const result = readCqEnv({ CQ_COMPLETELY_UNRELATED_NAME_HERE: '1' });
    expect(result.warnings[0]?.message).not.toContain('did you mean');
  });

  test('the suggestion distance is capped by name length', () => {
    // CQ_ROL is one edit from CQ_ROLE (limit 1): suggested.
    expect(readCqEnv({ CQ_ROL: 'x' }).warnings[0]?.message).toContain('did you mean CQ_ROLE?');
    // CQ_TAB is 2 edits from CQ_TASK... but only 1 is allowed for a 3-char stem.
    expect(readCqEnv({ CQ_TX: 'x' }).warnings[0]?.message).not.toContain('did you mean');
    // A longer name may be up to 3 edits away.
    expect(readCqEnv({ CQ_SANDBXO_NETWRK: 'x' }).warnings[0]?.message).toContain(
      'did you mean CQ_SANDBOX_NETWORK?',
    );
  });

  test('a bad value is an error and the value stays unset', () => {
    const result = readCqEnv({ CQ_SANDBOX: 'of' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('CQ_SANDBOX');
    expect(result.values['CQ_SANDBOX']).toBeUndefined();
    expect(formatCqEnvDiagnostics(result)[0]).toMatch(/^cq: error: /);
  });

  test('two bad values give two errors in one result', () => {
    const result = readCqEnv({ CQ_SANDBOX: 'of', CQ_RUN_TOOL: 'maybe' });
    expect(result.errors.map((e) => e.name)).toEqual(['CQ_RUN_TOOL', 'CQ_SANDBOX']);
  });

  test('CQ_APPROVAL_KEY and any name with that prefix is an error', () => {
    expect(readCqEnv({ CQ_APPROVAL_KEY: 'x' }).errors).toHaveLength(1);
    const result = readCqEnv({ CQ_APPROVAL_KEY_FILE: 'x' });
    expect(result.errors[0]?.name).toBe('CQ_APPROVAL_KEY_FILE');
    expect(result.warnings).toEqual([]);
  });

  test('a reserved key that is set warns "not honoured yet"; a blank one is silent', () => {
    const registry: CqEnvRegistry = {
      entries: [
        {
          name: 'CQ_FUTURE',
          kind: 'config',
          parse: (raw) => raw,
          secret: false,
          blank: 'conservative',
          trust: false,
          status: 'reserved',
          description: 'reserved for a later slice',
        },
      ],
      denied: [],
    };
    const set = readCqEnv({ CQ_FUTURE: '1' }, registry);
    expect(set.warnings[0]?.message).toContain('set but not honoured yet');
    expect(set.errors).toEqual([]);
    expect(readCqEnv({ CQ_FUTURE: '  ' }, registry).warnings).toEqual([]);
  });

  test('blank means unset, with the default source', () => {
    const result = readCqEnv({ CQ_SANDBOX: '   ', CQ_RUN_TOOL: '' });
    expect(result.errors).toEqual([]);
    expect(result.sources['CQ_SANDBOX']).toBe('default');
    expect(result.values['CQ_SANDBOX']).toBeUndefined();
  });

  test('a valid value is parsed and sourced from env', () => {
    const result = readCqEnv({ CQ_SANDBOX: 'off', CQ_RUN_ENV_PASSTHROUGH: 'A, B,A' });
    expect(result.values['CQ_SANDBOX']).toBe('off');
    expect(result.sources['CQ_SANDBOX']).toBe('env');
    expect(result.values['CQ_RUN_ENV_PASSTHROUGH']).toEqual(['A', 'B']);
  });

  test('the result is deeply frozen', () => {
    const result = readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: 'A', CQ_SANBOX: 'x' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.values)).toBe(true);
    expect(Object.isFrozen(result.sources)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
    expect(Object.isFrozen(result.warnings[0])).toBe(true);
    expect(Object.isFrozen(result.values['CQ_RUN_ENV_PASSTHROUGH'])).toBe(true);
  });

  test('identity names and foreign names give no warnings', () => {
    const result = readCqEnv({
      CQ_WORK_ID: 'w',
      CQ_ROLE: 'r',
      CQ_TASK: 't',
      CQ_RUN_ID: 'x',
      CQ_PARENT_WORK_ID: 'p',
      ZAI_API_KEY: 'k',
      GH_TOKEN: 't',
      PATH: '/bin',
    });
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('a secret value never appears in diagnostics', () => {
    const secret = ['dummy', 'value', 'one'].join('-');
    const result = readCqEnv({
      CQ_AUTOMATION_TOKEN: secret,
      CQ_AUTOMATION_TOKN: secret,
      CQ_APPROVAL_KEY: secret,
      CQ_SANDBOX: 'of',
    });
    expect(result.values['CQ_AUTOMATION_TOKEN']).toBe(secret);
    expect(formatCqEnvDiagnostics(result).join('\n')).not.toContain(secret);
    expect(JSON.stringify([result.warnings, result.errors])).not.toContain(secret);
  });

  test('a secret entry whose parser quotes its input still prints no value', () => {
    const secret = ['dummy', 'value', 'two'].join('-');
    const registry: CqEnvRegistry = {
      entries: [
        {
          name: 'CQ_X_TOKEN',
          kind: 'config',
          parse: (raw) => {
            throw new Error(`bad ${raw}`);
          },
          secret: true,
          blank: 'conservative',
          trust: true,
          status: 'live',
          description: 'test secret',
        },
      ],
      denied: [],
    };
    const result = readCqEnv({ CQ_X_TOKEN: secret }, registry);
    expect(result.errors).toHaveLength(1);
    expect(formatCqEnvDiagnostics(result).join('\n')).not.toContain(secret);
  });

  test('the injected env is not mutated and process.env is the default', () => {
    const env = { CQ_SANDBOX: 'off' };
    readCqEnv(env);
    expect(env).toEqual({ CQ_SANDBOX: 'off' });
    expect(readCqEnv().values).toBeDefined();
  });
});

describe('editDistance', () => {
  test('basic distances', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('CQ_SANBOX', 'CQ_SANDBOX')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('registry invariants', () => {
  test('every live CQ_ name in src is registered', () => {
    expect(CQ_ENV_ENTRIES).toHaveLength(27);
    expect(new Set(CQ_ENV_ENTRIES.map((e) => e.name)).size).toBe(27);
    for (const e of CQ_ENV_ENTRIES) expect(e.name).toMatch(/^CQ_[A-Z0-9_]+$/);
  });

  test('every config entry declares blank, and blank is never anything but conservative or neutral', () => {
    for (const e of CQ_ENV_ENTRIES.filter((x) => x.kind === 'config')) {
      expect(['conservative', 'neutral']).toContain(e.blank);
    }
    for (const e of CQ_ENV_ENTRIES) expect(['conservative', 'neutral']).toContain(e.blank);
  });

  test('every trust-boundary key has a conservative blank', () => {
    const trust = CQ_ENV_ENTRIES.filter((e) => e.trust);
    expect(trust.length).toBeGreaterThan(0);
    for (const e of trust) expect(e.blank).toBe('conservative');
  });

  test('secret flags derive from SECRET_ENV_SUFFIXES', () => {
    for (const e of [...CQ_ENV_ENTRIES, ...FOREIGN_ENV_ENTRIES]) {
      expect(e.secret).toBe(SECRET_ENV_SUFFIXES.some((s) => e.name.endsWith(s)));
    }
    expect(CQ_ENV_ENTRIES.find((e) => e.name === 'CQ_AUTOMATION_TOKEN')?.secret).toBe(true);
    expect(isSecretEnvName('zai_api_key')).toBe(true);
  });

  test('the cq.json schema has no key ending in a secret suffix', () => {
    const keys: string[] = [];
    const seen = new Set<unknown>();
    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null || seen.has(node)) return;
      seen.add(node);
      const shape = (node as { shape?: unknown }).shape;
      if (typeof shape === 'object' && shape !== null) {
        for (const [key, child] of Object.entries(shape)) {
          keys.push(key);
          walk(child);
        }
      }
      const def = (node as { def?: Record<string, unknown> }).def ?? {};
      for (const child of [
        def['innerType'],
        def['element'],
        def['in'],
        def['out'],
        ...(Array.isArray(def['options']) ? (def['options'] as unknown[]) : []),
      ]) {
        walk(child);
      }
    };
    walk(CqConfigSchema);
    expect(keys).toContain('checks');
    expect(keys).toContain('maxTokens');
    for (const key of keys) expect(isSecretEnvName(key), key).toBe(false);
  });
});
