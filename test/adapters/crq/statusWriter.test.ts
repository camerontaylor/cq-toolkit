// Real-filesystem tests for the crq.write_status adapter: strict reads,
// plain writes for status.md/status.json, the paseo schedule probe through
// the injected command port, the summary publish through the shared A1
// pipeline, and the summary_failed event isolation.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStatusWriter } from '../../../src/adapters/crq/statusWriter.js';
import { fileStatusWriterEffects } from '../../../src/adapters/crq/statusWriter.js';
import { resolveComposerSeams } from '../../../src/adapters/crq/statusWriter.js';
import { parseCrqState } from '../../../src/policy/crq/state.js';

const NOW = 1_763_000_000;
const NOW_STAMP = '2025-11-13T02:13:20Z';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRoots(): Promise<{
  runnerRoot: string;
  stateRoot: string;
  xdgStateHome: string;
  home: string;
}> {
  const runnerRoot = await mkdtemp(join(tmpdir(), 'crq-status-runner-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'crq-status-state-'));
  const xdgStateHome = await mkdtemp(join(tmpdir(), 'crq-status-xdg-'));
  cleanups.push(runnerRoot, stateRoot, xdgStateHome);
  await mkdir(join(stateRoot, 'receipts'), { recursive: true });
  return { runnerRoot, stateRoot, xdgStateHome, home: '/unused-home' };
}

const CONFIG = {
  repo: 'owner/main',
  max_starts_per_hour: 12,
  merged_min_survival: 0.5,
  merged_min_surviving_lines: 10,
  error_backoff_min: 30,
};

const QUEUE = {
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

async function seedRoots(stateRoot: string, runnerRoot: string): Promise<void> {
  await writeFile(join(stateRoot, 'queue.json'), `${JSON.stringify(QUEUE, null, 2)}\n`);
  await writeFile(join(runnerRoot, 'config.json'), `${JSON.stringify(CONFIG, null, 2)}\n`);
  await writeFile(
    join(stateRoot, 'events.jsonl'),
    `{"at": "2025-11-13T01:00:10Z", "event": "tick", "detail": "ok"}\n`,
  );
}

describe('runStatusWriter over a real state root', () => {
  it('writes status.md and a schema-valid status.json, then prints the markdown', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runStatusWriter(
      roots,
      {
        write: (text) => stdout.push(text),
        error: (text) => stderr.push(text),
      },
      () => NOW,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const markdown = stdout.join('');
    expect(markdown).toContain(`# CodeRabbit review queue — status (${NOW_STAMP})`);
    expect(markdown).toContain('- queue: active');
    expect(markdown).toContain('- open-PR CLI reviews still owed: 1');
    expect(markdown).toContain('| pr101 |  | open t1 | pending | 0/1 |');
    expect(markdown).toContain('- last tick: 2025-11-13T01:00:00Z');

    const writtenMarkdown = await readFile(join(roots.stateRoot, 'status.md'), 'utf8');
    expect(writtenMarkdown).toBe(`${markdown}\n`);

    const statusText = await readFile(join(roots.stateRoot, 'status.json'), 'utf8');
    expect(statusText.endsWith('\n')).toBe(true);
    const accepted = parseCrqState('status.schema.json', statusText);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      const document = accepted.value as Record<string, unknown>;
      expect(document['generated_at']).toBe(NOW_STAMP);
      expect(document['paused']).toBe(false);
      const items = document['items'] as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0]!['id']).toBe('pr101');
      expect(items[0]!['repo']).toBe('owner/main');
    }
  });

  it('publishes the summary through the shared pipeline with schema_version 2', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    const exitCode = await runStatusWriter(roots, { write: () => {}, error: () => {} }, () => NOW);
    expect(exitCode).toBe(0);
    const summaryPath = join(roots.xdgStateHome, 'crq', 'summary.json');
    const summaryText = await readFile(summaryPath, 'utf8');
    expect(summaryText.endsWith('\n')).toBe(true);
    const summary = JSON.parse(summaryText) as Record<string, unknown>;
    expect(summary['schema_version']).toBe(2);
    expect(summary['generated_at']).toBe(NOW_STAMP);
    expect(summary['last_tick']).toBe('2025-11-13T01:00:00Z');
    expect(summary['schedule']).toEqual({ id: 'crq-tick.timer', state: 'systemd' });
  });

  it('isolates a publish failure into the summary_failed event', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    // A queue without a last tick makes the summary composer refuse (the
    // producer's ValueError path) while the status writes still succeed.
    const unticked = { ...QUEUE, last_tick: undefined };
    await writeFile(join(roots.stateRoot, 'queue.json'), `${JSON.stringify(unticked)}\n`);
    const exitCode = await runStatusWriter(roots, { write: () => {}, error: () => {} }, () => NOW);
    expect(exitCode).toBe(0);
    const events = await readFile(join(roots.stateRoot, 'events.jsonl'), 'utf8');
    const lines = events.trimEnd().split('\n');
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(last['event']).toBe('summary_failed');
    expect(typeof last['error']).toBe('string');
    // The status artifacts still exist: the failure is publish-local.
    await expect(readFile(join(roots.stateRoot, 'status.md'), 'utf8')).resolves.toContain(
      '# CodeRabbit review queue',
    );
  });

  it('refuses a corrupt queue with the schema message and exit 1', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    await writeFile(join(roots.stateRoot, 'queue.json'), '{"items": "not-a-list"}');
    const stderr: string[] = [];
    const exitCode = await runStatusWriter(
      roots,
      { write: () => {}, error: (text) => stderr.push(text) },
      () => NOW,
    );
    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('status-writer:');
    expect(stderr.join('')).toContain('rejected');
  });

  it('passes queue.json and events.jsonl bytes through unmodified on success', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    const beforeQueue = await readFile(join(roots.stateRoot, 'queue.json'), 'utf8');
    const beforeEvents = await readFile(join(roots.stateRoot, 'events.jsonl'), 'utf8');
    await runStatusWriter(roots, { write: () => {}, error: () => {} }, () => NOW);
    expect(await readFile(join(roots.stateRoot, 'queue.json'), 'utf8')).toBe(beforeQueue);
    expect(await readFile(join(roots.stateRoot, 'events.jsonl'), 'utf8')).toBe(beforeEvents);
  });

  it('binds the paseo schedule probe through the injected command port', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    await writeFile(
      join(roots.runnerRoot, 'config.json'),
      `${JSON.stringify({ ...CONFIG, schedule_id: 'crq-tick' }, null, 2)}\n`,
    );
    const effects = fileStatusWriterEffects(
      roots,
      async (argv) => (argv[1] === 'schedule' ? '{"status":"active","nextRunAt":"soon"}' : null),
      () => NOW,
    );
    const seams = await resolveComposerSeams(roots.stateRoot);
    const { writeStatus } = await import('../../../src/ops/crq/statusWriter.js');
    const result = await writeStatus({ ...effects, composerSeams: seams });
    expect(result.markdown).toContain(
      '- schedule: `crq-tick` active · next run soon · last run None',
    );
  });

  it('keeps the composer seam reads on the state root', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    const seams = await resolveComposerSeams(roots.stateRoot);
    expect(seams.triageRows).toEqual([]);
    expect(seams.inbox.entries).toEqual([]);
  });
});
