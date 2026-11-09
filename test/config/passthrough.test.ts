// CQ_RUN_ENV_PASSTHROUGH: one grammar and one deny set on every path
// (Annex B §B.5): registry snapshot, sandbox config, child-env builder and
// the launcher env all accept or refuse the same value the same way.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PASSTHROUGH_DENIED_NAMES,
  parsePassthrough,
  passthroughRefusal,
} from '../../src/config/parsers.js';
import { CQ_ENV_ENTRIES, FOREIGN_ENV_ENTRIES } from '../../src/config/env-registry.js';
import { readCqEnv } from '../../src/config/env.js';
import { provenanceConfig } from '../../src/config/provenance.js';
import { scrubEnvironment } from '../../src/harness/mcp/startup.js';
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
  'CQ_WORK_ID',
  'cq_work_id',
  'CQ_MERGE_PROTECTED_BRANCH',
  'CQ_NOT_A_REAL_NAME',
  'CQ_SANDBOX',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'NPM_TOKEN',
  'SSH_AUTH_SOCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
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
      expect(PASSTHROUGH_DENIED_NAMES.includes(name)).toBe(false);
    }
  });

  test('every registry CQ_* name and an unknown CQ_* name are refused, naming the variable only', () => {
    for (const name of [...CQ_ENV_ENTRIES.map((e) => e.name), 'CQ_UNKNOWN_TO_THE_REGISTRY']) {
      expect(() => parsePassthrough(name), name).toThrow(name);
      const parent = { [name]: dummySecret, CQ_RUN_ENV_PASSTHROUGH: name };
      if (name === 'CQ_SANDBOX') continue; // that key's own parser quotes its value
      const snapshot = readCqEnv(parent);
      const passthroughErrors = snapshot.errors.filter((e) => e.name === 'CQ_RUN_ENV_PASSTHROUGH');
      expect(passthroughErrors, name).toHaveLength(1);
      expect(passthroughErrors[0]?.message).toContain(name);
      expect(JSON.stringify(passthroughErrors)).not.toContain(dummySecret);
      expect(() => buildChildEnv(parent)).toThrow(name);
      expect(() => buildSandboxLauncherEnv(parent, { envPassthrough: [name] })).toThrow(name);
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

describe('no part of a raw value is echoed', () => {
  const secret = ['sk', 'live', 'TOPSECRET', String(Date.now())].join('-');
  const long = `FOO=${secret}${'x'.repeat(5000)}`;
  const shapes = [
    `FOO=${secret}`,
    `ANTHROPIC_API_KEY=${secret}`,
    `FOO=${secret},BAR`,
    `"${secret}"`,
    `'FOO=${secret}'`,
    `GOOD ${secret}=1 OTHER`,
    `FOO\t${secret}/bad`,
    `${secret};rm`,
    long,
  ];
  const messageOf = (run: () => unknown): string => {
    try {
      run();
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  };

  test.each(shapes)('value shape %#', (raw) => {
    const messages = [
      messageOf(() => parsePassthrough(raw)),
      messageOf(() => buildChildEnv({ CQ_RUN_ENV_PASSTHROUGH: raw })),
      messageOf(() => resolveSandboxConfig({ env: { CQ_RUN_ENV_PASSTHROUGH: raw } })),
      JSON.stringify(readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: raw }).errors),
      readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: raw })
        .errors.map((e) => e.message)
        .join('\n'),
    ];
    for (const message of messages) {
      expect(message).not.toBe('[]');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('TOPSECRET');
      expect(message.length).toBeLessThan(600);
    }
  });

  test('a malformed entry is reported by position', () => {
    expect(() => parsePassthrough(`GOOD FOO=${secret}`)).toThrow(/entry 2 is not an env var name/);
  });

  test('provenance records only valid names for the passthrough key', () => {
    const cqEnv = readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: 'FOO BAR' });
    const recorded = JSON.stringify(provenanceConfig(cqEnv));
    expect(recorded).toContain('FOO');
    const bad = readCqEnv({ CQ_RUN_ENV_PASSTHROUGH: `FOO=${secret}` });
    expect(bad.errors).toHaveLength(1);
    // Provenance refuses an env with errors, and its message carries no raw text.
    let message = '';
    try {
      provenanceConfig(bad);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(secret);
  });
});

describe('manifest-declared names get the credential refusal', () => {
  const declared = ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'MY_SERVICE_SECRET', 'AWS_REGION'];

  test.each(declared)('buildSandboxLauncherEnv refuses declared %s', (name) => {
    const parent = { [name]: dummySecret, PATH: '/bin' };
    const message = messageFrom(() =>
      buildSandboxLauncherEnv(parent, { envPassthrough: [], declaredEnvNames: [name] }),
    );
    expect(message).toContain(name);
    expect(message).not.toContain(dummySecret);
  });

  test.each(['CQ_SANDBOX', 'CQ_RUN_TOOL'])('declared policy knob %s is refused', (name) => {
    expect(() =>
      buildSandboxLauncherEnv({ [name]: 'x' }, { envPassthrough: [], declaredEnvNames: [name] }),
    ).toThrow(name);
  });

  test('a declared non-credential, non-CQ_ name still works', () => {
    expect(
      buildSandboxLauncherEnv(
        { TEST_KEEP_CANARY: 'kept', PATH: '/bin' },
        { envPassthrough: [], declaredEnvNames: ['TEST_KEEP_CANARY'] },
      ),
    ).toEqual({ PATH: '/bin', TEST_KEEP_CANARY: 'kept' });
  });

  test.each(declared)('scrubEnvironment (the MCP startup path) refuses %s', (name) => {
    const prior = { ...process.env };
    try {
      process.env[name] = dummySecret;
      const message = messageFrom(() => scrubEnvironment([name]));
      expect(message).toContain(name);
      expect(message).not.toContain(dummySecret);
      expect(process.env[name]).toBe(dummySecret); // refused before the env was replaced
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, prior);
    }
  });
});

describe('one parser for the passthrough env', () => {
  test('src contains no second split of CQ_RUN_ENV_PASSTHROUGH', () => {
    const root = join(import.meta.dirname, '..', '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          if (/CQ_RUN_ENV_PASSTHROUGH[^\n]*\.split\(|\.split\(\/\[,\\s\]\+\//.test(text)) {
            offenders.push(full);
          }
        }
      }
    };
    walk(root);
    expect(offenders.map((f) => f.replace(root, ''))).toEqual(['/config/parsers.ts']);
  });
});

function messageFrom(run: () => unknown): string {
  try {
    run();
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}
