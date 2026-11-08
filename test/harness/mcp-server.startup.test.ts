// Split provenance: test/harness/mcp-server.test.ts was split into subject
// files; this one covers STARTUP: checkStartup's refusals (one line each)
// and happy path, and scrubEnvironment's allowlist (process.env
// saved/restored around it).
// Siblings: mcp-server.helpers.ts (shared fixtures) and the other
// mcp-server.*.test.ts files in this directory.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { checkStartup, scrubEnvironment } from '../../src/harness/mcp/startup.js';
import { manifestFor, scratch } from './mcp-server.helpers.js';

describe('checkStartup', () => {
  test('happy path binds the surface', () => {
    const workspace = scratch();
    const result = checkStartup([JSON.stringify(manifestFor(workspace))]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.workspace).toBe(workspace);
      expect(result.surface.tools.map((tool) => tool.name)).toEqual(['read', 'bash']);
    }
  });

  const refusal = (argv: readonly string[]): string => {
    const result = checkStartup(argv);
    if (result.ok) throw new Error('expected a startup refusal');
    expect(result.reason).not.toContain('\n');
    return result.reason;
  };

  test('wrong argument count', () => {
    expect(refusal([])).toBe('expected exactly one argument (the manifest JSON), got 0');
    expect(refusal(['{}', '{}'])).toBe('expected exactly one argument (the manifest JSON), got 2');
  });

  test('bad JSON', () => {
    expect(refusal(['{not json'])).toMatch(/^invalid manifest: /);
  });

  test('an unknown manifest key', () => {
    const manifest = { ...manifestFor(scratch()), extra: 1 };
    expect(refusal([JSON.stringify(manifest)])).toMatch(/^invalid manifest: /);
  });

  test('a symlinked workspace → realpath mismatch', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const manifest = manifestFor(join(dir, 'link'));
    expect(refusal([JSON.stringify(manifest)])).toBe(
      `workspace realpath mismatch: manifest '${join(dir, 'link')}', realpath '${join(dir, 'real')}'`,
    );
  });

  test('a non-directory workspace', () => {
    const file = join(scratch(), 'file.txt');
    writeFileSync(file, 'x');
    expect(refusal([JSON.stringify(manifestFor(file))])).toBe(
      `workspace '${file}' is not a directory`,
    );
  });

  test('a missing workspace', () => {
    const missing = join(scratch(), 'missing');
    expect(refusal([JSON.stringify(manifestFor(missing))])).toMatch(/^workspace unavailable: /);
  });

  test('a manifest naming a disabled tool → surface mismatch', () => {
    const harness: HarnessConfig = {
      ...defaultHarnessConfig,
      tools: { ...defaultHarnessConfig.tools, bash: { enabled: false, commandPatterns: [] } },
    };
    const manifest = manifestFor(scratch(), { harness });
    expect(refusal([JSON.stringify(manifest)])).toMatch(/^surface mismatch: .*bash/);
  });
});

describe('scrubEnvironment', () => {
  test('keeps the default allowlist plus envNames and drops everything else', () => {
    const saved = { ...process.env };
    try {
      process.env['ANTHROPIC_API_KEY'] = 'secret';
      process.env['TEST_EXTRA_CANARY'] = 'kept';
      process.env['CQ_TEST_OTHER'] = 'dropped';
      process.env['PATH'] ??= '/usr/bin:/bin';
      const path = process.env['PATH'];
      scrubEnvironment(['TEST_EXTRA_CANARY']);
      expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(process.env['CQ_TEST_OTHER']).toBeUndefined();
      expect(process.env['TEST_EXTRA_CANARY']).toBe('kept');
      expect(process.env['PATH']).toBe(path);
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});
