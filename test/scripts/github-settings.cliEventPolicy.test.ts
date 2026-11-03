// github-settings-drift CLI: the Actions event policy read, the event-policy
// status semantics. A 403 on the list read is UNCHECKED (a notice, exit 0)
// unless --require-event-policy makes it an error; every other failure stays an
// error (exit 2), never unchecked or absent.
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { describe, expect, it } from 'vitest';
import { ACTIONS_EVENT_POLICY_UNCHECKED } from '../../scripts/lib/github-settings.mjs';
import { runFake, runFakeAsync } from './github-settings.helpers.js';

describe('github-settings-drift CLI: the Actions event policy read', () => {
  const REPO = 'repos/o/r';
  const PAGE = 'per_page=100';
  const LIST = `${REPO}/actions/policies?${PAGE}`;

  it(
    'a 403 on the list read is UNCHECKED: a notice, no drift from it (exit 0)',
    { timeout: 180_000 },
    () => {
      const res = runFake([], { [LIST]: 403 });
      expect(res.stderr).toBe('');
      expect(res.stdout).toBe(
        `notice: ${ACTIONS_EVENT_POLICY_UNCHECKED}\n` +
          'github-settings-drift: o/r: 0 drift line(s), 1 notice(s)\n',
      );
      expect(res.stdout).toContain(
        'notice: actions event policy unchecked: GitHub requires Administration: write to read it; the CI drift credential is read-only by design — run the drift check with an owner/admin credential to cover it',
      );
      expect(res.status).toBe(0);
    },
  );

  it('--require-event-policy turns that 403 into an error (exit 2)', { timeout: 180_000 }, () => {
    const res = runFake(['--require-event-policy'], { [LIST]: 403 });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(
      /github-settings-drift: error: gh api repos\/o\/r\/actions\/policies\?per_page=100 failed: .*HTTP 403.*--require-event-policy/,
    );
    // Readable, the flag changes nothing.
    expect(runFake(['--require-event-policy'], {}).status).toBe(0);
  });

  it(
    'every other failure stays an error (exit 2), never unchecked or absent',
    { timeout: 180_000 },
    async () => {
      // The four cases are independent CLI runs: run them concurrently.
      const cases = [
        [LIST, 404],
        [LIST, 500],
        [`${REPO}/actions/policies/5486`, 403],
        [`${REPO}/actions/permissions/workflow`, 403],
      ] as const;
      const results = await Promise.all(
        cases.map(([path, code]) => runFakeAsync([], { [path]: code })),
      );
      for (const [i, res] of results.entries()) {
        const [path, code] = cases[i] ?? ['', 0];
        expect(res.status, `${path} ${code}`).toBe(2);
        expect(res.stdout, `${path} ${code}`).not.toContain('notice:');
        expect(res.stderr).toMatch(/github-settings-drift: error: /);
      }
    },
  );
});
