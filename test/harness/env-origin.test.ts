// ORIGIN of manifest env names: names trusted code passes in-process to
// buildManifest (a driver's envAllowlist) may carry a credential-shaped name
// such as SSH_AUTH_SOCK; the same name from a manifest FILE is refused, and no
// JSON/manifest/plan input can claim the trusted origin.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildManifest,
  createHarnessSurface,
  HarnessManifestSchema,
} from '../../src/harness/surface.js';
import type { HarnessManifest } from '../../src/harness/surface.js';
import { scratch, withRun } from './surface.helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const dummy = ['dummy', 'sock', String(Date.now())].join('-');

async function codeManifest(envNames: string[]): Promise<HarnessManifest> {
  const built = await buildManifest({
    workspace: scratch(),
    sandbox: 'workspace-write',
    toolPolicy: { allow: ['bash'] },
    harness: withRun(['env']),
    envNames,
  });
  if (built === undefined) throw new Error('expected a manifest');
  return built;
}

describe('manifest env name origin', () => {
  test('code-level SSH_AUTH_SOCK via buildManifest works end to end', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', dummy);
    const surface = createHarnessSurface(await codeManifest(['SSH_AUTH_SOCK']));
    const result = await surface.call('bash', { command: 'env' });
    expect(JSON.stringify(result)).toContain(dummy);
  });

  test('the same name from a manifest file (JSON round trip) is refused', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', dummy);
    const fromFile = JSON.parse(
      JSON.stringify(await codeManifest(['SSH_AUTH_SOCK'])),
    ) as HarnessManifest;
    expect(() => createHarnessSurface(fromFile)).toThrow(/SSH_AUTH_SOCK/);
    let message = '';
    try {
      createHarnessSurface(fromFile);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(dummy);
  });

  test('a re-parsed or spread copy of the code manifest loses the trusted origin', async () => {
    const built = await codeManifest(['SSH_AUTH_SOCK']);
    expect(() => createHarnessSurface(HarnessManifestSchema.parse(built))).toThrow(/SSH_AUTH_SOCK/);
    expect(() => createHarnessSurface({ ...built })).toThrow(/SSH_AUTH_SOCK/);
  });

  test('a code-level policy knob is still refused', async () => {
    await expect(async () =>
      createHarnessSurface(await codeManifest(['CQ_SANDBOX'])),
    ).rejects.toThrow(/CQ_SANDBOX/);
  });

  test('operator CQ_RUN_ENV_PASSTHROUGH never gets the trusted origin', async () => {
    vi.stubEnv('CQ_RUN_ENV_PASSTHROUGH', 'SSH_AUTH_SOCK');
    await expect(codeManifest([])).rejects.toThrow(/SSH_AUTH_SOCK/);
  });

  test('a manifest or plan carrying a code-origin field is rejected by the strict schema', async () => {
    const built = JSON.parse(JSON.stringify(await codeManifest([]))) as Record<string, unknown>;
    for (const field of ['trustedEnvNames', 'codeEnvNames', 'trusted', 'origin']) {
      expect(
        () => HarnessManifestSchema.parse({ ...built, [field]: ['SSH_AUTH_SOCK'] }),
        field,
      ).toThrow();
    }
  });

  test('the trusted-origin registry is touched only by surface.ts', () => {
    const root = join(import.meta.dirname, '..', '..', 'src');
    const users: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          /TRUSTED_ENV_NAMES/.test(readFileSync(full, 'utf8'))
        ) {
          users.push(full.replace(root, ''));
        }
      }
    };
    walk(root);
    expect(users).toEqual(['/harness/surface.ts']);
  });
});
