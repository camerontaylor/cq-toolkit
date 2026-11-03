// M8b — measurement archive transport wrapper. One case per condition:
//   - nominal: check the existing archive, then rclone copy to the configured
//     target under <target>/<host>/measurement;
//   - missing evidence: an absent bundle is failed, never archived silently;
//   - failure evidence: an archive/copy failure is explicit, names the
//     untouched local bundle, and deletes/mutates nothing.
// Local fixtures and a fake subprocess runner only: no rclone, no network.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildMeasurementBundle } from '../scripts/archive-measurement-evidence.mjs';
import { runMeasurementArchive } from '../scripts/archive-measurement-wrapper.mjs';

const TARGET = 'session-archive:session-log-archive/cq';
const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-m8b-'));
  dirs.push(dir);
  return dir;
}

async function bundleIn(base: string, runId: string): Promise<string> {
  const journal = join(base, 'journal');
  await mkdir(journal, { recursive: true });
  await writeFile(join(journal, 'evidence.ndjson'), '{"ok":true}\n');
  const built = (await buildMeasurementBundle({
    runId,
    bundleRoot: join(base, 'bundles'),
    roots: [{ name: 'fix', path: journal, files: ['evidence.ndjson'] }],
  })) as { bundleDir: string };
  return built.bundleDir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('M8b nominal evidence', () => {
  test('checks the existing archive, then copies to <target>/<host>/measurement', async () => {
    const base = await workspace();
    const bundle = await bundleIn(base, 'run-m8b-nominal');
    const manifestBefore = await readFile(join(bundle, 'manifest.json'), 'utf8');
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    };

    const result = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
      run,
    });

    expect(calls.map((call) => call.args[0])).toEqual(['lsf', 'copy']);
    expect(calls[0]).toEqual({
      command: 'rclone',
      args: ['lsf', TARGET, '--max-depth', '1'],
    });
    const destination = `${TARGET}/triton/measurement/run-m8b-nominal`;
    expect(calls[1]?.args).toEqual([
      'copy',
      await realpath(bundle),
      destination,
      '--immutable',
      '--transfers',
      '2',
      '--checkers',
      '2',
      '--low-level-retries',
      '4',
      '--no-update-modtime',
    ]);
    expect(result).toMatchObject({
      state: 'archived',
      runId: 'run-m8b-nominal',
      host: 'triton',
      destination,
      archive: { state: 'present' },
    });
    // No deletion primitive, and the bundle is byte-identical after transport.
    expect(calls[1]?.args.some((arg) => arg.startsWith('--delete') || arg === 'sync')).toBe(false);
    expect(await readFile(join(bundle, 'manifest.json'), 'utf8')).toBe(manifestBefore);
  });
});

describe('M8b missing evidence', () => {
  test('an absent bundle is failed, never archived as empty or skipped', async () => {
    const base = await workspace();
    const calls: string[] = [];
    const run = async (_command: string, args: string[]) => {
      calls.push(args[0] ?? '');
      return { code: 0 };
    };

    const result = await runMeasurementArchive({
      bundleDir: join(base, 'absent-bundle'),
      target: TARGET,
      host: 'triton',
      run,
    });

    expect(result.state).toBe('failed');
    expect(result.runId).toBeNull();
    expect(result.localBundle).toBeNull();
    expect(result.reason).toContain('absent');
    expect(result.archive.state).toBe('unknown');
    expect(calls).toEqual([]);
  });
});

describe('M8b failure evidence', () => {
  test('archive or copy failures are explicit, local, sanitized and non-destructive', async () => {
    const base = await workspace();
    const bundle = await bundleIn(base, 'run-m8b-failure');
    const manifestBefore = await readFile(join(bundle, 'manifest.json'), 'utf8');
    const secret = 'm8b-fixture-token-value';
    vi.stubEnv('CQ_M8B_TOKEN', secret);
    const calls: string[][] = [];
    const archiveDown = async (_command: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'lsf'
        ? { code: 3, stderr: `directory not found: ${secret}\nsecond line` }
        : { code: 0 };
    };

    const unavailable = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
      run: archiveDown,
    });
    expect(unavailable).toMatchObject({
      state: 'local',
      runId: 'run-m8b-failure',
      localBundle: await realpath(bundle),
      archive: { state: 'unavailable' },
    });
    expect(unavailable.reason).toContain('unavailable');
    expect(unavailable.reason).not.toContain(secret);
    expect(calls.map((args) => args[0])).toEqual(['lsf']);

    const copyFails = async (_command: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'lsf' ? { code: 0 } : { code: 1, stderr: 'permission denied' };
    };
    const copyFailure = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
      run: copyFails,
    });
    expect(copyFailure.state).toBe('local');
    expect(copyFailure.reason).toContain('permission denied');
    expect(copyFailure.archive.state).toBe('present');
    for (const args of calls)
      expect(args.some((arg) => arg.startsWith('--delete') || arg === 'sync')).toBe(false);

    // No deletion, no session-manifest mutation, no second fallback copy.
    expect(await readFile(join(bundle, 'manifest.json'), 'utf8')).toBe(manifestBefore);
    const source = await readFile('scripts/archive-measurement-wrapper.mjs', 'utf8');
    for (const forbidden of ['rm(', 'unlink(', 'writeFile'])
      expect(source).not.toContain(forbidden);
  });
});
