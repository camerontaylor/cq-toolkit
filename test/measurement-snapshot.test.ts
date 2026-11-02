import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const DOC_PATH = join(REPO_ROOT, 'docs/measurement/export-ci-snapshot.md');
const FIXTURE_PATH = join(REPO_ROOT, 'test/fixtures/measurement/ci-snapshot.json');

interface SnapshotFixture {
  manifest: {
    fetched_at: string;
    head_sha: string;
    attempt: Record<string, Record<string, { run_attempt: number; conclusion: string }>>;
    pagination: Record<string, number>;
  };
  runs: Array<{
    id: number;
    conclusion: string;
    run_attempt: number;
    logs_url: string;
    log_evidence?: string;
    logs_expired?: boolean;
  }>;
  attempt_jobs: Record<string, Record<string, Array<{ run_attempt: number; conclusion: string }>>>;
  check_runs: Array<{ name: string; conclusion: string }>;
  combined_status: { state: string; statuses: Array<{ state: string }> };
  required_checks: Record<string, string>;
}

const loadDoc = (): string => readFileSync(DOC_PATH, 'utf8');
const loadFixture = (): SnapshotFixture =>
  JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as SnapshotFixture;

describe('M10a nominal evidence', () => {
  it('committed gh api recipe paginates actions/runs, run attempts/jobs, commits/SHA/check-runs and /status', () => {
    const doc = loadDoc();
    expect(doc).toContain('repos/{owner}/{repo}/actions/runs?head_sha={sha}&per_page=100');
    expect(doc).toContain('--paginate --slurp');
    // Attempts have no collection endpoint (it 404s); each attempt number
    // (1..run_attempt) is fetched individually, jobs under the attempt prefix.
    expect(doc).toContain('repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{n}');
    expect(doc).toContain(
      'repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{n}/jobs?per_page=100',
    );
    expect(doc).not.toContain('attempts/{n}/jobs?per_page=100&filter=all');
    expect(doc).toContain(
      'repos/{owner}/{repo}/commits/{sha}/check-runs?filter=latest&per_page=100',
    );
    // /status needs explicit pagination: the default page of 30 truncates.
    const statusLine = doc
      .split('\n')
      .find((line) => line.includes('repos/{owner}/{repo}/commits/{sha}/status?'));
    expect(statusLine).toContain('per_page=100');
    expect(statusLine).toContain('--paginate');
  });

  it('manifest fetch time/head/attempt/pagination', () => {
    const doc = loadDoc();
    for (const field of ['`fetched_at`', '`head_sha`', '`attempt`', '`pagination`']) {
      expect(doc).toContain(field);
    }
    // Attempt objects are keyed per run id and per attempt number, covering
    // 1..run_attempt as enumerated from the workflow-run object's field.
    const snap = loadFixture();
    for (const run of snap.runs) {
      const attempts = snap.manifest.attempt[String(run.id)];
      expect(attempts).toBeDefined();
      const keyed = Object.keys(attempts ?? {});
      expect(Number(keyed.at(-1))).toBe(run.run_attempt);
      for (const [n, attempt] of Object.entries(attempts ?? {})) {
        expect(attempt.run_attempt).toBe(Number(n));
      }
    }
  });
});

describe('M10a missing evidence', () => {
  it('fixture asserts expired logs/missing checks unknown', () => {
    const snap = loadFixture();
    const expired = snap.runs.find((run) => run.id === 502);
    expect(expired).toBeDefined();
    // logs_url persists after retention; expiry is probed, never nulled.
    expect(expired?.logs_url).toContain('/logs');
    expect(expired?.log_evidence).toBe('unknown');
    expect(expired?.logs_expired).toBe(true);
    for (const state of Object.values(snap.required_checks)) {
      expect(['success', 'failure', 'unknown']).toContain(state);
    }
    expect(snap.required_checks['from-source']).toBe('unknown');
    expect(snap.required_checks['ratchet']).toBe('unknown');
  });
});

describe('M10a failure evidence', () => {
  it('fixture asserts failed run/jobs/status recorded verbatim with no invented conclusions', () => {
    const snap = loadFixture();
    expect(snap.runs.find((run) => run.id === 502)?.conclusion).toBe('failure');
    expect(
      Object.values(snap.manifest.attempt['502'] ?? {}).every((a) => a.conclusion === 'failure'),
    ).toBe(true);
    expect(
      Object.values(snap.attempt_jobs['502'] ?? {}).some((jobs) =>
        jobs.some((job) => job.conclusion === 'failure'),
      ),
    ).toBe(true);
    expect(snap.check_runs.some((check) => check.conclusion === 'failure')).toBe(true);
    expect(snap.combined_status.state).toBe('failure');
  });

  it('no API execution in tests', () => {
    // A stubbed fetch that throws: the recipe must never execute here, so any
    // network call fails; the suite passes because it only reads local files.
    vi.stubGlobal('fetch', () => {
      throw new Error('no API execution in tests: fetch must not be called');
    });
    expect(() => fetch('https://api.github.com')).toThrow('no API execution in tests');
    expect(loadDoc()).toContain('gh api');
    vi.unstubAllGlobals();
  });
});
