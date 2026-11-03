// Split provenance: test/ops/sweep/worktreeFor.test.ts was split by subject;
// this file keeps the git fault mapping (maxBuffer vs timeout vs stderr).
import { describe, expect, test } from 'vitest';
import { mapWorktreeGitFault } from '../../../src/adapters/git/worktreeFor.js';

// ---------------------------------------------------------------------------
// 8. The subprocess adapter: git fault mapping (maxBuffer vs timeout)
// ---------------------------------------------------------------------------

describe('mapWorktreeGitFault (fault mapping)', () => {
  test('a maxBuffer overflow (which also sets killed) names the OUTPUT LIMIT, not the timeout', () => {
    const error = mapWorktreeGitFault(
      ['for-each-ref'],
      { killed: true, message: 'maxBuffer length exceeded' },
      '',
      600_000,
    );
    expect(error.message).toMatch(/output limit/);
    expect(error.message).toMatch(/maxBuffer/);
    expect(error.message).not.toMatch(/timed out/);
  });

  test('a timeout kill names the timeout', () => {
    const error = mapWorktreeGitFault(
      ['status'],
      { killed: true, message: 'sigkill' },
      '',
      600_000,
    );
    expect(error.message).toMatch(/timed out/);
    expect(error.message).not.toMatch(/output limit/);
  });

  test('a plain non-zero exit carries the stderr text', () => {
    const error = mapWorktreeGitFault(
      ['status'],
      { code: 128, killed: false, message: 'exited with code 128' },
      'fatal: not a git repository',
      600_000,
    );
    expect(error.message).toMatch(/exit 128/);
    expect(error.message).toMatch(/fatal: not a git repository/);
  });
});
