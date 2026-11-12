import { rm } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import { fixture, git, input, reportOf, scripted } from './fix-run-shared.js';

test('pushFailed publishes only the failed-attempt branch with a CI-skip commit subject', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('fail-b-safe-change') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.outcome !== 'fixed');
    expect(failed?.failedAttempt?.branch).toMatch(/^cq\/fixture\/failed\//);
    const remote = await git(
      f.repo,
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${failed!.failedAttempt!.branch}`,
    );
    expect(remote.split(/\s+/)[0]).toBe(failed!.failedAttempt!.sha);
    expect(await git(f.repo, 'show', '-s', '--format=%s', failed!.failedAttempt!.sha)).toContain(
      '[skip ci]',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed scans the refused failed commit contents and keeps secret paths local', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('private-change') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    expect(result.status).toBe('needs-human');
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(failed.reason).toContain('failed-attempt publication refused');
    expect(await git(f.repo, 'show', `${failed.failedAttempt!.sha}:.env.config`)).toContain(
      'DO_NOT_UPLOAD',
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed keeps a failed branch local when its upload scan faults', async () => {
  const f = await fixture();
  vi.stubEnv('CQ_TEST_GITLEAKS_FAIL_ON', 'SCANNER_FAULT');
  try {
    const result = await makeFixRun({ drivers: scripted('scan-fault') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(result.status).toBe('needs-human');
    expect(failed.reason).toContain('failed-attempt publication refused');
    expect(await git(f.repo, 'rev-parse', `refs/heads/${failed.failedAttempt!.branch}`)).toBe(
      failed.failedAttempt!.sha,
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    vi.unstubAllEnvs();
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed scans edits captured by an early worker failure before path classification', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('throw-after-secret') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(result.status).toBe('needs-human');
    expect(failed.reason).toContain('failed-attempt publication refused');
    expect(await git(f.repo, 'show', `${failed.failedAttempt!.sha}:public-note.txt`)).toContain(
      'DO_NOT_UPLOAD',
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed applies tamper gate before path policy after an early worker failure', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('throw-after-protected') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(result.status).toBe('needs-human');
    expect(failed.reason).toContain('failed-attempt tamper gate refused publication');
    expect(await git(f.repo, 'show', `${failed.failedAttempt!.sha}:package.json`)).toContain(
      '"name":"edited"',
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed scans refusal diagnostics embedded in the failed commit message', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('throw-sensitive-diagnostic') })({
      ...input(f),
      pushFailed: true,
    });
    const report = reportOf(result);
    const failed = report.tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(result.status).toBe('needs-human');
    expect(failed.reason).toContain('failed-attempt publication refused');
    expect(await git(f.repo, 'show', '-s', '--format=%B', failed.failedAttempt!.sha)).toContain(
      'DO_NOT_UPLOAD synthetic diagnostic',
    );
    expect(
      await git(
        f.repo,
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${failed.failedAttempt!.branch}`,
      ),
    ).toBe('');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed publishes a clean public failed-attempt change', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted('safe-change') })({
      ...input(f),
      pushFailed: true,
    });
    const failed = reportOf(result).tasks.find((task) => task.failedAttempt !== undefined)!;
    expect(await git(f.repo, 'show', `${failed.failedAttempt!.sha}:public-note.txt`)).toContain(
      'safe public content',
    );
    expect(
      (
        await git(
          f.repo,
          'ls-remote',
          '--heads',
          'origin',
          `refs/heads/${failed.failedAttempt!.branch}`,
        )
      ).split(/\s+/)[0],
    ).toBe(failed.failedAttempt!.sha);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('pushFailed keeps path-policy-refused failed attempts local', async () => {
  const f = await fixture();
  try {
    const result = await makeFixRun({ drivers: scripted() })({
      ...input(f),
      proposeOnly: true,
      pushFailed: true,
    });
    const report = reportOf(result);
    expect(result.status).toBe('needs-human');
    const attempts = report.tasks.flatMap(
      (task) =>
        task.rounds?.flatMap((round) => (round.failedAttempt ? [round.failedAttempt] : [])) ?? [],
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(
      report.tasks.some((task) =>
        task.rounds?.some(
          (round) => round.gate === 'path-policy' && round.reason.includes('propose-only worker'),
        ),
      ),
    ).toBe(true);
    for (const attempt of attempts) {
      expect(await git(f.repo, 'rev-parse', `refs/heads/${attempt.branch}`)).toBe(attempt.sha);
      expect(
        await git(f.repo, 'ls-remote', '--heads', 'origin', `refs/heads/${attempt.branch}`),
      ).toBe('');
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
