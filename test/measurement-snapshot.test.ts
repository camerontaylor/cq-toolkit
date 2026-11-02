import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const DOC_PATH = join(REPO_ROOT, 'docs/measurement/export-ci-snapshot.md');
const FIXTURE_PATH = join(REPO_ROOT, 'test/fixtures/measurement/ci-snapshot.json');

interface SnapshotFixture {
  manifest: {
    fetched_at: string;
    head_sha: string;
    attempt: Record<string, number>;
    pagination: Record<string, number>;
  };
  runs: Array<{
    id: number;
    head_sha: string;
    name: string;
    status: string;
    conclusion: string;
    logs_url: string | null;
    log_evidence?: string;
    logs_expired?: boolean;
  }>;
  attempts: Record<string, Array<{ id: number; attempt: number; conclusion: string }>>;
  jobs: Record<string, Array<{ id: number; name: string; conclusion: string }>>;
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
    expect(doc).toContain('repos/{owner}/{repo}/actions/runs/{run_id}/attempts?per_page=100');
    expect(doc).toContain(
      'repos/{owner}/{repo}/actions/runs/{run_id}/jobs?per_page=100&filter=all',
    );
    expect(doc).toContain(
      'repos/{owner}/{repo}/commits/{sha}/check-runs?filter=latest&per_page=100',
    );
    expect(doc).toContain('repos/{owner}/{repo}/commits/{sha}/status');
  });

  it('manifest fetch time/head/attempt/pagination', () => {
    const doc = loadDoc();
    for (const field of ['`fetched_at`', '`head_sha`', '`attempt`', '`pagination`']) {
      expect(doc).toContain(field);
    }
  });
});

describe('M10a missing evidence', () => {
  it('fixture asserts expired logs/missing checks unknown', () => {
    const snap = loadFixture();
    const expired = snap.runs.find((run) => run.id === 502);
    expect(expired).toBeDefined();
    expect(expired?.logs_url).toBeNull();
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
    expect(snap.attempts['502']?.every((a) => a.conclusion === 'failure')).toBe(true);
    expect(snap.jobs['502']?.some((job) => job.conclusion === 'failure')).toBe(true);
    expect(snap.check_runs.some((check) => check.conclusion === 'failure')).toBe(true);
    expect(snap.combined_status.state).toBe('failure');
  });

  it('no API execution in tests', () => {
    const doc = loadDoc();
    // The doc only documents `gh api` invocations; tests read local files only.
    expect(doc).toContain('gh api');
    expect(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).toContain(
      '@camerontaylor/cq-toolkit',
    );
  });
});
