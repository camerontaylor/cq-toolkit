// T4.2 round-2 — hermetic tests for src/ops/ratchet/effects.ts.
//
// A REAL local bare repo + a fake `gh` shim on the CQ_GH_BIN seam (the
// review/merge family's binary-injection convention). No network, no real
// forge. Pinned:
//   1. (head, base) disambiguation: one head with two open PRs against
//      different bases returns only the PR whose baseRefName matches
//      (review finding 1 / CodeRabbit Major).
//   2. IDEMPOTENT update on a FRESH checkout (CodeRabbit Major + reviewer
//      finding 2): a re-run against a clone with no local refs/heads/<head>
//      fetches the remote head, re-commits nothing, pushes a no-op
//      fast-forward and EDITS the existing PR instead of failing
//      non-fast-forward into an indeterminate.
//   3. The token gate (reviewer finding 5): an absent CQ_AUTOMATION_TOKEN
//      throws loudly, never falls back to an ambient GH_TOKEN/GITHUB_TOKEN,
//      and never invokes gh.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeSubprocessBaselinePrEffects } from '../../../src/ops/ratchet/effects.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/** One synchronous git invocation (setup/assertions only; the effects spawn their own). */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

const PR_URL = 'https://example.test/o/r/pull/7';
const HEAD = 'ratchet/propose-abc';
const FILE = 'baselines/coverage--coverage--a8ceec8f7024.json';
const CONTENT = '{ "schemaVersion": 1 }\n';

let tmp: string;
let bare: string;
let work: string;
let fresh: string;
let ghLog: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cq-ratchet-effects-'));
  bare = join(tmp, 'remote.git');
  work = join(tmp, 'work');
  fresh = join(tmp, 'fresh');
  const shim = join(tmp, 'gh');
  ghLog = join(tmp, 'gh.log');

  git(tmp, ['init', '--bare', '-q', '-b', 'main', bare]);
  git(tmp, ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'README.md'), 'seed\n', 'utf8');
  git(work, ['add', '-A']);
  git(work, ['-c', 'user.email=t@test', '-c', 'user.name=test', 'commit', '-q', '-m', 'seed']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  git(tmp, ['clone', '-q', bare, fresh]);

  writeFileSync(
    shim,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      "if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');",
      "if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write(process.env.FAKE_GH_PR_LIST ?? '[]'); process.exit(0); }",
      "if (args[0] === 'pr' && args[1] === 'create') { process.stdout.write((process.env.FAKE_GH_PR_CREATE ?? '" +
        PR_URL +
        "') + '\\n'); process.exit(0); }",
      "if (args[0] === 'pr' && args[1] === 'edit') { process.exit(0); }",
      "process.stderr.write('fake gh: unexpected ' + args.join(' ') + '\\n');",
      'process.exit(2);',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(shim, 0o755);

  for (const key of [
    'CQ_GH_BIN',
    'CQ_AUTOMATION_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'FAKE_GH_LOG',
    'FAKE_GH_PR_LIST',
    'FAKE_GH_PR_CREATE',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_TERMINAL_PROMPT',
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.CQ_GH_BIN = shim;
  process.env.CQ_AUTOMATION_TOKEN = 'test-token-not-real';
  process.env.FAKE_GH_LOG = ghLog;
  // Ambient tokens must never leak into an effect; the effects must ignore
  // them (asserted by the token-gate test).
  process.env.GH_TOKEN = 'ambient-gh-token-should-be-ignored';
  process.env.GITHUB_TOKEN = 'ambient-github-token-should-be-ignored';
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** The fake-gh invocation log, one JSON argv array per line. */
function ghCalls(): string[][] {
  try {
    return readFileSync(ghLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

function upsert(worktree: string, listJson: string) {
  process.env.FAKE_GH_PR_LIST = listJson;
  process.env.FAKE_GH_PR_CREATE = PR_URL;
  return makeSubprocessBaselinePrEffects(worktree, 'main').commitAndUpsertPr({
    head: HEAD,
    base: 'main',
    title: 'chore(ratchet): tighten baselines',
    body: 'body',
    commitMessage: 'chore(ratchet): tighten baselines',
    files: [{ path: FILE, content: CONTENT }],
  });
}

describe('makeSubprocessBaselinePrEffects', () => {
  test('findOpenPrByHead returns only the PR whose base matches the (head, base) pair', async () => {
    const effects = makeSubprocessBaselinePrEffects(work, 'main');
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      { number: 1, url: 'https://example.test/o/r/pull/1', baseRefName: 'release' },
      { number: 2, url: 'https://example.test/o/r/pull/2', baseRefName: 'main' },
    ]);
    await expect(effects.findOpenPrByHead(HEAD)).resolves.toEqual({
      number: 2,
      url: 'https://example.test/o/r/pull/2',
    });
    // A head carrying ONLY a different-base PR is not this proposal's PR.
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      { number: 1, url: 'https://example.test/o/r/pull/1', baseRefName: 'release' },
    ]);
    await expect(effects.findOpenPrByHead(HEAD)).resolves.toBeNull();
  });

  test('a re-run on a FRESH checkout updates the PR in place (no non-fast-forward push)', async () => {
    // First run: create the branch + PR.
    const first = await upsert(work, '[]');
    expect(first).toEqual({ created: true, number: 7, url: PR_URL });
    const pushedSha = git(bare, ['rev-parse', `refs/heads/${HEAD}`]).trim();
    expect(git(bare, ['show', `refs/heads/${HEAD}:${FILE}`])).toBe(CONTENT);

    // Second run: a FRESH clone has no local refs/heads/<head>. The effects
    // must reuse the remote head, commit nothing, push a no-op fast-forward
    // and edit the existing PR.
    const logLengthBefore = ghCalls().length;
    const second = await upsert(
      fresh,
      JSON.stringify([{ number: 7, url: PR_URL, baseRefName: 'main' }]),
    );
    expect(second).toEqual({ created: false, number: 7, url: PR_URL });
    expect(git(bare, ['rev-parse', `refs/heads/${HEAD}`]).trim()).toBe(pushedSha);
    const callsAfter = ghCalls().slice(logLengthBefore);
    expect(callsAfter.some((args) => args[1] === 'edit')).toBe(true);
    expect(callsAfter.some((args) => args[1] === 'create')).toBe(false);
  });

  test('the token gate throws loudly and never falls back to an ambient token', async () => {
    const before = ghCalls().length;
    const savedToken = process.env.CQ_AUTOMATION_TOKEN;
    delete process.env.CQ_AUTOMATION_TOKEN;
    try {
      const effects = makeSubprocessBaselinePrEffects(work, 'main');
      await expect(effects.findOpenPrByHead(HEAD)).rejects.toThrow(/CQ_AUTOMATION_TOKEN/);
      // The ambient tokens stayed set yet were never used: gh was not invoked.
      expect(process.env.GH_TOKEN).toBe('ambient-gh-token-should-be-ignored');
      expect(process.env.GITHUB_TOKEN).toBe('ambient-github-token-should-be-ignored');
      expect(ghCalls().length).toBe(before);
    } finally {
      process.env.CQ_AUTOMATION_TOKEN = savedToken;
    }
  });
});
