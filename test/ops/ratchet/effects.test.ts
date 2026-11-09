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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import { baselineRelPath, parseBaseline, renderBaseline } from '../../../src/ops/ratchet/format.js';
import { makeSubprocessBaselinePrEffects } from '../../../src/adapters/forge-github/ratchetEffects.js';

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

// Seven real Git subprocesses (including push and clone) build this fixture.
// Keep their setup budget separate from the behavior tests' deadlines.
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
      "if (process.env.FAKE_GH_FAIL_LIST === '1' && args[0] === 'pr' && args[1] === 'list') { process.stderr.write('deliberate gh failure'); process.exit(2); }",
      "if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write(process.env.FAKE_GH_PR_LIST ?? '[]'); process.exit(0); }",
      "if (args[0] === 'pr' && args[1] === 'create') { process.stdout.write((process.env.FAKE_GH_PR_CREATE ?? '" +
        PR_URL +
        "') + '\\n'); process.exit(0); }",
      "if (args[0] === 'pr' && ['edit', 'comment', 'close'].includes(args[1])) { process.exit(0); }",
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
}, 30_000);

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
  test.skipIf(process.platform === 'win32')(
    'does not execute git supplied by the scoped checkout',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cq-ratchet-path-'));
      const marker = join(dir, 'hostile-ran');
      const hostile = join(dir, 'git');
      writeFileSync(hostile, '#!/bin/sh\ntouch hostile-ran\n');
      chmodSync(hostile, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `.:${previousPath ?? '/usr/bin:/bin'}`;
      try {
        const effects = makeSubprocessBaselinePrEffects(dir, 'main');
        await expect(
          effects.commitAndUpsertPr({
            head: 'branch',
            base: 'main',
            title: 't',
            body: 'b',
            commitMessage: 'm',
            files: [],
          }),
        ).rejects.toThrow();
        expect(existsSync(marker)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test('withdrawal comments then closes only the exact head and base', async () => {
    const effects = makeSubprocessBaselinePrEffects(work, 'main');
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      { number: 8, url: PR_URL, baseRefName: 'main', headRefName: 'other' },
      { number: 7, url: PR_URL, baseRefName: 'main', headRefName: HEAD },
    ]);
    const before = ghCalls().length;
    await effects.closeOpenPrByHead(HEAD, 'Latest measurement no longer tightens: 11');
    const calls = ghCalls().slice(before);
    expect(calls[1]?.slice(0, 4)).toEqual(['pr', 'comment', '7', '--body-file']);
    expect(calls[2]).toEqual(['pr', 'close', '7']);
  });

  test('findOpenPrByHead returns only the PR whose base matches the (head, base) pair', async () => {
    const effects = makeSubprocessBaselinePrEffects(work, 'main');
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      {
        number: 1,
        url: 'https://example.test/o/r/pull/1',
        baseRefName: 'release',
        headRefName: HEAD,
      },
      { number: 2, url: 'https://example.test/o/r/pull/2', baseRefName: 'main', headRefName: HEAD },
    ]);
    await expect(effects.findOpenPrByHead(HEAD)).resolves.toEqual({
      number: 2,
      url: 'https://example.test/o/r/pull/2',
    });
    // A head carrying ONLY a different-base PR is not this proposal's PR.
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      {
        number: 1,
        url: 'https://example.test/o/r/pull/1',
        baseRefName: 'release',
        headRefName: HEAD,
      },
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
      JSON.stringify([{ number: 7, url: PR_URL, baseRefName: 'main', headRefName: HEAD }]),
    );
    expect(second).toEqual({ created: false, number: 7, url: PR_URL });
    expect(git(bare, ['rev-parse', `refs/heads/${HEAD}`]).trim()).toBe(pushedSha);
    const callsAfter = ghCalls().slice(logLengthBefore);
    expect(callsAfter.some((args) => args[1] === 'edit')).toBe(true);
    expect(callsAfter.some((args) => args[1] === 'create')).toBe(false);
  }, 60_000);

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

  test('flag-injection-shaped refs are refused before any argv is built (finding L)', async () => {
    // A direct caller of the exported effects cannot hand a leading-dash
    // "ref" to git/gh as an option.
    expect(() => makeSubprocessBaselinePrEffects(work, '--upload-pack=evil')).toThrow(
      /unsafe base/,
    );
    const effects = makeSubprocessBaselinePrEffects(work, 'main');
    await expect(effects.findOpenPrByHead('--head=evil')).rejects.toThrow(/unsafe head/);
    await expect(
      effects.commitAndUpsertPr({
        head: '-x',
        base: 'main',
        title: 't',
        body: 'b',
        commitMessage: 'm',
        files: [],
      }),
    ).rejects.toThrow(/unsafe head/);
  });

  test('a failed gh list cannot become an absent-PR answer', async () => {
    const previous = process.env.FAKE_GH_FAIL_LIST;
    process.env.FAKE_GH_FAIL_LIST = '1';
    try {
      const effects = makeSubprocessBaselinePrEffects(work, 'main');
      await expect(effects.findOpenPrByHead(HEAD)).rejects.toThrow(
        /gh pr failed: deliberate gh failure/,
      );
    } finally {
      if (previous === undefined) delete process.env.FAKE_GH_FAIL_LIST;
      else process.env.FAKE_GH_FAIL_LIST = previous;
    }
  });

  test('a non-array gh list payload throws instead of reading as no open PR', async () => {
    const previous = process.env.FAKE_GH_PR_LIST;
    process.env.FAKE_GH_PR_LIST = '{"unexpected":true}';
    try {
      const effects = makeSubprocessBaselinePrEffects(work, 'main');
      await expect(effects.findOpenPrByHead(HEAD)).rejects.toThrow(/non-array JSON payload/);
    } finally {
      if (previous === undefined) delete process.env.FAKE_GH_PR_LIST;
      else process.env.FAKE_GH_PR_LIST = previous;
    }
  });

  test('an input base that differs from the captured base is refused', async () => {
    const effects = makeSubprocessBaselinePrEffects(work, 'main');
    await expect(
      effects.commitAndUpsertPr({
        head: HEAD,
        base: 'other',
        title: 't',
        body: 'b',
        commitMessage: 'm',
        files: [],
      }),
    ).rejects.toThrow(/differs from the effects base/);
  });

  test('a file path escaping the checkout is refused before any write', async () => {
    const effects = makeSubprocessBaselinePrEffects(fresh, 'main');
    await expect(
      effects.commitAndUpsertPr({
        head: HEAD,
        base: 'main',
        title: 't',
        body: 'b',
        commitMessage: 'm',
        files: [{ path: '../escaped.txt', content: 'x' }],
      }),
    ).rejects.toThrow(/refusing to write outside the checkout/);
    expect(existsSync(join(tmp, 'escaped.txt'))).toBe(false);
    expect(git(fresh, ['branch', '--show-current']).trim()).toBe('main');
  }, 60_000);

  test.each([
    ['no URL', 'not a URL', /gh pr create returned no URL/],
    ['no PR identity', 'https://example.test/not-a-pull', /no PR identity/],
  ])(
    'a create response with %s fails closed',
    async (_label, response, error) => {
      process.env.FAKE_GH_PR_LIST = '[]';
      process.env.FAKE_GH_PR_CREATE = response;
      const effects = makeSubprocessBaselinePrEffects(work, 'main');
      await expect(
        effects.commitAndUpsertPr({
          head: HEAD,
          base: 'main',
          title: 'chore(ratchet): tighten baselines',
          body: 'body',
          commitMessage: 'chore(ratchet): tighten baselines',
          files: [{ path: FILE, content: CONTENT }],
        }),
      ).rejects.toThrow(error);
    },
    60_000,
  );

  test('a failed origin fetch aborts the proposal and restores the original branch', async () => {
    const originalOrigin = git(fresh, ['remote', 'get-url', 'origin']).trim();
    git(fresh, ['remote', 'set-url', 'origin', join(tmp, 'missing-remote.git')]);
    try {
      const effects = makeSubprocessBaselinePrEffects(fresh, 'main');
      await expect(
        effects.commitAndUpsertPr({
          head: HEAD,
          base: 'main',
          title: 'chore(ratchet): tighten baselines',
          body: 'body',
          commitMessage: 'chore(ratchet): tighten baselines',
          files: [{ path: FILE, content: CONTENT }],
        }),
      ).rejects.toThrow(/git fetch failed/);
      expect(git(fresh, ['branch', '--show-current']).trim()).toBe('main');
    } finally {
      git(fresh, ['remote', 'set-url', 'origin', originalOrigin]);
    }
  }, 60_000);
});

test('a detached original checkout is restored, not left on the proposal head', async () => {
  const sha = git(fresh, ['rev-parse', 'HEAD']).trim();
  git(fresh, ['checkout', '-q', '--detach']);
  try {
    const effects = makeSubprocessBaselinePrEffects(fresh, 'main');
    await expect(
      effects.commitAndUpsertPr({
        head: HEAD,
        base: 'main',
        title: 't',
        body: 'b',
        commitMessage: 'm',
        files: [{ path: '../escaped.txt', content: 'x' }],
      }),
    ).rejects.toThrow(/refusing to write outside the checkout/);
    expect(git(fresh, ['branch', '--show-current']).trim()).toBe('');
    expect(git(fresh, ['rev-parse', 'HEAD']).trim()).toBe(sha);
  } finally {
    git(fresh, ['checkout', '-q', 'main']);
  }
}, 60_000);

test('real reused proposal branch restores a previous-run tightening that is no longer applied', async () => {
  const checkout = join(tmp, 'mixed-metric-checkout');
  git(tmp, ['clone', '-q', bare, checkout]);
  const coveragePath = baselineRelPath('coverage', 'coverage');
  const typecheckPath = baselineRelPath('typecheck', 'typecheck-count');
  const coverageBase = renderBaseline({
    schemaVersion: 1,
    target: 'coverage',
    metric: 'coverage',
    direction: 'higher-is-better',
    value: 90,
    capturedAt: '2026-11-03T00:00:00.000Z',
  });
  mkdirSync(join(checkout, 'baselines'), { recursive: true });
  writeFileSync(join(checkout, coveragePath), coverageBase);
  writeFileSync(
    join(checkout, typecheckPath),
    renderBaseline({
      schemaVersion: 1,
      target: 'typecheck',
      metric: 'typecheck-count',
      direction: 'lower-is-better',
      value: 10,
      capturedAt: '2026-11-03T00:00:00.000Z',
    }),
  );
  git(checkout, ['add', 'baselines']);
  git(checkout, [
    '-c',
    'user.email=t@test',
    '-c',
    'user.name=test',
    'commit',
    '-qm',
    'seed mixed baselines',
  ]);
  git(checkout, ['push', '-q', 'origin', 'main']);
  process.env.FAKE_GH_PR_LIST = '[]';
  process.env.FAKE_GH_PR_CREATE = PR_URL;
  const op = createProposeBaselineUpdate(makeSubprocessBaselinePrEffects(checkout, 'main'));
  const input = (coverage: number, typecheck: number) => ({
    ws: checkout,
    base: 'main',
    headPrefix: 'ratchet/mixed',
    improvements: [
      { target: 'coverage', metric: 'coverage', value: coverage },
      { target: 'typecheck', metric: 'typecheck-count', value: typecheck },
    ],
  });
  const first = await op(input(91, 10));
  expect(first.status).toBe('ok');
  if (first.status !== 'ok' || first.value.head === null) throw new Error('proposal missing');
  const head = first.value.head;
  expect(parseBaseline(git(bare, ['show', `${head}:${coveragePath}`])).value).toBe(91);
  process.env.FAKE_GH_PR_LIST = JSON.stringify([
    { number: 7, url: PR_URL, baseRefName: 'main', headRefName: head },
  ]);
  const second = await op(input(90, 9));
  expect(second).toMatchObject({ status: 'ok', value: { proposal: 'updated', head } });
  expect(git(bare, ['show', `${head}:${coveragePath}`])).toBe(coverageBase);
  expect(parseBaseline(git(bare, ['show', `${head}:${typecheckPath}`])).value).toBe(9);
}, 60_000);
