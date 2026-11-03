// Split provenance: test/harness/surface.test.ts was split into the
// surface.*.test.ts subject files plus surface.helpers.ts; this file keeps
// the strict manifest schema and buildManifest pins.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { buildManifest, HarnessManifestSchema } from '../../src/harness/surface.js';
import { buildTools } from '../../src/harness/tools.js';
import { scratch } from './surface.helpers.js';

describe('HarnessManifestSchema', () => {
  const base = {
    v: 1,
    workspace: '/w',
    sandbox: 'none',
    tools: ['read'],
    harness: defaultHarnessConfig,
  };

  test('accepts a minimal manifest and defaults envNames to []', () => {
    expect(HarnessManifestSchema.parse(base).envNames).toEqual([]);
  });

  test.each([
    ['an unknown key', { ...base, extra: true }],
    ['an empty tool list', { ...base, tools: [] }],
    ['a repeated tool', { ...base, tools: ['read', 'read'] }],
    ['an unknown tool', { ...base, tools: ['Bash'] }],
    ['a malformed env name', { ...base, envNames: ['BAD-NAME'] }],
    ['an env name starting with a digit', { ...base, envNames: ['1ABC'] }],
    ['a wrong version', { ...base, v: 2 }],
    ['an empty workspace', { ...base, workspace: '' }],
  ])('rejects %s', (_label, candidate) => {
    expect(HarnessManifestSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('buildManifest', () => {
  test('realpaths the workspace (through a symlink) and records the selection', async () => {
    const dir = scratch();
    const real = join(dir, 'real');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'link'));
    const built = await buildManifest({
      workspace: join(dir, 'link'),
      sandbox: 'read-only',
      toolPolicy: { allow: ['read'] },
      harness: defaultHarnessConfig,
      envNames: ['GH_TOKEN'],
    });
    expect(built).toEqual({
      v: 1,
      workspace: real,
      sandbox: 'read-only',
      tools: ['read'],
      harness: defaultHarnessConfig,
      envNames: ['GH_TOKEN'],
    });
  });

  test('records the read-only search tool selection in the strict manifest', async () => {
    const built = await buildManifest({
      workspace: scratch(),
      sandbox: 'read-only',
      toolPolicy: { allow: ['read', 'grep', 'glob'] },
      harness: defaultHarnessConfig,
    });
    expect(built?.tools).toEqual(['read', 'grep', 'glob']);
  });

  test('keeps the established tools within the budget before read-only search tools', () => {
    const workspace = scratch();
    const tools = buildTools(defaultHarnessConfig, workspace, 'read-only');
    expect(tools.map(({ name }) => name)).toEqual([
      'read',
      'edit',
      'bash',
      'write',
      'grep',
      'glob',
    ]);
    const tightBudget: HarnessConfig = {
      ...defaultHarnessConfig,
      promptBudget: { ...defaultHarnessConfig.promptBudget, maxTools: 4 },
    };
    expect(buildTools(tightBudget, workspace, 'read-only').map(({ name }) => name)).toEqual([
      'read',
      'edit',
      'bash',
      'write',
    ]);
  });

  test('an empty selection yields no manifest (and touches no filesystem)', async () => {
    await expect(
      buildManifest({
        workspace: '/definitely/not/here',
        sandbox: 'none',
        toolPolicy: { allow: [], mode: 'none' },
        harness: defaultHarnessConfig,
      }),
    ).resolves.toBeUndefined();
  });

  test('throws on a non-directory workspace', async () => {
    const file = join(scratch(), 'file.txt');
    writeFileSync(file, 'x');
    await expect(
      buildManifest({
        workspace: file,
        sandbox: 'none',
        toolPolicy: { allow: ['read'] },
        harness: defaultHarnessConfig,
      }),
    ).rejects.toThrow(/is not a directory/);
  });

  test('throws on a missing workspace', async () => {
    await expect(
      buildManifest({
        workspace: join(scratch(), 'missing'),
        sandbox: 'none',
        toolPolicy: { allow: ['read'] },
        harness: defaultHarnessConfig,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('throws on an env name the schema rejects', async () => {
    await expect(
      buildManifest({
        workspace: scratch(),
        sandbox: 'none',
        toolPolicy: { allow: ['read'] },
        harness: defaultHarnessConfig,
        envNames: ['NOT OK'],
      }),
    ).rejects.toThrow();
  });
});
