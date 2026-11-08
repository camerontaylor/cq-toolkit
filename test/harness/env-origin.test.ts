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
import { DECLARED_ENV_EXEMPT_NAMES, TRUSTED_ENV_EXEMPT_NAMES } from '../../src/config/parsers.js';
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

  test.each([
    'CQ_AUTOMATION_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'NPM_TOKEN',
    'NODE_OPTIONS',
    'NODE_PATH',
    'CQ_TEST_KEEP',
    'ANTHROPIC_API_KEY',
  ])('a code-level %s is refused too (only the named exemptions pass)', async (name) => {
    vi.stubEnv(name, dummy);
    let message = '';
    try {
      createHarnessSurface(await codeManifest([name]));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(name);
    expect(message).not.toContain(dummy);
  });

  test('the trusted exemption list is frozen and holds exactly the stated names', () => {
    expect(Object.isFrozen(TRUSTED_ENV_EXEMPT_NAMES)).toBe(true);
    // Adding a name needs a change here AND a stated reason in ADR-0009.
    expect([...TRUSTED_ENV_EXEMPT_NAMES]).toEqual(['SSH_AUTH_SOCK']);
    expect(() => (TRUSTED_ENV_EXEMPT_NAMES as string[]).push('NPM_TOKEN')).toThrow();
  });

  test('the manifest-file exemption list is frozen and empty', () => {
    expect(Object.isFrozen(DECLARED_ENV_EXEMPT_NAMES)).toBe(true);
    // No current non-test caller needs a CQ_* or credential name from a file.
    expect([...DECLARED_ENV_EXEMPT_NAMES]).toEqual([]);
    expect(() => (DECLARED_ENV_EXEMPT_NAMES as string[]).push('CQ_TEST_KEEP')).toThrow();
  });

  test.each(['CQ_TEST_KEEP', 'CQ_SESSIONS_DIR', 'CQ_AUTOMATION_TOKEN', 'cq_work_id'])(
    'a manifest-file %s is refused, with no value in the error',
    async (name) => {
      vi.stubEnv(name, dummy);
      const fromFile = JSON.parse(JSON.stringify(await codeManifest([]))) as HarnessManifest;
      fromFile.envNames.push(name);
      let message = '';
      try {
        createHarnessSurface(fromFile);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain(dummy);
    },
  );

  test('mutating a trusted manifest, or wrapping it, adds no trust', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', dummy);
    const built = await codeManifest([]);
    built.envNames.push('SSH_AUTH_SOCK');
    expect(() => createHarnessSurface(built)).toThrow(/SSH_AUTH_SOCK/);
    const trusted = await codeManifest(['SSH_AUTH_SOCK']);
    expect(() => createHarnessSurface(Object.create(trusted) as HarnessManifest)).toThrow();
    expect(() => createHarnessSurface(new Proxy(trusted, {}))).toThrow(/SSH_AUTH_SOCK/);
  });

  test('the declared-credential refusal text says what is allowed, without a value', async () => {
    const fromFile = JSON.parse(
      JSON.stringify(await codeManifest(['ANTHROPIC_API_KEY'])),
    ) as HarnessManifest;
    vi.stubEnv('ANTHROPIC_API_KEY', dummy);
    let message = '';
    try {
      createHarnessSurface(fromFile);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("'ANTHROPIC_API_KEY' is a credential");
    expect(message).toContain(
      'a declared or manifest name can never pass it (not even SSH_AUTH_SOCK); only the in-process code-level origin may pass SSH_AUTH_SOCK',
    );
    expect(message).not.toContain(dummy);
  });

  test.each([
    ['a non-array', 'FOO'],
    ['a non-string entry', [42]],
    ['an empty string', ['']],
    ['an assignment shape', [`FOO=${dummy}`]],
    ['a very long entry', [`${dummy}${'x'.repeat(5000)}`]],
  ])(
    'malformed code-level envNames (%s) is a one-line error without the value',
    async (_l, bad) => {
      let message = '';
      try {
        await buildManifest({
          workspace: scratch(),
          sandbox: 'workspace-write',
          toolPolicy: { allow: ['bash'] },
          harness: withRun(['env']),
          envNames: bad as unknown as string[],
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^harness manifest: invalid envNames/);
      expect(message).not.toContain('\n');
      expect(message).not.toContain(dummy);
      expect(message.length).toBeLessThan(300);
    },
  );

  test('a hand-made malformed manifest reaches createHarnessSurface as a one-line error too', async () => {
    const built = JSON.parse(JSON.stringify(await codeManifest([]))) as Record<string, unknown>;
    built['envNames'] = [`FOO=${dummy}`];
    let message = '';
    try {
      createHarnessSurface(built as unknown as HarnessManifest);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^harness manifest: invalid envNames\.0/);
    expect(message).not.toContain(dummy);
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
