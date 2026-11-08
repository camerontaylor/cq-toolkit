// `_URL` is not a secret suffix (owner ruling 2026-10-11, re-confirmed 2026-11-09):
// URL values are shown with userinfo, query and fragment stripped by ONE shared
// redactor; a credential-bearing URL is refused in passthrough.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isSecretEnvName } from '../../src/config/secret.js';
import { readCqEnv } from '../../src/config/env.js';
import { provenanceConfig } from '../../src/config/provenance.js';
import { parsePassthrough, urlValueRefusal } from '../../src/config/parsers.js';
import { buildConfigShowReport } from '../../src/ops/config/show.js';
import { boundedErrorText } from '../../src/driver/error-text.js';
import { buildSandboxLauncherEnv } from '../../src/sandbox/index.js';
import { buildChildEnv } from '../../src/shared/proc.js';
import {
  redactIfUrl,
  stripCredentialText,
  urlValueHasUserinfo,
} from '../../src/shared/urlRedact.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// Dummy credentials are built at runtime so no literal trips the denylist.
const tok = ['tok', 'live', String(Date.now())].join('-');
const withCreds = `https://user:${tok}@api.example.test`;

describe('_URL is not a secret suffix', () => {
  test.each(['ANTHROPIC_BASE_URL', 'ZAI_BASE_URL', 'OPENCODE_GO_BASE_URL', 'DATABASE_URL'])(
    '%s is not secret-classed',
    (name) => {
      expect(isSecretEnvName(name)).toBe(false);
    },
  );
  test('real secret suffixes still are', () => {
    for (const name of ['X_API_KEY', 'X_TOKEN', 'X_SECRET', 'X_PASSWORD', 'X_CREDENTIALS']) {
      expect(isSecretEnvName(name)).toBe(true);
    }
  });
});

describe('the shared redactor', () => {
  test.each([
    [withCreds, 'https://api.example.test'],
    [`https://api.example.test/v1?token=${tok}`, 'https://api.example.test/v1'],
    [`https://api.example.test/v1#${tok}`, 'https://api.example.test/v1'],
    [`https://u:p@api.example.test/v1?x=1#f`, 'https://api.example.test/v1'],
    [`https://a@b@api.example.test/v1`, 'https://api.example.test/v1'],
    [`https://us%40er:p@api.example.test/v1`, 'https://api.example.test/v1'],
    [`https://user:${tok}@[2001:db8::1]:8443/p`, 'https://[2001:db8::1]:8443/p'],
    ['https://api.example.test/clean', 'https://api.example.test/clean'],
  ])('%s -> %s', (input, expected) => {
    const out = stripCredentialText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(tok);
  });

  test('a scheme-less user:pass@host never survives', () => {
    expect(stripCredentialText(`user:${tok}@host.example`)).not.toContain(tok);
  });

  test('very long and many-@ inputs are linear (no catastrophic backtracking)', () => {
    const long = `https://${'a@'.repeat(50_000)}host/${'x'.repeat(100_000)}?q=${'y'.repeat(100_000)}`;
    const start = Date.now();
    const out = stripCredentialText(long);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(out.startsWith('https://host/')).toBe(true);
    expect(out).not.toContain('?q=');
  });

  test('redactIfUrl applies to a URL-named variable or a scheme value only', () => {
    expect(redactIfUrl('SOME_URL', 'user:pw@host.example')).not.toContain('pw');
    expect(redactIfUrl('CQ_AUTHOR_SSH_ALIAS', 'me@host')).toBe('me@host');
    expect(redactIfUrl('X', withCreds)).toBe('https://api.example.test');
  });
});

describe('credential-bearing URL detection', () => {
  test.each([
    [withCreds, true],
    ['https://user@host.example', true],
    ['https://host.example/path@seg', false],
    ['https://host.example/?email=a@b.c', false],
    ['https://host.example/#a@b', false],
    ['https://[bad', false],
    ['https://u@[bad', true],
    ['//user:pw@host', true],
    ['user:pw@host.example', true],
    ['https://api.example.test', false],
    ['https://us%40er@host', true],
  ])('%s -> %s', (value, expected) => {
    expect(urlValueHasUserinfo(value)).toBe(expected);
  });
});

describe('passthrough of URL variables', () => {
  test('a clean ANTHROPIC_BASE_URL is allowed by name and by value', () => {
    expect(parsePassthrough('ANTHROPIC_BASE_URL')).toEqual(['ANTHROPIC_BASE_URL']);
    const parent = { ANTHROPIC_BASE_URL: 'https://api.example.test/v1' };
    expect(
      buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'ANTHROPIC_BASE_URL' }),
    ).toMatchObject(parent);
    expect(buildSandboxLauncherEnv(parent, { envPassthrough: ['ANTHROPIC_BASE_URL'] })).toEqual(
      parent,
    );
  });

  test('DATABASE_URL is passable by name when its value has no credentials', () => {
    expect(parsePassthrough('DATABASE_URL')).toEqual(['DATABASE_URL']);
  });

  test.each([withCreds, `//u:${tok}@h`, `user:${tok}@host`])(
    'a credential-bearing value (%#) is refused on every path, naming only the variable',
    (value) => {
      const parent = { ANTHROPIC_BASE_URL: value, DATABASE_URL: value };
      for (const name of ['ANTHROPIC_BASE_URL', 'DATABASE_URL']) {
        const messages = [
          () => buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: name }),
          () => buildSandboxLauncherEnv(parent, { envPassthrough: [name] }),
          () => buildSandboxLauncherEnv(parent, { envPassthrough: [], declaredEnvNames: [name] }),
          () => buildSandboxLauncherEnv(parent, { envPassthrough: [], trustedEnvNames: [name] }),
        ].map((run) => {
          try {
            run();
            return '';
          } catch (error) {
            return (error as Error).message;
          }
        });
        for (const message of messages) {
          expect(message).toContain(name);
          expect(message).not.toContain(tok);
          expect(message).not.toContain('user:');
        }
      }
    },
  );

  test('urlValueRefusal ignores non-URL variables and names the variable only', () => {
    expect(urlValueRefusal('GIT_AUTHOR_EMAIL', 'me@example.test')).toBeUndefined();
    const refusal = urlValueRefusal('X_URL', withCreds);
    expect(refusal).toContain('X_URL');
    expect(refusal).not.toContain(tok);
  });
});

describe('display sites show the redacted URL', () => {
  const env = { ANTHROPIC_BASE_URL: withCreds, ZAI_BASE_URL: `https://z.example.test/?k=${tok}` };

  test('cq config report (text and --json share the report) shows https://api.example.test', () => {
    const report = buildConfigShowReport(env);
    const json = JSON.stringify(report);
    expect(json).not.toContain(tok);
    const byName = Object.fromEntries(report.keys.map((k) => [k.name, k.value]));
    expect(byName['ANTHROPIC_BASE_URL']).toBe('https://api.example.test');
    expect(byName['ZAI_BASE_URL']).toBe('https://z.example.test/');
  });

  test('v3 provenance records the redacted value', () => {
    const config = provenanceConfig(readCqEnv(env));
    expect(config.env['ANTHROPIC_BASE_URL']).toBe('https://api.example.test');
    expect(JSON.stringify(config)).not.toContain(tok);
  });

  test('the snapshot never holds the raw URL', () => {
    expect(JSON.stringify(readCqEnv(env))).not.toContain(tok);
  });

  test('persisted error text strips the userinfo of a URL env value', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', withCreds);
    const out = boundedErrorText(`request to ${withCreds}/v1 failed`);
    expect(out).not.toContain(tok);
    expect(out).toContain('https://api.example.test');
  });
});

describe('the cq config CLI', () => {
  test.each([[['config']], [['config', '--json']]])('%j shows the redacted URL', async (argv) => {
    vi.stubEnv('ANTHROPIC_BASE_URL', withCreds);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { stdout: (c) => out.push(c), stderr: (c) => err.push(c) });
    expect(code).toBe(0);
    const all = out.join('') + err.join('');
    expect(all).not.toContain(tok);
    expect(out.join('')).toContain('https://api.example.test');
  });
});

describe('exactly one redactor implementation', () => {
  const root = join(import.meta.dirname, '..', '..', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);
  const rel = (f: string): string => f.slice(root.length);
  const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

  test('stripCredentialText is defined once, in src/shared/urlRedact.ts', () => {
    const defs = files.filter((f) => /function\s+stripCredentialText\b/.test(text.get(f) ?? ''));
    expect(defs.map(rel)).toEqual(['/shared/urlRedact.ts']);
  });

  test('no other file scans an authority for userinfo (`lastIndexOf(@)`)', () => {
    const users = files.filter((f) => /lastIndexOf\('@'/.test(text.get(f) ?? ''));
    expect(users.map(rel)).toEqual(['/shared/urlRedact.ts']);
  });

  test.each([
    '/ops/fix/attemptRecord.ts',
    '/config/provenance.ts',
    '/config/env.ts',
    '/ops/config/show.ts',
    '/driver/error-text.ts',
  ])('%s calls the shared redactor', (file) => {
    const source = text.get(join(root, file)) ?? '';
    expect(source).toMatch(/shared\/urlRedact\.js/);
    expect(source).toMatch(/stripCredentialText|redactIfUrl|cutAuthorityUserinfo/);
  });
});
