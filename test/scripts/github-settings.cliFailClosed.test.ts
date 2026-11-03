// github-settings-drift CLI, the fail-closed branch: without App ids it exits 1
// before any gh call, a malformed repository or App id is a usage error (exit
// 2), and a gh failure is an error, never an absent read. CQ_GH_BIN points at a
// nonexistent path, so these tests never reach the network.
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, SCRIPT } from './github-settings.helpers.js';

describe('github-settings-drift CLI', () => {
  function runCli(args: string[]) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CQ_GH_BIN: join(ROOT, 'nonexistent', 'gh') },
    });
  }

  it('fails closed without App ids and reads no API', { timeout: 180_000 }, () => {
    for (const args of [
      ['--repository=a/b'],
      ['--repository=a/b', '--verdict-app-id=1', '--promoter-app-id='],
      ['--repository=a/b', '--verdict-app-id= ', '--promoter-app-id=2'],
    ]) {
      const res = runCli(args);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain(
        'drift: apps not registered (RS-11 B1): verdict/promoter app ids unset',
      );
      expect(res.stderr).toBe('');
    }
  });

  it(
    'refuses a malformed repository or App id as a usage error (exit 2)',
    { timeout: 180_000 },
    () => {
      for (const args of [
        ['--repository=a'],
        ['--repository=a/b/c', '--verdict-app-id=1', '--promoter-app-id=2'],
        ['--repository=-a/b', '--verdict-app-id=1', '--promoter-app-id=2'],
        ['--repository=a/..', '--verdict-app-id=1', '--promoter-app-id=2'],
        ['--repository=a/b', '--verdict-app-id=x', '--promoter-app-id=2'],
        ['--repository=a/b', '--bogus=1'],
      ]) {
        const res = runCli(args);
        expect(res.status, args.join(' ')).toBe(2);
        expect(res.stderr).toMatch(/github-settings-drift: usage: /);
      }
    },
  );

  it('treats a gh failure as an error, never as absent (exit 2)', { timeout: 180_000 }, () => {
    const res = runCli(['--repository=a/b', '--verdict-app-id=1', '--promoter-app-id=2']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/github-settings-drift: error: gh api repos\/a\/b\/rulesets/);
  });
});
