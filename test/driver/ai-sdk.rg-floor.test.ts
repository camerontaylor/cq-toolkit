// The rg runtime floor boundary — the PRODUCTION comparator
// (versionAtLeast/parseRgVersion), the default resolver driven through a fake
// rg executable, and the CI guard (the former ai-sdk.test.ts floor describe).
import { spawn as childSpawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { conformanceHarnessConfig, invocation, modelFor } from './ai-sdk.helpers.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import type { WorkerResult } from '../../src/driver/types.js';
import {
  probeRgVersion as harnessProbeRg,
  parseRgVersion,
  versionAtLeast,
  RG_MINIMUM_VERSION,
} from '../../src/harness/tools.js';

describe('rg runtime floor boundary — PRODUCTION comparator', () => {
  // The PRODUCTION versionAtLeast/parseRgVersion, not a test-local mirror:
  // these pin the exact comparison the driver ships.
  test.each([
    ['10.5.0', false],
    ['11.0.0', true],
    ['11.1.3', true],
    ['14.1.1', true],
    ['15.2.0', true],
  ])('versionAtLeast(%s, 11.0.0) === %s', (found, expected) => {
    expect(versionAtLeast(found, '11.0.0')).toBe(expected);
  });

  test.each([
    ['ripgrep 15.2.0 (rev e89fff89ac)', '15.2.0'],
    ['ripgrep 14.1.1 (rev 4649aa9700)', '14.1.1'],
    ['ripgrep 11.0.0', '11.0.0'],
  ])('parseRgVersion(%s) === %s', (line, expected) => {
    expect(parseRgVersion(line)).toBe(expected);
  });

  test.each([
    ['', undefined],
    ['not a version line', undefined],
    ['ripgrep 15', undefined],
  ])('parseRgVersion(%j) is undefined', (line, expected) => {
    expect(parseRgVersion(line)).toBe(expected);
  });

  test('defaultResolveRg drives the production comparator through a fake rg executable', async () => {
    // A fake `rg` on PATH whose first stdout line is scripted: proves the
    // default resolver parses the REAL executable's output with the
    // PRODUCTION comparator — no test-local mirror anywhere in the path.
    const binDir = await mkdtemp(join(tmpdir(), 'aidrv-fake-rg-'));
    const script = async (body: string): Promise<string> => {
      const path = join(binDir, 'rg');
      await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return path;
    };
    const originalPath = process.env.PATH;
    const runWithFake = async (body: string): Promise<WorkerResult> => {
      await script(body);
      // The default resolver spawns `rg` from PATH: prepend the fake bin for
      // the duration of the run and restore after (vi.stubEnv restores too).
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-fake-'));
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      try {
        const driver = new AiSdkDriver({
          providers: { mock: (modelId) => modelFor(undefined, modelId) },
          sessionsDir: join(root, 'sessions'),
          harnessConfig: conformanceHarnessConfig(root),
          resolveRg: harnessProbeRg,
        });
        return await driver.run(
          invocation({
            workspace: { path: workspace },
            toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
            sandboxPolicy: { level: 'read-only' },
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };
    try {
      // serves: 14.1.1 >= floor 11.0.0
      const serving = await runWithFake(`echo 'ripgrep 14.1.1 (rev 4649aa9700)'`);
      expect(serving.capabilities?.rg).toMatchObject({
        available: true,
        version: '14.1.1',
        probe: 'ok',
      });
      // withheld: 10.5.0 < floor
      const withheld = await runWithFake(`echo 'ripgrep 10.5.0'`);
      expect(withheld.capabilities?.rg).toMatchObject({
        available: false,
        found: '10.5.0',
        probe: 'old',
      });
      expect(withheld.advisories).toEqual([
        'search tools unavailable: ripgrep older than minimum 11.0.0',
      ]);
      // absent: nonzero exit
      const absent = await runWithFake(`exit 2`);
      expect(absent.capabilities?.rg).toMatchObject({ available: false, probe: 'absent' });
    } finally {
      process.env.PATH = originalPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test('CI guard: on CI a missing/old real rg FAILS the search-tool surface outright (no skip)', async () => {
    const onCi =
      process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false';
    if (!onCi) {
      // Off CI this test simply returns (developers may lack rg); ON CI the
      // precondition below fails the test when rg is absent/old. Any truthy
      // CI value guards (CI=1 is common).
      return;
    }
    const bin = await new Promise<string | undefined>((resolve) => {
      const child = childSpawn('rg', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let head = '';
      child.stdout?.on('data', (c: Buffer) => {
        if (head === '') head = c.toString('utf8');
      });
      child.on('error', () => resolve(undefined));
      child.on('close', (code) => resolve(code === 0 ? head : undefined));
    });
    const version = parseRgVersion(bin?.split('\n')[0]);
    // THE GUARD: on CI, rg must exist AND satisfy the runtime floor.
    expect(version).toBeDefined();
    expect(versionAtLeast(version as string, RG_MINIMUM_VERSION)).toBe(true);
  });
});
