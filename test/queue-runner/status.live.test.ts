// CLI-level acceptance for the operator-only `crq status` dispatch
// (`src/queue-runner/crq.ts`): the queue-runner binary's stdout contract is
// exactly one JSON document for every command, so the operator-readable
// markdown travels in the artifact's `value` field, never the stdout channel;
// the schedule probe runs through the injected command port (none of these
// fixtures have systemd units, so the probe is absent by default and the
// status write must not depend on it); unknown flags refuse with usage exit
// 2 before any state is touched.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/queue-runner/crq.js', import.meta.url));

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRunnerRoot(): Promise<{ runnerRoot: string; stateRoot: string }> {
  const runnerRoot = await mkdtemp(join(tmpdir(), 'crq-status-cli-runner-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'crq-status-cli-state-'));
  cleanups.push(runnerRoot, stateRoot);
  await mkdir(join(stateRoot, 'receipts'), { recursive: true });
  const config = {
    repo: 'owner/main',
    max_starts_per_hour: 12,
    merged_min_survival: 0.5,
    merged_min_surviving_lines: 10,
    error_backoff_min: 30,
    local_review_aging_minutes: 60,
  };
  const queue = {
    created_at: '2025-11-01T00:00:00Z',
    items: [
      {
        id: 'pr101',
        pr: 101,
        kind: 'open',
        tier: 1,
        order: 0,
        prior_cycles: 0,
        state: 'pending',
        cycles: [],
        attempts: [],
        notes: [],
      },
    ],
    starts: [],
    paused: false,
    author_requests: {},
    author_observations: [],
    last_tick: '2025-11-13T01:00:00Z',
  };
  await writeFile(join(runnerRoot, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(join(stateRoot, 'queue.json'), `${JSON.stringify(queue, null, 2)}\n`);
  await writeFile(join(stateRoot, 'events.jsonl'), '');
  return { runnerRoot, stateRoot };
}

describe('crq status dispatch (CLI contract)', () => {
  it('writes the artifacts and returns exactly one JSON document on stdout', async () => {
    const { runnerRoot, stateRoot } = await makeRunnerRoot();
    const result = spawnSync(process.execPath, [CLI, 'status', '--state-root', stateRoot], {
      cwd: runnerRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    // One JSON document: the runner's channel contract. The markdown is in
    // the artifact's value, not on stdout.
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const artifact = JSON.parse(lines[0]!) as { status: string; value?: { markdown?: string } };
    expect(artifact.status).toBe('ok');
    expect(artifact.value?.markdown).toContain('# CodeRabbit review queue');
    // The artifacts landed on the state root.
    const markdown = await readFile(join(stateRoot, 'status.md'), 'utf8');
    expect(markdown).toContain('| pr101 |  | open t1 | pending |');
    expect(markdown.endsWith('\n\n')).toBe(false);
  });

  it('refuses an unknown flag with usage exit 2 before writing anything', async () => {
    const { runnerRoot, stateRoot } = await makeRunnerRoot();
    const result = spawnSync(process.execPath, [CLI, 'status', '--json'], {
      cwd: runnerRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(2);
    const artifact = JSON.parse(result.stdout.trim()) as {
      error?: { kind: string; message: string };
    };
    expect(artifact.error?.kind).toBe('usage');
    expect(artifact.error?.message).toContain('unknown flag: --json');
    // Refusal precedes any artifact write.
    await expect(readFile(join(stateRoot, 'status.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('exits 1 with the status-writer refusal in the artifact, not on stderr', async () => {
    const { runnerRoot, stateRoot } = await makeRunnerRoot();
    await writeFile(join(stateRoot, 'queue.json'), '{"items": "not-a-list"}');
    const result = spawnSync(process.execPath, [CLI, 'status', '--state-root', stateRoot], {
      cwd: runnerRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    // I1: the refusal travels in the one JSON document; stderr stays empty.
    expect(result.stderr).toBe('');
    const artifact = JSON.parse(result.stdout.trim()) as { status: string; error?: string };
    expect(artifact.status).toBe('failed');
    expect(artifact.error).toContain('status-writer:');
  });
});

describe('crq summary dispatch (CLI contract, S1)', () => {
  async function addRepairItem(stateRoot: string): Promise<void> {
    const path = join(stateRoot, 'queue.json');
    const queue = JSON.parse(await readFile(path, 'utf8')) as { items: Record<string, unknown>[] };
    queue.items.push({
      id: 'pr102',
      pr: 102,
      kind: 'open',
      tier: 1,
      order: 1,
      prior_cycles: 0,
      state: 'pending',
      cycles: [],
      attempts: [],
      notes: [],
      repair_origin: 'run-1',
      repair_runs: {
        'run-1': {
          state: 'published',
          verdicts: [
            {
              job: 'run-1-F1',
              verdict: 'NOT-FIXED',
              finding: { path: 'src/a.ts', title: 'first' },
              reason: 'parses only stdout',
            },
            {
              job: 'run-1-F2',
              verdict: 'NOT-FIXED',
              finding: { path: 'src/b.ts', title: 'second' },
              reason: 'other',
            },
          ],
        },
      },
    });
    await writeFile(path, `${JSON.stringify(queue, null, 2)}\n`);
  }

  function runCli(
    command: string,
    runnerRoot: string,
    stateRoot: string,
    xdg: string,
  ): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [CLI, command, '--state-root', stateRoot], {
      cwd: runnerRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, XDG_STATE_HOME: xdg },
    });
  }

  it('publishes only summary.json and reports its path as one JSON document', async () => {
    const { runnerRoot, stateRoot } = await makeRunnerRoot();
    await addRepairItem(stateRoot);
    const xdg = await mkdtemp(join(tmpdir(), 'crq-summary-cli-xdg-'));
    cleanups.push(xdg);
    const result = runCli('summary', runnerRoot, stateRoot, xdg);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const artifact = JSON.parse(result.stdout.trim()) as {
      status: string;
      value?: { path?: string };
    };
    expect(artifact.status).toBe('ok');
    expect(artifact.value?.path).toBe(join(xdg, 'crq', 'summary.json'));
    // Unlike `status`, `summary` writes no status.md.
    await expect(readFile(join(stateRoot, 'status.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const summary = JSON.parse(await readFile(artifact.value!.path!, 'utf8')) as {
      schema_version?: number;
      pending_items: { pr: number; label?: string; repair_origin?: string }[];
    };
    expect(summary.schema_version).toBe(2);
    const fix = summary.pending_items.find((row) => row.pr === 102);
    expect(fix?.repair_origin).toBe('run-1');
    expect(fix?.label).toBe('src/a.ts: parses only stdout (+1)');
    expect(fix!.label!.length).toBeLessThanOrEqual(120);
  });

  it('writes the same summary.json as the summary stage of `status`', async () => {
    const { runnerRoot, stateRoot } = await makeRunnerRoot();
    await addRepairItem(stateRoot);
    const viaStatus = await mkdtemp(join(tmpdir(), 'crq-summary-cli-a-'));
    const viaSummary = await mkdtemp(join(tmpdir(), 'crq-summary-cli-b-'));
    cleanups.push(viaStatus, viaSummary);
    expect(runCli('status', runnerRoot, stateRoot, viaStatus).status).toBe(0);
    expect(runCli('summary', runnerRoot, stateRoot, viaSummary).status).toBe(0);
    const a = JSON.parse(await readFile(join(viaStatus, 'crq', 'summary.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const b = JSON.parse(await readFile(join(viaSummary, 'crq', 'summary.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    // Wall-clock stamps differ between the two runs; everything else is parity.
    for (const key of ['generated_at', 'status_as_of']) {
      delete a[key];
      delete b[key];
    }
    expect(b).toEqual(a);
  });

  it('refuses an unknown flag with usage exit 2 and writes nothing', async () => {
    const { runnerRoot } = await makeRunnerRoot();
    const xdg = await mkdtemp(join(tmpdir(), 'crq-summary-cli-xdg-'));
    cleanups.push(xdg);
    const result = spawnSync(process.execPath, [CLI, 'summary', '--bogus'], {
      cwd: runnerRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, XDG_STATE_HOME: xdg },
    });
    expect(result.status).toBe(2);
    await expect(readFile(join(xdg, 'crq', 'summary.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('exits 1 with the refusal in the artifact when the queue is invalid', async () => {
    const { runnerRoot, stateRoot } = await makeRunnerRoot();
    await writeFile(join(stateRoot, 'queue.json'), '{"items": "not-a-list"}');
    const xdg = await mkdtemp(join(tmpdir(), 'crq-summary-cli-xdg-'));
    cleanups.push(xdg);
    const result = runCli('summary', runnerRoot, stateRoot, xdg);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const artifact = JSON.parse(result.stdout.trim()) as { status: string; error?: string };
    expect(artifact.status).toBe('failed');
    expect(artifact.error).toContain('summary-writer:');
  });
});
