// CLI-level acceptance for the operator-only `crq status` dispatch
// (`src/queue-runner/crq.ts`): the queue-runner binary's stdout contract is
// exactly one JSON document for every command, so the operator-readable
// markdown travels in the artifact's `value` field, never the stdout channel;
// the schedule probe runs through the injected command port (none of these
// fixtures have systemd units, so the probe is absent by default and the
// status write must not depend on it); unknown flags refuse with usage exit
// 2 before any state is touched.
import { spawnSync } from 'node:child_process';
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

  it('exits 1 with the status-writer refusal on a corrupt queue', async () => {
    const { runnerRoot, stateRoot } = await makeRunnerRoot();
    await writeFile(join(stateRoot, 'queue.json'), '{"items": "not-a-list"}');
    const result = spawnSync(process.execPath, [CLI, 'status', '--state-root', stateRoot], {
      cwd: runnerRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('status-writer:');
    const artifact = JSON.parse(result.stdout.trim()) as { status: string };
    expect(artifact.status).toBe('failed');
  });
});
