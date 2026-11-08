// M8b — measurement archive transport wrapper. One case per condition:
//   - nominal: check the existing archive, copy the payload, verify it, then
//     commit manifest.json as the marker and verify the marker;
//   - missing evidence: an absent bundle is failed, never archived silently;
//   - failure evidence: an archive/copy/verify failure is explicit, names the
//     untouched local bundle, and deletes/mutates nothing;
//   - invalid input: a bad target, host, runId or manifest is failed with no
//     remote command at all.
// Local fixtures and a fake subprocess runner, plus real-rclone immutability
// probes against a hermetic local alias remote: no ambient config, no
// credentials, no network; the probes skip only where rclone is absent.
import { execFileSync, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
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
import {
  mapRcloneFailure,
  runMeasurementArchive,
} from '../scripts/archive-measurement-wrapper.mjs';

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

describe('measurement archive CLI entry guard', () => {
  test.each([false, true])(
    'runs a symlinked entry with preserve-symlinks-main=%s',
    async (preserve) => {
      const base = await workspace();
      // Keep relative sibling imports valid even when Node preserves the main URL.
      await symlink(join(process.cwd(), 'scripts'), join(base, 'scripts'), 'dir');
      const entry = join(base, 'scripts', 'archive-measurement-wrapper.mjs');
      const result = spawnSync(
        process.execPath,
        [...(preserve ? ['--preserve-symlinks-main'] : []), entry],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        state: 'failed',
        reason: 'measurement archive: no valid rclone target',
      });
    },
  );

  test('importing the wrapper does not run the CLI', () => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./scripts/archive-measurement-wrapper.mjs')"],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
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

    expect(calls.map((call) => call.args[0])).toEqual(['lsf', 'copy', 'check', 'copy', 'check']);
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
    // The payload is verified before the commit marker exists on the remote.
    expect(calls[2]?.args).toEqual([
      'check',
      root,
      destination,
      '--one-way',
      '--exclude',
      '/manifest.json',
      '--copy-links',
    ]);
    // The marker is a directory-scope copy with the payload copy's flags:
    // single-file copyto skips the --immutable check (rclone issue #4921).
    expect(calls[3]?.args).toEqual([
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
      '--include',
      '/manifest.json',
    ]);
    expect(calls[4]?.args).toEqual([
      'check',
      root,
      destination,
      '--one-way',
      '--include',
      '/manifest.json',
      '--copy-links',
    ]);
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
    // The marker copy is the copy filtered to the manifest (--include); the
    // payload copy carries --exclude instead.
    const run = async (_command: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'copy' && args.includes('--include')
        ? { code: 5, stderr: 'Failed to copy: permission denied' }
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
    expect(calls.map((args) => args[0])).toEqual(['lsf', 'copy', 'check', 'copy']);
  });

  test('a differing remote manifest is never overwritten: the marker copy is immutable', async () => {
    const base = await workspace();
    const bundle = await bundleIn(base, 'run-m8b-immutable');
    const calls: string[][] = [];
    // Simulates rclone against a remote that already holds a different
    // manifest.json: with --immutable the directory-scope marker copy fails
    // loudly; without it the archived marker is silently rewritten and the
    // run reports 'archived'.
    const run = async (_command: string, args: string[]) => {
      calls.push(args);
      if (!(args[0] === 'copy' && args.includes('--include'))) return { code: 0 };
      return args.includes('--immutable')
        ? { code: 6, stderr: 'ERROR : manifest.json: immutable file modified' }
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
    expect(result.reason).toContain('immutable file modified');
    expect(calls[3]?.[0]).toBe('copy');
    expect(calls[3]).toContain('--immutable');
    expect(calls[3]).toContain('/manifest.json');
    // The overwritten-marker path never reaches the final verification.
    expect(calls.map((args) => args[0])).toEqual(['lsf', 'copy', 'check', 'copy']);
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
    // The payload check fails before the commit marker is ever written.
    expect(calls.map((args) => args[0])).toEqual(['lsf', 'copy', 'check']);
    expect(calls[2]).toEqual([
      'check',
      await realpath(bundle),
      destination,
      '--one-way',
      '--exclude',
      '/manifest.json',
      '--copy-links',
    ]);

    const markerCalls: string[][] = [];
    // Fail only the marker-verification check: the marker copy is a copy too,
    // distinguished by --include.
    const markerRun = async (_command: string, args: string[]) => {
      markerCalls.push(args);
      return args[0] === 'check' && args.includes('--include')
        ? { code: 1, stderr: 'ERROR : manifest.json: sizes differ' }
        : { code: 0 };
    };
    const marker = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
      run: markerRun,
    });

    expect(marker.state).toBe('local');
    expect(marker.reason).toContain('could not be verified');
    expect(marker.archive.state).toBe('present');
    expect(markerCalls.map((args) => args[0])).toEqual(['lsf', 'copy', 'check', 'copy', 'check']);
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
        label: 'absolute remote path target',
        dir: bundle,
        input: { target: 'session-archive:/abs/root' },
      },
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

  test('a real symlink or FIFO anywhere in the bundle fails before any remote call', async () => {
    const base = await workspace();
    const run = vi.fn(async () => ({ code: 0 }));
    // A REAL symlink under files/, and every fake runner answer says success:
    // the verdict must come from the lstat walk alone, because the rclone
    // local backend silently omits symlinks from both copy and check.
    const bundle = await bundleIn(base, 'run-m8b-symlink');
    await symlink(join(bundle, 'manifest.json'), join(bundle, 'files', 'fix', 'link.ndjson'));

    const linked = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
      run,
    });

    expect(linked.state).toBe('failed');
    expect(linked.reason).toContain('symlink');
    expect(run).not.toHaveBeenCalled();

    const fifoBundle = await bundleIn(base, 'run-m8b-fifo-tree');
    execFileSync('mkfifo', [join(fifoBundle, 'files', 'fix', 'pipe.ndjson')]);
    const piped = await runMeasurementArchive({
      bundleDir: fifoBundle,
      target: TARGET,
      host: 'triton',
      run,
    });

    expect(piped.state).toBe('failed');
    expect(piped.reason).toContain('non-regular file');
    expect(run).not.toHaveBeenCalled();
  });

  test('an externally killed rclone names its signal; only ENOENT/EACCES read as never-run', async () => {
    const base = await workspace();
    const bundle = await bundleIn(base, 'run-m8b-timeout');
    // Real runner against a fake rclone that dies from a signal execFile did
    // not send (killed false, code null) — the shape an OOM kill or a
    // systemctl stop leaves behind.
    const bin = join(base, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'rclone'), '#!/bin/sh\nkill -TERM $$\n');
    await chmod(join(bin, 'rclone'), 0o755);
    vi.stubEnv('PATH', bin);

    const killed = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
    });

    expect(killed.state).toBe('local');
    expect(killed.archive.state).toBe('unavailable');
    expect(killed.reason).toContain('was killed by SIGTERM');
    expect(killed.reason).not.toContain('timed out');

    // The maxBuffer abort is execFile killing the child for flooding stdio,
    // not the timeout: it keeps its own code and stays a ran path. The flood
    // is a shell loop so it needs nothing from the stubbed PATH.
    await writeFile(
      join(bin, 'rclone'),
      '#!/bin/sh\nwhile :; do echo m8b-flood-m8b-flood-m8b-flood-m8b-flood; done\n',
    );
    const flooded = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
    });

    expect(flooded.state).toBe('local');
    expect(flooded.archive.state).toBe('unavailable');
    expect(flooded.reason).toContain('maxBuffer');
    expect(flooded.reason).not.toContain('timed out');

    // A string code that is not ENOENT/EACCES (the maxBuffer abort) means
    // rclone ran: unavailable, never "never ran".
    const buffered = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
      run: async () => ({
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        stderr: 'maxBuffer exceeded',
      }),
    });
    expect(buffered.archive.state).toBe('unavailable');
    expect(buffered.reason).toContain('maxBuffer');

    const absent = await runMeasurementArchive({
      bundleDir: bundle,
      target: TARGET,
      host: 'triton',
      run: async () => ({ code: 'ENOENT' }),
    });
    expect(absent.archive.state).toBe('unknown');
  });

  test('only the execFile timeout kill is labelled a timeout', () => {
    // killed is execFile reporting the kill it performed itself — in this
    // wrapper the 5-minute timeout, which a test cannot wait out. The exact
    // mapping is pinned on the shapes child_process reports for each death
    // (probed: timeout kill, external signal, maxBuffer abort).
    const timeout = mapRcloneFailure({ killed: true, signal: 'SIGTERM', code: null }, [
      'lsf',
      TARGET,
    ]);
    expect(timeout.code).toBe('timeout');
    expect(timeout.stderr).toContain('timed out');

    const killed = mapRcloneFailure({ killed: false, signal: 'SIGKILL', code: null }, [
      'copy',
      'src',
      'dst',
    ]);
    expect(killed.code).toBe('SIGKILL');
    expect(killed.stderr).toBe('rclone copy was killed by SIGKILL');

    const buffered = mapRcloneFailure(
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'stdout maxBuffer length exceeded' },
      ['lsf', TARGET],
    );
    expect(buffered.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(buffered.stderr).toContain('maxBuffer');

    const missing = mapRcloneFailure({ code: 'ENOENT' }, ['lsf', TARGET]);
    expect(missing.code).toBe('ENOENT');
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

// Real-rclone probes for the commit marker's immutability. A fake runner can
// only encode the assumption; these run the actual binary. Single-file copyto
// skips the --immutable check entirely (rclone issue #4921), so the marker is
// a directory-scope copy filtered to /manifest.json. Hermetic: the alias
// remote lives in a temp RCLONE_CONFIG the spawned rclone alone reads — no
// ambient config, no credentials, no network — and both roots are cleaned.
const rclonePresent = (() => {
  try {
    execFileSync('rclone', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('M8b real-rclone commit-marker immutability', () => {
  /** A built bundle plus an archive root reached through an alias remote. */
  async function realRcloneWorkspace(runId: string): Promise<{
    bundle: string;
    target: string;
    remoteManifest: string;
  }> {
    const base = await workspace();
    const remoteRoot = join(base, 'remote');
    // The archive root must exist: lsf on a missing directory fails and the
    // wrapper would stop before any copy.
    await mkdir(join(remoteRoot, 'crq'), { recursive: true });
    vi.stubEnv('RCLONE_CONFIG', join(base, 'rclone.conf'));
    await writeFile(join(base, 'rclone.conf'), `[m8btest]\ntype = alias\nremote = ${remoteRoot}\n`);
    const bundle = await bundleIn(base, runId);
    return {
      bundle,
      target: 'm8btest:crq',
      remoteManifest: join(remoteRoot, 'crq', 'triton', 'measurement', runId, 'manifest.json'),
    };
  }

  test.skipIf(!rclonePresent)(
    'a changed local manifest never overwrites the archived marker',
    async () => {
      const { bundle, target, remoteManifest } = await realRcloneWorkspace('run-m8b-real-local');
      // First push archives the whole bundle through the real rclone.
      const first = await runMeasurementArchive({ bundleDir: bundle, target, host: 'triton' });
      expect(first.state).toBe('archived');
      const archived = await readFile(remoteManifest);

      // The payload is re-verified, but the changed manifest must fail the
      // marker copy instead of overwriting what was already archived. A
      // trailing newline keeps the manifest valid JSON for the local read.
      await writeFile(join(bundle, 'manifest.json'), `${archived.toString()}\n`);
      const rerun = await runMeasurementArchive({ bundleDir: bundle, target, host: 'triton' });

      expect(rerun.state).toBe('local');
      expect(rerun.reason).toContain('immutable file modified');
      expect(await readFile(remoteManifest)).toEqual(archived);
    },
  );

  test.skipIf(!rclonePresent)('a tampered remote manifest is never overwritten', async () => {
    const { bundle, target, remoteManifest } = await realRcloneWorkspace('run-m8b-real-remote');
    const first = await runMeasurementArchive({ bundleDir: bundle, target, host: 'triton' });
    expect(first.state).toBe('archived');

    // A tampered archive manifest: the re-run must fail loudly and leave the
    // remote bytes exactly as they were left.
    const tampered = Buffer.from('{"bundleVersion":1,"runId":"run-m8b-real-remote","x":1}\n');
    await writeFile(remoteManifest, tampered);
    const rerun = await runMeasurementArchive({ bundleDir: bundle, target, host: 'triton' });

    expect(rerun.state).toBe('local');
    expect(rerun.reason).toContain('immutable file modified');
    expect(await readFile(remoteManifest)).toEqual(tampered);
  });
});
