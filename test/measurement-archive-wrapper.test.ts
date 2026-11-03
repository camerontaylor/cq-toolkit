// M8b — measurement archive transport wrapper. One case per condition:
//   - nominal: check the existing archive, copy with manifest.json as the
//     commit marker, then verify the remote one-way;
//   - missing evidence: an absent bundle is failed, never archived silently;
//   - failure evidence: an archive/copy/verify failure is explicit, names the
//     untouched local bundle, and deletes/mutates nothing;
//   - invalid input: a bad target, host, runId or manifest is failed with no
//     remote command at all.
// Local fixtures and a fake subprocess runner only: no rclone, no network.
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildMeasurementBundle } from '../scripts/archive-measurement-evidence.mjs';
import { runMeasurementArchive } from '../scripts/archive-measurement-wrapper.mjs';

const TARGET = 'session-archive:session-log-archive/crq';
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

/** A bundle-shaped directory with a hand-written manifest. */
async function rawBundle(base: string, name: string, manifest: unknown): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('M8b nominal evidence', () => {
  test('checks the archive, copies, commits the manifest, then verifies the remote', async () => {
    const base = await workspace();
    const bundle = await bundleIn(base, 'run-m8b-nominal');
    const root = await realpath(bundle);
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

    expect(calls.map((call) => call.args[0])).toEqual(['lsf', 'copy', 'copyto', 'check']);
    expect(calls[0]).toEqual({
      command: 'rclone',
      args: ['lsf', TARGET, '--max-depth', '1'],
    });
    const destination = `${TARGET}/triton/measurement/run-m8b-nominal`;
    expect(calls[1]?.args).toEqual([
      'copy',
      root,
      destination,
      '--immutable',
      '--transfers',
      '2',
      '--checkers',
      '2',
      '--low-level-retries',
      '4',
      '--no-update-modtime',
      '--exclude',
      '/manifest.json',
    ]);
    expect(calls[2]?.args).toEqual([
      'copyto',
      `${root}/manifest.json`,
      `${destination}/manifest.json`,
    ]);
    expect(calls[3]?.args).toEqual(['check', root, destination, '--one-way']);
    expect(result).toMatchObject({
      state: 'archived',
      runId: 'run-m8b-nominal',
      host: 'triton',
      destination,
      archive: { state: 'present' },
    });
    // No deletion primitive, and the bundle is byte-identical after transport.
    for (const call of calls)
      expect(call.args.some((arg) => arg.startsWith('--delete') || arg === 'sync')).toBe(false);
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
    expect(copyFailure.reason).toContain('partial content');
    expect(copyFailure.archive.state).toBe('present');
    // A failed copy never writes the commit marker and never verifies.
    expect(calls.map((args) => args[0])).toEqual(['lsf', 'lsf', 'copy']);
    for (const args of calls)
      expect(args.some((arg) => arg.startsWith('--delete') || arg === 'sync')).toBe(false);

    // No deletion, no session-manifest mutation, no second fallback copy.
    expect(await readFile(join(bundle, 'manifest.json'), 'utf8')).toBe(manifestBefore);
    const source = await readFile('scripts/archive-measurement-wrapper.mjs', 'utf8');
    for (const forbidden of ['rm(', 'unlink(', 'writeFile'])
      expect(source).not.toContain(forbidden);
    expect(source).toContain('timeout: RCLONE_TIMEOUT_MS');
  });

  test('a failed commit-marker write is local and flags partial remote content', async () => {
    const base = await workspace();
    const bundle = await bundleIn(base, 'run-m8b-commit');
    const calls: string[][] = [];
    const run = async (_command: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'copyto'
        ? { code: 5, stderr: 'Failed to copyto: permission denied' }
        : { code: 0 };
    };

    const result = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
      run,
    });

    expect(result.state).toBe('local');
    expect(result.reason).toContain('commit marker');
    expect(result.reason).toContain('partial content');
    expect(result.reason).toContain('permission denied');
    expect(calls.map((args) => args[0])).toEqual(['lsf', 'copy', 'copyto']);
  });

  test('a failed remote verification is local and reports an incomplete copy', async () => {
    const base = await workspace();
    const bundle = await bundleIn(base, 'run-m8b-verify');
    const destination = `${TARGET}/triton/measurement/run-m8b-verify`;
    const calls: string[][] = [];
    const run = async (_command: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'check'
        ? { code: 1, stderr: 'NOTICE: skipping symlink\nERROR : files/x: sizes differ' }
        : { code: 0 };
    };

    const result = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
      run,
    });

    expect(result.state).toBe('local');
    expect(result.reason).toContain('remote copy incomplete');
    // The ERROR line is preferred over a leading NOTICE line.
    expect(result.reason).toContain('sizes differ');
    expect(result.reason).not.toContain('skipping symlink');
    expect(result.archive.state).toBe('present');
    expect(calls.map((args) => args[0])).toEqual(['lsf', 'copy', 'copyto', 'check']);
    expect(calls[3]).toEqual(['check', await realpath(bundle), destination, '--one-way']);
  });

  test('invalid targets, hosts, runIds and manifests are failed with zero remote calls', async () => {
    const base = await workspace();
    const bundle = await bundleIn(base, 'run-m8b-invalid');
    const run = vi.fn(async () => ({ code: 0 }));
    const rows: Array<{ label: string; dir: string; input: Record<string, string> }> = [];
    const hostile = ['../x', '..', 'a/b', '-x', '.x'];
    for (const [index, value] of hostile.entries()) {
      rows.push({ label: `target ${value}`, dir: bundle, input: { target: value } });
      rows.push({ label: `host ${value}`, dir: bundle, input: { target: TARGET, host: value } });
      rows.push({
        label: `runId ${value}`,
        dir: await rawBundle(base, `run-id-${index}`, { bundleVersion: 1, runId: value }),
        input: { target: TARGET, host: 'triton' },
      });
    }
    for (const value of ['../x', '..', 'a/../b', '.'])
      rows.push({
        label: `remote path ${value}`,
        dir: bundle,
        input: { target: `session-archive:${value}` },
      });
    rows.push(
      { label: 'colonless target', dir: bundle, input: { target: 'session-archive' } },
      { label: 'relative target', dir: bundle, input: { target: 'rel/dir' } },
      { label: 'bare remote target', dir: bundle, input: { target: 'session-archive:' } },
      {
        label: 'connection-string target',
        dir: bundle,
        input: { target: ':sftp,host=example.com:/data' },
      },
    );

    const linked = join(base, 'symlink-bundle');
    await mkdir(linked);
    await symlink(join(bundle, 'manifest.json'), join(linked, 'manifest.json'));
    rows.push({ label: 'symlinked manifest', dir: linked, input: { target: TARGET } });

    const oversized = join(base, 'oversize-bundle');
    await mkdir(oversized);
    await writeFile(join(oversized, 'manifest.json'), '');
    await truncate(join(oversized, 'manifest.json'), 8 * 1024 * 1024 + 1);
    rows.push({ label: 'oversize manifest', dir: oversized, input: { target: TARGET } });

    rows.push({
      label: 'unsupported bundleVersion',
      dir: await rawBundle(base, 'version-bundle', { bundleVersion: 2, runId: 'run-m8b-v2' }),
      input: { target: TARGET },
    });

    for (const row of rows) {
      const result = await runMeasurementArchive({ bundleDir: row.dir, ...row.input, run });
      expect(result.state, row.label).toBe('failed');
      expect(result.reason, row.label).toBeTruthy();
    }
    expect(run).not.toHaveBeenCalled();
  });

  test('a FIFO manifest is rejected instead of blocking the read', async () => {
    const base = await workspace();
    const dir = join(base, 'fifo-bundle');
    await mkdir(dir);
    const fifo = join(dir, 'manifest.json');
    execFileSync('mkfifo', [fifo]);
    const run = vi.fn(async () => ({ code: 0 }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      runMeasurementArchive({ bundleDir: dir, target: TARGET, host: 'triton', run }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('manifest read blocked on the FIFO')), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
    // Release a blocking open from an unfixed build so the worker can finish.
    const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => null);
    await writer?.close();

    expect(result.state).toBe('failed');
    expect(result.reason).toContain('not a regular file');
    expect(run).not.toHaveBeenCalled();
  });

  test('a missing rclone is unknown, not unavailable, and keeps evidence local', async () => {
    const base = await workspace();
    const bundle = await bundleIn(base, 'run-m8b-no-rclone');
    vi.stubEnv('PATH', join(base, 'empty-bin'));

    const result = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
    });

    expect(result.state).toBe('local');
    expect(result.archive.state).toBe('unknown');
    expect(result.reason).toContain('could not be checked');
    expect(result.reason).toContain('ENOENT');
    expect(result.localBundle).toBe(await realpath(bundle));
  });
});
