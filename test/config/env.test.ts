import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CqConfigSchema } from '../../src/ops/analyze/cqConfig.js';
import {
  CQ_ENV_ENTRIES,
  FOREIGN_ENV_ENTRIES,
  type CqEnvRegistry,
} from '../../src/config/env-registry.js';
import { formatCqEnvDiagnostics, readCqEnv } from '../../src/config/env.js';
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

  test('parser diagnostics strip scheme-less credentials', () => {
    const result = readCqEnv({ CQ_SANDBOX: 'user:ParserCanary@host' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('CQ_SANDBOX');
    expect(result.errors[0]?.message).not.toContain('ParserCanary');
    expect(result.errors[0]?.message).not.toContain('user:');
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

  test('a registry entry with status denied is an error, not a live value', () => {
    const registry: CqEnvRegistry = {
      entries: [
        {
          name: 'CQ_X',
          kind: 'config',
          parse: (raw) => raw,
          secret: false,
          blank: 'conservative',
          trust: false,
          status: 'denied',
          description: 'never from env',
        },
      ],
      denied: [],
    };
    const result = readCqEnv({ CQ_X: 'value' }, registry);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('not accepted');
    expect(result.values['CQ_X']).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test('a blank denied-prefix name is still an error (the denial is a name rule)', () => {
    expect(readCqEnv({ CQ_APPROVAL_KEY: '' }).errors).toHaveLength(1);
    expect(readCqEnv({ CQ_APPROVAL_KEY_X: '   ' }).errors).toHaveLength(1);
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

describe('value parsers match the runtime', () => {
  test('posture: valid, invalid with the runtime prefix, and padded values', () => {
    expect(
      readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'advisory' }).values['CQ_MERGE_PROTECTED_PATHS'],
    ).toBe('advisory');
    const bad = readCqEnv({ CQ_MERGE_PROTECTED_PATHS: 'loose' });
    expect(bad.errors[0]?.message).toContain(
      "policy: CQ_MERGE_PROTECTED_PATHS must be 'human', 'diff-check' or 'advisory', got 'loose'",
    );
    // Runtime compares the raw value, so a padded posture is an error there too.
    expect(readCqEnv({ CQ_MERGE_PROTECTED_PATHS: ' human ' }).errors).toHaveLength(1);
  });

  test('trust lists: trimmed entries, case-insensitive states, invalid entries', () => {
    const ok = readCqEnv({
      CQ_MERGE_TRUSTED_BOTS: ' coderabbitai[bot] , other ,',
      CQ_MERGE_ACCEPT_REVIEW_STATES: 'approved, COMMENTED',
      CQ_MERGE_TRUSTED_ASSOCIATIONS: ' owner ',
    });
    expect(ok.errors).toEqual([]);
    expect(ok.values['CQ_MERGE_TRUSTED_BOTS']).toEqual(['coderabbitai[bot]', 'other']);
    const bad = readCqEnv({
      CQ_MERGE_TRUSTED_BOTS: 'ok,not a login',
      CQ_MERGE_ACCEPT_REVIEW_STATES: 'REJECTED',
      CQ_MERGE_TRUSTED_ASSOCIATIONS: 'STRANGER',
    });
    expect(bad.errors).toHaveLength(3);
    expect(bad.errors.map((e) => e.message).join('\n')).toContain(
      'CQ_MERGE_ACCEPT_REVIEW_STATES: unrecognised entry "REJECTED" (expected APPROVED or COMMENTED; comma-separated)',
    );
  });

  test('epoch-ms: valid, padded, invalid with the runtime prefix', () => {
    expect(readCqEnv({ CQ_SELFHOST_NOW_MS: ' 1700000000000 ' }).values['CQ_SELFHOST_NOW_MS']).toBe(
      1700000000000,
    );
    for (const raw of ['-1', '1.5', 'abc', '9007199254740993']) {
      const result = readCqEnv({ CQ_SELFHOST_NOW_MS: raw });
      expect(result.errors[0]?.message).toContain(
        'selfhost-review-loop: CQ_SELFHOST_NOW_MS must be a non-negative safe integer epoch-ms',
      );
    }
  });

  test('passthrough accepts commas and whitespace like the runtime', () => {
    const result = readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: ' A B,C\tD\n' });
    expect(result.errors).toEqual([]);
    expect(result.values['CQ_RUN_ENV_PASSTHROUGH']).toEqual(['A', 'B', 'C', 'D']);
    expect(readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: 'A 1bad' }).errors).toHaveLength(1);
    expect(readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: 'CQ_SANDBOX' }).errors).toHaveLength(1);
  });

  test('model-spec drivers: padded and invalid', () => {
    expect(readCqEnv({ CQ_SELFHOST_DRIVER: 'zai/glm' }).values['CQ_SELFHOST_DRIVER']).toEqual({
      provider: 'zai',
      model: 'glm',
    });
    expect(readCqEnv({ CQ_SELFHOST_DRIVER: 'zai' }).errors).toHaveLength(1);
  });
});

describe('registry invariants', () => {
  // Denied prefix and non-env constants that look like env names.
  const ALLOWLIST = new Set(['CQ_APPROVAL_KEY', 'CQ_CONFIG_FILE']);
  const root = join(import.meta.dirname, '..', '..');
  const REGISTRY_FILE = join(root, 'src', 'config', 'env-registry.ts');

  function literals(dirs: readonly string[], exclude: readonly string[]): Set<string> {
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (dirent.name !== 'node_modules' && dirent.name !== 'fixtures') walk(full);
        } else if (/\.(ts|mjs)$/.test(dirent.name) && !exclude.includes(full)) {
          for (const m of readFileSync(full, 'utf8').matchAll(/['"`](CQ_[A-Z0-9_]+)['"`]/g)) {
            if (m[1] !== undefined) found.add(m[1]);
          }
        }
      }
    };
    for (const d of dirs) walk(join(root, d));
    return found;
  }

  /** Names read in `found` but not registered, and registered names no reader mentions. */
  function diffRegistry(
    found: ReadonlySet<string>,
    registered: ReadonlySet<string>,
  ): { unregistered: string[]; unread: string[] } {
    return {
      unregistered: [...found].filter((n) => !registered.has(n) && !ALLOWLIST.has(n)),
      unread: [...registered].filter((n) => !found.has(n)),
    };
  }

  test('the registry matches the CQ_ names the code reads, in both directions', () => {
    const registered = new Set(CQ_ENV_ENTRIES.map((e) => e.name));
    // Forward: every literal in src (the registry file itself excluded) is registered.
    const inSrc = literals(['src'], [REGISTRY_FILE]);
    expect(diffRegistry(inSrc, registered).unregistered).toEqual([]);
    // Reverse: every registered name has a real reader in src, scripts or test; the
    // registry file does not count as its own reader.
    const readers = literals(['src', 'scripts', 'test'], [REGISTRY_FILE]);
    expect(diffRegistry(readers, registered).unread).toEqual([]);
    for (const e of CQ_ENV_ENTRIES) expect(e.name).toMatch(/^CQ_[A-Z0-9_]+$/);
  });

  test('the completeness check fails when a name is missing or unread (mutation check)', () => {
    const registered = new Set(CQ_ENV_ENTRIES.map((e) => e.name));
    const readers = literals(['src', 'scripts', 'test'], [REGISTRY_FILE]);
    const withoutReader = new Set(readers);
    withoutReader.delete('CQ_GH_BIN');
    expect(diffRegistry(withoutReader, registered).unread).toEqual(['CQ_GH_BIN']);
    const withoutEntry = new Set(registered);
    withoutEntry.delete('CQ_GH_BIN');
    expect(diffRegistry(readers, withoutEntry).unregistered).toContain('CQ_GH_BIN');
    expect(diffRegistry(new Set([...readers, 'CQ_NEW_KNOB']), registered).unregistered).toContain(
      'CQ_NEW_KNOB',
    );
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
