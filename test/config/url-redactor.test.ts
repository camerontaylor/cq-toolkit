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
import { boundedErrorText, redactSensitiveText } from '../../src/driver/error-text.js';
import { buildSandboxLauncherEnv } from '../../src/sandbox/index.js';
import { sanitizeObservation } from '../../src/ops/fix/attemptRecord.js';
import { buildChildEnv } from '../../src/shared/proc.js';
import {
  redactIfUrl,
  redactUrlUserinfo,
  showUrl,
  stripCredentialText,
  urlValueRefused,
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

const refusedValues = [
  '',
  ' ',
  '\t\n',
  withCreds,
  'https://user@host.example',
  String.raw`https:\/\/u:${tok}@host/db`,
  `https:/u:${tok}@host/db`,
  `https://clean.example https://u:${tok}@evil.example`,
  `u:${tok}@host https://clean.example`,
  `text //u:${tok}@host`,
  `//clean //u:${tok}@host`,
  `//user:${tok}@host`,
  `user:${tok}@host.example`,
  'https://us%40er@host',
  'https://us%40er:p%40ss@host',
  'https://host/path@seg',
  'https://host/?email=a@b.c',
  'https://host/#a@b',
  'https://host/a%40b',
  'https://host/a%40b'.toUpperCase().replace('HTTPS', 'https'),
  'https://host/a b',
  'https://host\\path',
  'https://[bad',
  'not a url',
  'host.example',
  ' https://u:p@host',
];

describe('the canonical structured display (showUrl)', () => {
  test.each([
    [withCreds, 'https://api.example.test/'],
    [`https://api.example.test/v1?token=${tok}`, 'https://api.example.test/v1'],
    [`https://api.example.test/v1#${tok}`, 'https://api.example.test/v1'],
    [`https://u:p@api.example.test/v1?x=1#f`, 'https://api.example.test/v1'],
    [`https://a@b@api.example.test/v1`, 'https://api.example.test/v1'],
    [`https://us%40er:p@api.example.test/v1`, 'https://api.example.test/v1'],
    [`https://user:${tok}@[2001:db8::1]:8443/p`, 'https://[2001:db8::1]:8443/p'],
    ['https://api.example.test/clean', 'https://api.example.test/clean'],
    ['https://host/path@seg', 'https://host/path@seg'],
    ['https://u:p@host/path@seg', 'https://host/path@seg'],
    [String.raw`https:\/\/host/path?token=` + tok, 'https://host/path'],
    [`https:/host/path?token=${tok}`, 'https://host/path'],
    [
      `postgres://u:${tok}@db.example.test:5432/app?sslmode=x`,
      'postgres://db.example.test:5432/app',
    ],
  ])('%s -> %s', (input, expected) => {
    const out = showUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(tok);
  });

  test.each([
    `user:${tok}@host.example`,
    `not a url ${tok}`,
    `foo:user:${tok}@host`,
    tok,
    'https://',
    '',
  ])('an unparseable or hostless value (%#) is shown as [redacted-url], never raw', (value) => {
    expect(showUrl(value)).toBe('[redacted-url]');
  });

  test('redactIfUrl applies to a URL-named variable or a scheme value only', () => {
    expect(redactIfUrl('SOME_URL', `user:${tok}@host.example`)).toBe('[redacted-url]');
    expect(redactIfUrl('CQ_AUTHOR_SSH_ALIAS', 'me@host')).toBe('me@host');
    expect(redactIfUrl('X', withCreds)).toBe('https://api.example.test/');
  });
});

describe('the attempt-record free-text stripper', () => {
  test.each([
    [withCreds, 'https://api.example.test'],
    [`https://api.example.test/v1?token=${tok}`, 'https://api.example.test/v1'],
  ])('%s -> %s', (input, expected) => {
    expect(stripCredentialText(input)).toBe(expected);
  });

  test('very long and many-@ inputs are linear (no catastrophic backtracking)', () => {
    const long = `https://${'a@'.repeat(50_000)}host/${'x'.repeat(100_000)}?q=${'y'.repeat(100_000)}`;
    const start = Date.now();
    const out = stripCredentialText(long);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(out.startsWith('https://host/')).toBe(true);
    expect(out).not.toContain('?q=');
  });
});

describe('fail-closed URL acceptance for copied values', () => {
  // Every bypass listed in the PR #1269 r1 review, plus the plain forms.
  test.each(refusedValues)('%j is refused for a *_URL variable', (value) => {
    expect(urlValueRefused('DATABASE_URL', value)).toBe(true);
  });

  test.each([
    'https://api.example.test',
    'https://api.example.test/v1?x=1#f',
    'postgres://db:5432/app',
  ])('%j is accepted for a *_URL variable', (value) => {
    expect(urlValueRefused('DATABASE_URL', value)).toBe(false);
  });

  test('a non-URL variable is screened only when its value has a scheme separator', () => {
    expect(urlValueRefused('GIT_AUTHOR_EMAIL', 'me@example.test')).toBe(false);
    expect(urlValueRefused('SOME_REMOTE', `https://u:${tok}@h/x`)).toBe(true);
    expect(urlValueRefused('SOME_REMOTE', 'https://h/x')).toBe(false);
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

  test.each(refusedValues)(
    'a credential-bearing or unacceptable value (%j) is refused on every origin and path, naming only the variable',
    (value) => {
      const parent = { ANTHROPIC_BASE_URL: value, DATABASE_URL: value };
      for (const name of ['ANTHROPIC_BASE_URL', 'DATABASE_URL']) {
        const runs = {
          operatorKey: () => buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: name }),
          envAllowlist: () => buildChildEnv(parent, undefined, [name]),
          launcherOperator: () => buildSandboxLauncherEnv(parent, { envPassthrough: [name] }),
          launcherDeclared: () =>
            buildSandboxLauncherEnv(parent, { envPassthrough: [], declaredEnvNames: [name] }),
          launcherTrusted: () =>
            buildSandboxLauncherEnv(parent, { envPassthrough: [], trustedEnvNames: [name] }),
        };
        for (const [path, run] of Object.entries(runs)) {
          let message = '';
          try {
            run();
          } catch (error) {
            message = (error as Error).message;
          }
          expect(message, `${path} refused ${name}`).toContain(name);
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
    expect(byName['ANTHROPIC_BASE_URL']).toBe('https://api.example.test/');
    expect(byName['ZAI_BASE_URL']).toBe('https://z.example.test/');
  });

  test('v3 provenance records the redacted value', () => {
    const config = provenanceConfig(readCqEnv(env));
    expect(config.env['ANTHROPIC_BASE_URL']).toBe('https://api.example.test/');
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
    expect(out.join('')).toContain('https://api.example.test/');
  });
});

describe('display-site tripwire: a site that returns the raw value fails here', () => {
  // Semantic checks per known display site (a source scan cannot see a call
  // whose result is thrown away). Each site is fed a credential-bearing URL
  // with a query token and must not return any part of it.
  const raw = `https://u:${tok}@api.example.test/v1?token=${tok}#${tok}`;
  const escaped = String.raw`https:\/\/api.example.test/v1?token=` + tok;

  test.each([raw, escaped])('every structured site hides the secret (%#)', (value) => {
    const env = { ANTHROPIC_BASE_URL: value };
    const snapshot = readCqEnv(env);
    const outputs = [
      JSON.stringify(snapshot),
      JSON.stringify(buildConfigShowReport(env)),
      JSON.stringify(provenanceConfig(snapshot)),
    ];
    for (const out of outputs) expect(out).not.toContain(tok);
  });

  test('persisted error text and attempt records hide the secret', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', raw);
    expect(boundedErrorText(`failed ${raw} now`)).not.toContain(tok);
    expect(boundedErrorText(`failed ${escaped} now`)).not.toContain(tok);
    expect(
      JSON.stringify(sanitizeObservation({ stderr: `failed ${raw}`, url: raw })),
    ).not.toContain(tok);
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

  test('no other file implements an at-sign detector for URL values (`includes(@)`)', () => {
    const users = files.filter((f) => /includes\('@'\)/.test(text.get(f) ?? ''));
    expect(users.map(rel)).toEqual(['/shared/urlRedact.ts']);
  });

  test('the free-text userinfo marker is produced only by the shared module', () => {
    const users = files.filter((f) =>
      /\[redacted\]\$\{|\[redacted\]@|\?\[redacted\]|#\[redacted\]/.test(text.get(f) ?? ''),
    );
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
    expect(source).toMatch(
      /stripCredentialText|redactIfUrl|cutAuthorityUserinfo|showUrl|redactUrlUserinfo/,
    );
  });
});

// Regression table for the shared free-text scanner. The cases (and their
// expected strings) are copied from PR #1235 (crq repair F1), which fixed
// URL userinfo leaking into persisted error text with a second, regex-based
// redactor. That redactor is superseded by this one scanner.
describe('redactUrlUserinfo (cases from PR #1235)', () => {
  test.each([
    [
      'https://diagnostic-user:diagnostic-password@example.test/path',
      'https://[redacted]@example.test/path',
    ],
    [
      'postgres://diagnostic-user:p%40ss%3Aword@localhost:5432/db',
      'postgres://[redacted]@localhost:5432/db',
    ],
    ['//user:pass@example.test/path', '//[redacted]@example.test/path'],
    ['https:user:pass@example.test/path', 'https:[redacted]@example.test/path'],
    ['http:user:pass@example.test', 'http:[redacted]@example.test'],
    ['...https:user:pass@example.test', '...https:[redacted]@example.test'],
    ['xhttps:user:pass@example.test', 'xhttps:[redacted]@example.test'],
    ['prefixHTTP:user:pass@example.test', 'prefixHTTP:[redacted]@example.test'],
    ['xftp:user:pass@example.test', 'xftp:[redacted]@example.test'],
    ['xws:user:pass@example.test', 'xws:[redacted]@example.test'],
    ['xwss:user:pass@example.test', 'xwss:[redacted]@example.test'],
    ["https://user:p'ass@example.test/", 'https://[redacted]@example.test/'],
    [
      String.raw`https:\/\/user:pass@example.test/path`,
      String.raw`https:\/\/[redacted]@example.test/path`,
    ],
    [
      String.raw`https:\user:pass@example.test/path`,
      String.raw`https:\[redacted]@example.test/path`,
    ],
    ['HTTPS://user@example.test/', 'HTTPS://[redacted]@example.test/'],
    ['https://:password@[::1]:443/', 'https://[redacted]@[::1]:443/'],
    ['https://user:raw@password@example.test/', 'https://[redacted]@example.test/'],
  ])('redacts URL userinfo without an environment value: %s', (url, redacted) => {
    expect(redactUrlUserinfo(`failed at ${url}`)).toBe(`failed at ${redacted}`);
    expect(boundedErrorText(`failed at ${url}`)).toBe(`failed at ${redacted}`);
  });

  test.each([
    ['https://user:password-http:tail@host.test/path', 'https://[redacted]@host.test/path'],
    ['https://user:password-https:tail@host.test/path', 'https://[redacted]@host.test/path'],
    ['https://user:password-wss:tail@host.test/path', 'https://[redacted]@host.test/path'],
    ['https://user:password-ftp:tail@host.test/path', 'https://[redacted]@host.test/path'],
    [
      'https://host.test/?next=https://private:password@private.test/sensitive',
      'https://host.test/?[redacted]',
    ],
    [
      'https://host.test/#https://private:password@private.test/sensitive',
      'https://host.test/#[redacted]',
    ],
    [
      '"fetch https://user:password-http:tail@host.test/path?q=https://private.test/sensitive" now',
      '"fetch https://[redacted]@host.test/path?[redacted]" now',
    ],
    [
      'https://host.test/path/https://nested.test/path',
      'https://host.test/path/https://nested.test/path',
    ],
    [
      'https://u:password-http:tail@one.test/a)https://u:p@two.test/b',
      'https://[redacted]@one.test/a)https://[redacted]@two.test/b',
    ],
    ['https://host.test/?next=https://private.test/sensitive', 'https://host.test/?[redacted]'],
    ['https://host.test/#https://private.test/sensitive', 'https://host.test/#[redacted]'],
    [
      'https://u:password-http:tail@one.test/a and https://u:p@two.test/b?q=https://private.test/sensitive',
      'https://[redacted]@one.test/a and https://[redacted]@two.test/b?[redacted]',
    ],
    [
      'https://u:password-http:tail@one.test/a,https://u:p@two.test/b',
      'https://[redacted]@one.test/a,https://[redacted]@two.test/b',
    ],
  ])('keeps embedded schemes inside their enclosing URL: %s', (input, expected) => {
    expect(redactUrlUserinfo(input)).toBe(expected);
    expect(boundedErrorText(input)).toBe(expected);
  });

  test.each([
    [
      'https://web.archive.org/web/2020/https://u:p@host.test/',
      'https://web.archive.org/web/2020/https://[redacted]@host.test/',
    ],
    ['a=https://x.test/,b=https://u:p@y.test/', 'a=https://x.test/,b=https://[redacted]@y.test/'],
  ])('redacts a URL nested in an earlier URL path: %s', (input, expected) => {
    expect(redactUrlUserinfo(input)).toBe(expected);
    expect(boundedErrorText(input)).toBe(expected);
  });

  test('handles long credential-free output without repeated scheme or authority scans', () => {
    const inputs = [
      'a'.repeat(40_000),
      JSON.stringify({ content: 'a'.repeat(80_000) }),
      'https:'.repeat(10_000),
      '//host/'.repeat(10_000),
      'xhttps:'.repeat(10_000),
      'x'.repeat(80_000) + 'https:host',
    ];
    const start = performance.now();
    for (const input of inputs) expect(redactSensitiveText(input)).toBe(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('keeps the path (including an at-sign in it) and drops query and fragment', () => {
    // #1235 preserved the query and fragment byte for byte; the owner ruling
    // (ADR-0009) strips them in free text too, marking the cut.
    expect(boundedErrorText('see https://example.test/user@host ok')).toBe(
      'see https://example.test/user@host ok',
    );
    expect(boundedErrorText('see https://example.test?q=user@host ok')).toBe(
      'see https://example.test?[redacted] ok',
    );
    expect(boundedErrorText('see https://example.test#user@host ok')).toBe(
      'see https://example.test#[redacted] ok',
    );
    expect(boundedErrorText(`GET https://api.example/v1?token=${tok} failed`)).toBe(
      'GET https://api.example/v1?[redacted] failed',
    );
    expect(boundedErrorText(`GET https://u:p@api.example/v1?token=${tok}#f failed`)).toBe(
      'GET https://[redacted]@api.example/v1?[redacted] failed',
    );
  });

  test.each([
    ['see "https://host/path?q=TOKEN" now', 'see "https://host/path?[redacted]" now'],
    ["see 'https://host/path#TOKEN' now", "see 'https://host/path#[redacted]' now"],
    ['(https://host/path?q=TOKEN)', '(https://host/path?[redacted])'],
    ['<https://host/path?q=TOKEN>', '<https://host/path?[redacted]>'],
    ['[https://host/path?q=TOKEN]', '[https://host/path?[redacted]]'],
    ['https://host/path?q=TOKEN, next', 'https://host/path?[redacted], next'],
    ['https://host/path#TOKEN. Next', 'https://host/path#[redacted]. Next'],
    ['"fetch https://host/path?q=TOKEN" now', '"fetch https://host/path?[redacted]" now'],
    ['{https://host/path?q=TOKEN}', '{https://host/path?[redacted]}'],
    ['https://host/path?q=TOKEN"', 'https://host/path?[redacted]"'],
    ['(fetch https://host/path?q=TOKEN) now', '(fetch https://host/path?[redacted]) now'],
    ['{fetch https://host/path?q=TOKEN} now', '{fetch https://host/path?[redacted]} now'],
    ['https://host/path?q="TOKEN"', 'https://host/path?[redacted]"'],
    ['"fetch https://host/path?q="TOKEN"" now', '"fetch https://host/path?[redacted]"" now'],
    [
      'see "https://host/path" and https://host/path?q="TOKEN"&x=TOKEN',
      'see "https://host/path" and https://host/path?[redacted]',
    ],
    [
      String.raw`"fetch https://host/path?q=\"TOKEN\"" now`,
      '"fetch https://host/path?[redacted]" now',
    ],
  ])('preserves prose delimiters around %s', (input, expected) => {
    expect(redactUrlUserinfo(input)).toBe(expected);
  });

  test('redacts multiple credential-bearing URLs before truncation', () => {
    const text = 'https://u:p@one.test/ and ftp://u:p@two.test/ ' + 'x'.repeat(600);
    expect(boundedErrorText(text)).toBe(
      ('https://[redacted]@one.test/ and ftp://[redacted]@two.test/ ' + 'x'.repeat(600)).slice(
        0,
        500,
      ) + '… [truncated]',
    );
  });

  test('bare name@host prose and package specs are left alone (URL-only scanner)', () => {
    const text = 'contact me@example.test about vitest@5.0.0 and @types/node@22';
    expect(redactUrlUserinfo(text)).toBe(text);
  });
});
