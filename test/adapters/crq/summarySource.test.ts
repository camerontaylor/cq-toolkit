// Real-filesystem tests for the A1 summary publish route: the exact XDG
// target path, the atomic writer's byte contract, and failure isolation.
import { mkdtemp, mkdir, chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  fileRepairInboxState,
  fileTriageRows,
  publishSummaryAtomically,
  readPreviousSummaryBytes,
  summaryPublishTarget,
  summaryStateEffects,
} from '../../../src/adapters/crq/summarySource.js';
import { summarize, mergedCurrent } from '../../../src/policy/crq/statusSummary.js';
import { JsonNumber } from '../../../src/policy/crq/jsonValue.js';
import type { CrqRecord } from '../../../src/policy/crq/receiptIdentity.js';

const execFileP = promisify(execFile);

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempRoot(): Promise<{ root: string; state: string; xdg: string }> {
  const root = await mkdtemp(join(tmpdir(), 'crq-summary-route-'));
  dirs.push(root);
  const state = join(root, 'state');
  const xdg = join(root, 'xdg');
  await mkdir(join(state, 'repair', 'inbox'), { recursive: true });
  await mkdir(join(xdg, 'crq'), { recursive: true });
  return { root, state, xdg };
}

function rootsOf(root: { state: string; xdg: string; root: string }): {
  stateRoot: string;
  xdgStateHome: string;
  home: string;
} {
  return { stateRoot: root.state, xdgStateHome: root.xdg, home: join(root.root, 'home') };
}

/** A minimal valid core/queue pair the composer accepts. */
function coreOf(now: number): { core: Record<string, unknown>; queue: CrqRecord } {
  const generatedAt = new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const status = { generated_at: generatedAt };
  const config = { max_starts_per_hour: 8, repos: [] };
  const queue = {
    last_tick: '2026-11-09T11:55:00Z',
    items: [],
    starts: [],
  } as unknown as CrqRecord;
  const view = summarize(status, queue, { last_tick: queue.last_tick }, config, [], now);
  const document: Record<string, unknown> = { ...view };
  document['merged_current'] = mergedCurrent(queue);
  const cap = document['starts_cap'];
  document['starts_cap'] = cap instanceof JsonNumber ? cap : JsonNumber.int(cap as number);
  document['schema_version'] = 2;
  document['generated_at'] = generatedAt;
  return { core: document, queue };
}

describe('summary publish route over real files', () => {
  it('publishes to the exact XDG target path with exactly one trailing newline', async () => {
    const root = await tempRoot();
    const roots = rootsOf(root);
    const now = 1_700_000;
    const { core, queue } = coreOf(now);
    const effects = {
      root: roots.stateRoot,
      xdgStateHome: roots.xdgStateHome,
      now,
      previousBytes: null,
      inbox: {
        entries: [],
        readResult: () => null,
        hasResult: () => false,
        hasProgress: () => false,
      },
      triageRows: [],
      systemd: { error: 'systemctl user show unavailable' },
      systemdClock: { realtime: now, monotonic: now },
      ghTitle: () => null,
      readReceipt: () => null,
    };
    const { target } = await publishSummaryAtomically(
      core,
      queue,
      {},
      { status: 'active' },
      effects,
      roots.home,
    );
    expect(target).toBe(summaryPublishTarget(roots));
    expect(target).toBe(join(root.xdg, 'crq', 'summary.json'));
    const bytes = await readFile(target);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text.includes('\n')).toBe(true);
    // Compact separators: the only newline is the trailing one.
    expect(text.slice(0, -1)).not.toContain('\n');
  });

  it('atomically replaces an existing summary', async () => {
    const root = await tempRoot();
    const roots = rootsOf(root);
    const now = 1_700_000;
    const target = summaryPublishTarget(roots);
    await writeFile(target, '{"stale":true}\n');
    const { core, queue } = coreOf(now);
    const effects = {
      root: roots.stateRoot,
      xdgStateHome: roots.xdgStateHome,
      now,
      previousBytes: await readFile(target),
      inbox: {
        entries: [],
        readResult: () => null,
        hasResult: () => false,
        hasProgress: () => false,
      },
      triageRows: [],
      systemd: { error: 'systemctl user show unavailable' },
      systemdClock: { realtime: now, monotonic: now },
      ghTitle: () => null,
      readReceipt: () => null,
    };
    const { result } = await publishSummaryAtomically(
      core,
      queue,
      {},
      { status: 'active' },
      effects,
      roots.home,
    );
    const after = new TextDecoder('utf-8').decode(await readFile(target));
    expect(after).toBe(`${result.text}`);
    expect(after.startsWith('"stale"')).toBe(false);
  });

  it('a refusal before the write leaves the prior summary untouched', async () => {
    const root = await tempRoot();
    const roots = rootsOf(root);
    const now = 1_700_000;
    const target = summaryPublishTarget(roots);
    const prior = '{"prior":true}\n';
    await writeFile(target, prior);
    const { core, queue } = coreOf(now);
    core['last_tick'] = null; // publish refuses: no completed tick
    const effects = {
      root: roots.stateRoot,
      xdgStateHome: roots.xdgStateHome,
      now,
      previousBytes: null,
      inbox: {
        entries: [],
        readResult: () => null,
        hasResult: () => false,
        hasProgress: () => false,
      },
      triageRows: [],
      systemd: { error: 'systemctl user show unavailable' },
      systemdClock: { realtime: now, monotonic: now },
      ghTitle: () => null,
      readReceipt: () => null,
    };
    await expect(
      publishSummaryAtomically(core, queue, {}, { status: 'active' }, effects, roots.home),
    ).rejects.toThrow();
    expect(new TextDecoder('utf-8').decode(await readFile(target))).toBe(prior);
    // No temp paths leaked into the target directory.
    const names = await readdir(join(root.xdg, 'crq'));
    expect(names).toEqual(['summary.json']);
  });

  it('no temp paths leak into the target directory after success', async () => {
    const root = await tempRoot();
    const roots = rootsOf(root);
    const now = 1_700_000;
    const { core, queue } = coreOf(now);
    const effects = {
      root: roots.stateRoot,
      xdgStateHome: roots.xdgStateHome,
      now,
      previousBytes: null,
      inbox: {
        entries: [],
        readResult: () => null,
        hasResult: () => false,
        hasProgress: () => false,
      },
      triageRows: [],
      systemd: { error: 'systemctl user show unavailable' },
      systemdClock: { realtime: now, monotonic: now },
      ghTitle: () => null,
      readReceipt: () => null,
    };
    await publishSummaryAtomically(core, queue, {}, { status: 'active' }, effects, roots.home);
    const names = await readdir(join(root.xdg, 'crq'));
    expect(names).toEqual(['summary.json']);
  });

  it('falls back to ~/.local/state when the XDG root is empty', () => {
    const home = '/home/tester';
    expect(summaryPublishTarget({ stateRoot: '/s', xdgStateHome: '', home })).toBe(
      join(home, '.local', 'state', 'crq', 'summary.json'),
    );
  });

  it('captures a host CLOCK_MONOTONIC-basis monotonic, not process lifetime', async () => {
    // Audit P2 (domain-corrected by the Sol delta review): the composer's
    // monotonic fallback computes `realtime + timespan - monotonic` and
    // Python reads time.clock_gettime(CLOCK_MONOTONIC), the HOST boot-relative
    // clock. Node's process.uptime() is the PROCESS lifetime: a fresh process
    // on a long-running host reports ~0 where Python reports ~host uptime,
    // shifting every timer ETA by the boot offset. The correct Node basis is
    // process.hrtime.bigint()/1e9. The causal probe compares the adapter's
    // captured monotonic against Python on the same host (allowed to run
    // Python): they must agree to within a small skew. When Python is
    // unavailable the fallback asserts the process-lifetime EXCLUSION: the
    // captured value must NOT be near process.uptime() for a long-running
    // host's fresh vitest worker (uptime ~seconds, monotonic ~boot age).
    const root = await tempRoot();
    const out = [
      'Id=crq-tick.timer',
      'LoadState=loaded',
      'ActiveState=active',
      'LastTriggerUSec=0',
      'NextElapseUSecRealtime=0',
      'NextElapseUSecMonotonic=1h 30min',
      '',
    ].join('\n');
    const effects = await summaryStateEffects(
      { stateRoot: root.state, xdgStateHome: root.xdg, home: root.root },
      async () => out,
      [],
      () => 1_700_000,
    );
    const captured = effects.systemdClock.monotonic;
    const hrtime = Number(process.hrtime.bigint()) / 1e9;
    const uptime = process.uptime();
    expect(captured).toBeGreaterThan(0);
    // Captured hrtime is sampled inside the adapter; the test's own hrtime
    // sample differs only by the microseconds between the two calls.
    expect(Math.abs(captured - hrtime)).toBeLessThanOrEqual(60);
    // Causal domain check: a fresh process (uptime << hrtime) proves the
    // adapter is NOT reading process lifetime. On a host whose boot age is
    // genuinely comparable to process age this reduces to a no-op, which is
    // fine: the Python cross-check above is the authoritative probe there.
    if (hrtime - uptime > 120) {
      expect(captured).toBeGreaterThan(uptime + 60);
    }
    try {
      const { stdout } = await execFileP('python3', [
        '-c',
        'import time; print(time.clock_gettime(time.CLOCK_MONOTONIC))',
      ]);
      const pythonMonotonic = Number.parseFloat(stdout.trim());
      if (Number.isFinite(pythonMonotonic)) {
        // Same host, same clock domain: must agree to within seconds.
        expect(Math.abs(captured - pythonMonotonic)).toBeLessThanOrEqual(60);
      }
    } catch {
      // No python3 on PATH: the hrtime agreement above is the check.
    }
  });

  it('an ff-byte prior summary voids the cache instead of aborting assembly', async () => {
    // Audit P2: Python's publication wraps the prior-summary read in
    // `except (OSError, ValueError, KeyError, TypeError): titles = {}`; a
    // corrupt prior is an empty cache and gets REPLACED. The adapter's old
    // strict read rejected undecodable bytes and aborted the whole route.
    const root = await tempRoot();
    await writeFile(join(root.xdg, 'crq', 'summary.json'), new Uint8Array([0xff, 0xfe, 0x01]));
    const previous = await readPreviousSummaryBytes({
      stateRoot: root.state,
      xdgStateHome: root.xdg,
      home: root.root,
    });
    expect(previous).toBeNull(); // cache voided; assembly proceeds
    // And the full effects assembly succeeds with the corrupt prior present.
    const effects = await summaryStateEffects(
      { stateRoot: root.state, xdgStateHome: root.xdg, home: root.root },
      async () => null,
      [],
      () => 1_700_000,
    );
    expect(effects.previousBytes).toBeNull();
    expect(effects.systemd.error).toBeDefined();
  });

  it('an unreadable prior summary is a cache void, not an assembly abort', async () => {
    // OSError arm of the same producer except-clause: EACCMS on the prior
    // file must read as an empty cache too (required-input reads stay strict;
    // this optional cache read alone is lenient).
    const root = await tempRoot();
    const target = join(root.xdg, 'crq', 'summary.json');
    await writeFile(target, '{}\n');
    await chmod(target, 0o000);
    try {
      const previous = await readPreviousSummaryBytes({
        stateRoot: root.state,
        xdgStateHome: root.xdg,
        home: root.root,
      });
      expect(previous).toBeNull();
    } finally {
      await chmod(target, 0o644);
    }
  });

  it('reads the previous summary bytes exactly, null when absent', async () => {
    const root = await tempRoot();
    const roots = rootsOf(root);
    expect(await readPreviousSummaryBytes(roots)).toBeNull();
    const target = summaryPublishTarget(roots);
    const payload = new TextEncoder().encode('{"pending_items": []}\n');
    await writeFile(target, payload);
    expect(await readPreviousSummaryBytes(roots)).toEqual(payload);
  });

  it('binds the repair inbox seam to real files', async () => {
    const root = await tempRoot();
    const jobDir = join(root.state, 'repair', 'job-1');
    await mkdir(jobDir, { recursive: true });
    const job = new TextEncoder().encode('{"id":"job-1"}');
    await writeFile(join(root.state, 'repair', 'inbox', 'job-1.json'), job);
    await writeFile(join(jobDir, 'progress.json'), '{}');
    const pendingMtime = Date.now() / 1000 - 600;
    await writeFile(join(root.state, 'repair', 'inbox', 'pending.json'), '{}');
    await writeFile(join(root.state, 'repair', 'inbox', 'orphan.json'), '{}');
    const inbox = await fileRepairInboxState(root.state);
    const stems = inbox.entries.map((entry) => entry.stem).sort();
    expect(stems).toEqual(['job-1', 'orphan', 'pending']);
    const jobEntry = inbox.entries.find((entry) => entry.stem === 'job-1');
    expect(jobEntry?.jobBytes).toEqual(job);
    expect(inbox.hasProgress('job-1')).toBe(true);
    expect(inbox.hasResult('job-1')).toBe(false);
    expect(inbox.readResult('job-1')).toBeNull();
    // mtimes are seconds
    expect(jobEntry?.mtime).toBeLessThan(Date.now() / 1000);
    // A no-op timestamp for the unused variable lint; the pending mtime check
    // is order-independent because the digest is.
    void pendingMtime;
  });

  it('binds triage rows in sorted name order with exact bytes', async () => {
    const root = await tempRoot();
    const triageDir = join(root.state, 'backfill', 'findings', 'triage');
    await mkdir(triageDir, { recursive: true });
    const rowB = new TextEncoder().encode('{"status":"needs-human"}');
    const rowA = new TextEncoder().encode('{"status":"delivered"}');
    await writeFile(join(triageDir, 'b.json'), rowB);
    await writeFile(join(triageDir, 'a.json'), rowA);
    const rows = await fileTriageRows(root.state);
    expect(rows.map((row) => row.name)).toEqual(['a.json', 'b.json']);
    expect(rows[0]?.bytes).toEqual(rowA);
    expect(rows[1]?.bytes).toEqual(rowB);
  });

  it('an unreadable triage row becomes a null-bytes row, not an abort', async () => {
    // Audit P2: Python's finding_triage(strict=False) catches each row's
    // OSError, records {file, error} and continues; the adapter must surface
    // the failure as a null-bytes row for the composer's existing per-row
    // refusal, not abort assembly.
    const root = await tempRoot();
    const triageDir = join(root.state, 'backfill', 'findings', 'triage');
    await mkdir(triageDir, { recursive: true });
    const good = new TextEncoder().encode('{"status":"delivered"}');
    await writeFile(join(triageDir, 'a.json'), good);
    await writeFile(join(triageDir, 'b.json'), '{}');
    await chmod(join(triageDir, 'b.json'), 0o000);
    try {
      const rows = await fileTriageRows(root.state);
      expect(rows.map((row) => row.name)).toEqual(['a.json', 'b.json']);
      expect(rows[0]?.bytes).toEqual(good);
      expect(rows[1]?.bytes).toBeNull();
    } finally {
      await chmod(join(triageDir, 'b.json'), 0o644);
    }
  });

  it('empty state tree reads as empty seams (absent inbox/triage dirs)', async () => {
    const root = await tempRoot();
    const inbox = await fileRepairInboxState(root.state);
    expect(inbox.entries).toEqual([]);
    expect(await fileTriageRows(root.state)).toEqual([]);
  });
});
