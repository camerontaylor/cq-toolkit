// Split provenance: test/ops/dev/check.test.ts was split by subject into
// check.input-rules.test.ts, check.adopter.test.ts, check.portable-scan.test.ts,
// check.selection.test.ts, check.gates.test.ts and check.diff-gates.test.ts.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDevCheck } from '../../../src/ops/dev/check.js';
import { devEffectsFor } from './check.helpers.js';
import { makeTestRepo, type CommandHandler, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const effectsFor = (override?: CommandHandler) => devEffectsFor(repo, override);

describe('dev.check', () => {
  test('runs repository cq.json checks and skips address-only checks for adopters', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [
          {
            adapter: 'test-narrow',
            addressOnly: true,
            command: { command: 'must-not-run', args: [] },
          },
          {
            adapter: 'tsc-lines',
            command: {
              command: 'fake-check',
              args: ['--strict'],
              cwd: 'packages/app',
              timeoutMs: 12_345,
            },
          },
        ],
      }),
    );
    repo.commitAll('configure portable check');
    const effects = effectsFor((command) => (command === 'fake-check' ? '' : undefined));
    const originalRunCommand = effects.runCommand;
    let configuredCwd: string | undefined;
    let configuredTimeout: number | undefined;
    effects.runCommand = async (command, args, options) => {
      if (command === 'fake-check') {
        configuredCwd = options.cwd;
        configuredTimeout = options.timeoutMs;
      }
      return originalRunCommand(command, args, options);
    };
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.gates.map((gate) => gate.name)).toContain('cq.json:1:tsc-lines');
    expect(result.value.gates.map((gate) => gate.name)).not.toContain('check:static');
    expect(effects.calls).toContainEqual({ command: 'fake-check', args: ['--strict'] });
    expect(effects.calls.some(({ command }) => command === 'must-not-run')).toBe(false);
    expect(configuredCwd).toBe(join(repo.root, 'packages/app'));
    expect(configuredTimeout).toBe(12_345);
  });

  test.each([
    ['malformed JSON', 'not json'],
    [
      'a failing assertion behind exit zero',
      JSON.stringify({
        success: false,
        numTotalTests: 1,
        testResults: [
          {
            name: 'src/a.test.ts',
            assertionResults: [{ status: 'failed', fullName: 'fails', failureMessages: ['bad'] }],
          },
        ],
      }),
    ],
  ])(
    'rejects %s from an adopter JSON check even when the process exits zero',
    async (_label, stdout) => {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'vitest-json', command: { command: 'fake-check', args: [] } }],
        }),
      );
      repo.commitAll('configure JSON check');
      const effects = effectsFor((command) =>
        command === 'fake-check' ? { exitCode: 0, stdout, stderr: '', timedOut: false } : undefined,
      );
      const result = await makeDevCheck(effects)({ repoRoot: repo.root });
      expect(result.status).toBe('failed');
      const record = effects
        .openLedger('feature/x')
        .load()
        .records.find((entry) => entry.kind === 'check');
      expect(record?.kind === 'check' && record.gates[0]).toMatchObject({
        name: 'cq.json:1:vitest-json',
        status: 'fail',
      });
    },
  );

  test('preserves absolute configured check working directories', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [
          {
            adapter: 'tsc-lines',
            command: { command: 'fake-check', args: [], cwd: '/external/check' },
          },
        ],
      }),
    );
    repo.commitAll('configure absolute check directory');
    const effects = effectsFor((command) => (command === 'fake-check' ? '' : undefined));
    let configuredCwd: string | undefined;
    const originalRunCommand = effects.runCommand;
    effects.runCommand = async (command, args, options) => {
      if (command === 'fake-check') configuredCwd = options.cwd;
      return originalRunCommand(command, args, options);
    };
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(configuredCwd).toBe('/external/check');
  });

  test('refuses malformed adopter cq.json instead of falling back to legacy gates', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write('cq.json', JSON.stringify({ schemaVersion: 1, checks: [] }));
    repo.commitAll('add malformed cq config');
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('cq.json');
    expect(effects.calls.filter((call) => call.command === 'pnpm')).toEqual([]);
  });

  test('refuses an unreadable cq.json (EISDIR) instead of falling back to legacy gates', async () => {
    await mkdir(join(repo.root, 'cq.json')); // present-but-unreadable; only ENOENT means "no config"
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('dev.check: cq.json could not be read (EISDIR)');
    expect(effects.calls.filter((call) => call.command === 'pnpm')).toEqual([]);
  });

  test('refuses malformed cq.json for cq-toolkit too', async () => {
    await repo.write('package.json', JSON.stringify({ name: '@camerontaylor/cq-toolkit' }));
    await repo.write('cq.json', JSON.stringify({ schemaVersion: 1, checks: [] }));
    repo.commitAll('malformed toolkit config');
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(effects.calls.filter((call) => call.command === 'pnpm')).toEqual([]);
  });
});

test('dev.check refuses an adopter config with only address checks', async () => {
  await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
  await repo.write(
    'cq.json',
    JSON.stringify({
      schemaVersion: 2,
      checks: [
        {
          adapter: 'test-narrow',
          addressOnly: true,
          command: { command: 'must-not-run', args: [] },
        },
      ],
    }),
  );
  repo.commitAll('configure only scoped verification');
  const effects = effectsFor();
  const result = await makeDevCheck(effects)({ repoRoot: repo.root });
  expect(result.status).toBe('needs-human');
  if (result.status === 'needs-human') expect(result.reason).toContain('no repository checks');
  expect(effects.calls.some(({ command }) => command === 'must-not-run')).toBe(false);
});
