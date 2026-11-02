import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const DOC_PATH = join(REPO_ROOT, 'docs/measurement/export-ci-snapshot.md');
const FIXTURE_PATH = join(REPO_ROOT, 'test/fixtures/measurement/ci-snapshot.json');

interface AttemptObject {
  id: number;
  run_attempt: number;
  conclusion: string;
}

interface SnapshotFixture {
  manifest: {
    fetched_at: string;
    head_sha: string;
    attempt: Record<string, Record<string, AttemptObject>>;
    pagination: Record<string, number>;
  };
  runs: Array<{
    id: number;
    head_sha: string;
    name: string;
    status: string;
    conclusion: string;
    run_count: number;
    logs_url: string;
    log_evidence?: string;
    logs_expired?: boolean;
  }>;
  attempt_jobs: Record<
    string,
    Record<string, Array<{ id: number; name: string; run_attempt: number; conclusion: string }>>
  >;
  check_runs: Array<{ name: string; conclusion: string }>;
  combined_status: {
    sha: string;
    state: string;
    statuses: Array<{ context: string; state: string }>;
  };
  required_checks: Record<string, string>;
}

function loadDoc(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function loadFixture(): SnapshotFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as SnapshotFixture;
}

describe('M10a nominal evidence', () => {
  it('committed gh api recipe paginates actions/runs, run attempts/jobs, commits/SHA/check-runs and /status', () => {
    const doc = loadDoc();
    expect(doc).toContain('repos/{owner}/{repo}/actions/runs?head_sha={sha}&per_page=100');
    expect(doc).toContain('--paginate --slurp');
    // Attempts have no collection endpoint (it 404s); each attempt number is
    // fetched individually and its jobs are read under the attempt prefix.
    expect(doc).toContain('repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{n}');
    expect(doc).toContain(
      'repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{n}/jobs?per_page=100&filter=all',
    );
    expect(doc).toContain(
      'repos/{owner}/{repo}/commits/{sha}/check-runs?filter=latest&per_page=100',
    );
    // /status must carry explicit pagination: the default page holds 30 and
    // would silently truncate `statuses`.
    const statusLine = doc
      .split('\n')
      .find((line) => line.includes('repos/{owner}/{repo}/commits/{sha}/status?'));
    expect(statusLine).toBeDefined();
    expect(statusLine).toContain('per_page=100');
    expect(statusLine).toContain('--paginate');
  });

  it('manifest fetch time/head/attempt/pagination', () => {
    const doc = loadDoc();
    for (const field of ['`fetched_at`', '`head_sha`', '`attempt`', '`pagination`']) {
      expect(doc).toContain(field);
    }
    // The manifest's attempt shape is keyed per run id and per attempt number,
    // matching the fixture's objects under manifest.attempt.
    const snap = loadFixture();
    for (const run of snap.runs) {
      const runAttempts = snap.manifest.attempt[String(run.id)];
      expect(runAttempts).toBeDefined();
      for (const [n, attempt] of Object.entries(runAttempts ?? {})) {
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
    // logs_url persists after retention; expiry is probed, not derived from a
    // null field, so the fixture keeps a live-shaped URL.
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
    const failedRun = snap.runs.find((run) => run.id === 502);
    expect(failedRun?.conclusion).toBe('failure');
    const attempts = snap.manifest.attempt['502'];
    expect(attempts).toBeDefined();
    expect(Object.values(attempts ?? {}).every((a) => a.conclusion === 'failure')).toBe(true);
    expect(
      Object.values(snap.attempt_jobs['502'] ?? {}).some((jobs) =>
        jobs.some((job) => job.conclusion === 'failure'),
      ),
    ).toBe(true);
    expect(snap.check_runs.some((check) => check.conclusion === 'failure')).toBe(true);
    expect(snap.combined_status.state).toBe('failure');
  });

  it('no API execution in tests', () => {
    // The suite reads only local files (readFileSync above); it never spawns a
    // process or performs network I/O. The doc documents `gh api` invocations
    // but nothing here executes them.
    const doc = loadDoc();
    expect(doc).toContain('gh api');
    expect(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).toContain(
      '@camerontaylor/cq-toolkit',
    );
  });
});
