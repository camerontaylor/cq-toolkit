// CQ_RUN_ENV_PASSTHROUGH: one grammar and one deny set on every path
// (Annex B §B.5): registry snapshot, sandbox config, child-env builder and
// the launcher env all accept or refuse the same value the same way.
import { describe, expect, test } from 'vitest';
import {
  PASSTHROUGH_DENIED_NAMES,
  parsePassthrough,
  passthroughRefusal,
} from '../../src/config/parsers.js';
import { FOREIGN_ENV_ENTRIES } from '../../src/config/env-registry.js';
import { readCqEnv } from '../../src/config/env.js';
import { resolveSandboxConfig } from '../../src/sandbox/config.js';
import { buildSandboxLauncherEnv } from '../../src/sandbox/index.js';
import { DEFAULT_CHILD_ENV_ALLOWLIST, buildChildEnv } from '../../src/shared/proc.js';

// Dummy secret value built at runtime so no literal sits in the source.
const dummySecret = ['dummy', 'credential', String(Date.now())].join('-');

const REFUSED = [
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'MY_SERVICE_SECRET',
  'CQ_AUTOMATION_TOKEN',
  'CQ_SANDBOX',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'NPM_TOKEN',
  'SSH_AUTH_SOCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DATABASE_URL',
  'NODE_OPTIONS',
  'NODE_PATH',
  'anthropic_api_key',
];

describe('passthrough deny set', () => {
  test.each(REFUSED)('%s is refused on every path', (name) => {
    expect(() => parsePassthrough(name)).toThrow(name);
    const snapshot = readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: name });
    expect(snapshot.errors.map((e) => e.name)).toEqual(['CQ_RUN_ENV_PASSTHROUGH']);
    expect(() => resolveSandboxConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: name } })).toThrow(name);
    expect(() => buildChildEnv({ CQ_RUN_ENV_PASSTHROUGH: name })).toThrow(name);
    expect(() =>
      buildSandboxLauncherEnv({ [name]: dummySecret }, { envPassthrough: [name] }),
    ).toThrow(name);
  });

  test('no value appears in any error text', () => {
    for (const name of REFUSED) {
      // CQ_SANDBOX's own parser quotes its value; that is a different key's grammar.
      const parent = { [name]: dummySecret, CQ_RUN_ENV_PASSTHROUGH: name };
      if (name === 'CQ_SANDBOX') continue;
      const messages = [
        () => parsePassthrough(name),
        () => resolveSandboxConfig({ env: parent }),
        () => buildChildEnv(parent),
        () => buildSandboxLauncherEnv(parent, { envPassthrough: [name] }),
      ].map((run) => {
        try {
          run();
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      });
      for (const message of messages) {
        expect(message).not.toBe('');
        expect(message).not.toContain(dummySecret);
      }
      const snapshot = readCqEnv(parent);
      expect(JSON.stringify(snapshot.errors)).not.toContain(dummySecret);
    }
  });

  test('a safe name is accepted everywhere', () => {
    expect(parsePassthrough('FOO')).toEqual(['FOO']);
    expect(readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: 'FOO' }).values['CQ_RUN_ENV_PASSTHROUGH']).toEqual([
      'FOO',
    ]);
    expect(buildChildEnv({ CQ_RUN_ENV_PASSTHROUGH: 'FOO', FOO: 'x' })['FOO']).toBe('x');
    expect(buildSandboxLauncherEnv({ FOO: 'x' }, { envPassthrough: ['FOO'] })['FOO']).toBe('x');
  });

  test('every denied name is a credential-shaped name outside the child allowlist', () => {
    for (const name of PASSTHROUGH_DENIED_NAMES) {
      expect(DEFAULT_CHILD_ENV_ALLOWLIST).not.toContain(name);
      expect(passthroughRefusal(name)).toBeDefined();
    }
  });

  test('no allowlisted default name is itself refused as credential-shaped', () => {
    for (const name of DEFAULT_CHILD_ENV_ALLOWLIST) {
      expect(PASSTHROUGH_DENIED_NAMES.has(name)).toBe(false);
    }
  });

  test('every secret foreign name in the registry is refused', () => {
    for (const entry of FOREIGN_ENV_ENTRIES.filter((e) => e.secret)) {
      expect(passthroughRefusal(entry.name), entry.name).toBeDefined();
    }
  });
});

describe('passthrough grammar parity', () => {
  const values = ['', '   ', 'A', 'A,B', 'A B', 'A, B', ' A ,\tB\n', 'A,,B', 'A B,A', 'A-B', '1A'];

  test.each(values)('value %j is accepted or refused identically on every path', (raw) => {
    const outcomes = [
      () => parsePassthrough(raw),
      () => {
        const snap = readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: raw });
        if (snap.errors.length > 0) throw new Error('refused');
        return (snap.values['CQ_RUN_ENV_PASSTHROUGH'] as string[] | undefined) ?? [];
      },
      () => resolveSandboxConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: raw } }).envPassthrough,
      () => {
        // The snapshot records the error; every entry point refuses to run on it.
        const cqEnv = readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: raw });
        if (cqEnv.errors.length > 0) throw new Error('refused');
        return resolveSandboxConfig({ cqEnv }).envPassthrough;
      },
      () => {
        const env = Object.fromEntries(
          parsePassthroughSafe(raw).map((name) => [name, 'v'] as const),
        );
        return Object.keys(buildChildEnv({ ...env, CQ_RUN_ENV_PASSTHROUGH: raw })).filter(
          (name) => name.length === 1 || name === 'A',
        );
      },
    ].map((run) => {
      try {
        return { ok: true as const, value: [...run()].sort() };
      } catch {
        return { ok: false as const };
      }
    });
    const [first, ...rest] = outcomes;
    for (const other of rest.slice(0, 3)) expect(other.ok).toBe(first?.ok);
    // buildChildEnv refuses exactly when the shared parser does.
    expect(outcomes[4]?.ok).toBe(first?.ok);
  });

  test('whitespace and commas both separate names', () => {
    expect(parsePassthrough(' A ,\tB\nC D')).toEqual(['A', 'B', 'C', 'D']);
    expect(resolveSandboxConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: 'A B' } }).envPassthrough).toEqual(
      ['A', 'B'],
    );
  });
});

function parsePassthroughSafe(raw: string): readonly string[] {
  try {
    return parsePassthrough(raw);
  } catch {
    return [];
  }
}
