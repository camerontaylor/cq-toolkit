// Real-filesystem tests for the A1 summary publish route: the exact XDG
// target path, the atomic writer's byte contract, and failure isolation.
import { mkdtemp, mkdir, chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { systemdActivity } from '../../../src/policy/crq/publishEffects.js';
import { summarize, mergedCurrent } from '../../../src/policy/crq/statusSummary.js';
import { JsonNumber } from '../../../src/policy/crq/jsonValue.js';
import type { CrqRecord } from '../../../src/policy/crq/receiptIdentity.js';

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

  it('captures a real monotonic clock with the probe (nonzero, boot-relative)', async () => {
    // Audit P2: the composer's monotonic fallback computes
    // `realtime + timespan - monotonic`; with the adapter's old hardcoded
    // `monotonic: 0` every timer ETA was shifted by the boot offset. The
    // captured pair must match Python's
    // `time.time()` / `clock_gettime(CLOCK_MONOTONIC)` basis.
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
    const now = 1_794_471_730;
    const effects = await summaryStateEffects(
      { stateRoot: root.state, xdgStateHome: root.xdg, home: root.root },
      async () => out,
      [],
      () => now,
    );
    expect(effects.systemdClock.monotonic).toBeGreaterThan(0);
    expect(effects.systemdClock.monotonic).toBeLessThanOrEqual(process.uptime() + 5);
    expect(effects.systemdClock.realtime).toBeGreaterThan(now);
    const activity = systemdActivity(effects.systemd, effects.systemdClock);
    const tick = activity.timers['crq-tick.timer'];
    expect(tick?.next_elapse).not.toBeNull();
    // The ETA must equal realtime + 5400s - monotonic: within a few seconds
    // of capture-time + 90min minus uptime, NOT capture-time + 90min (the
    // shifted value). The adapter's clock is captured with Date.now(), so
    // anchor on the captured realtime rather than the injected now(); the
    // gap between the two is bounded by the test run itself.
    const capturedRealtime = effects.systemdClock.realtime;
    const expected = Math.floor(capturedRealtime + 5400 - process.uptime());
    const text = tick?.next_elapse as string;
    const actual = Math.floor(new Date(`${text.slice(0, 19)}Z`).getTime() / 1000);
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(10);
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

  it('empty state tree reads as empty seams (absent inbox/triage dirs)', async () => {
    const root = await tempRoot();
    const inbox = await fileRepairInboxState(root.state);
    expect(inbox.entries).toEqual([]);
    expect(await fileTriageRows(root.state)).toEqual([]);
  });
});
