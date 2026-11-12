// Split provenance: test/ops/dev/cycle-green-prefix.test.ts was split by
// subject; this file holds the publication tests (the publication branch
// before the push, the push and pr.open legs, and the findings-section body),
// including the part's one top-level suite (renderFindingsSection outside the
// describe). The shared scenario harness lives in
// cycle-green-prefix.helpers.ts.
// #536 (Giles D2/D2b): red final gates after verified fixes. dev.cycle probes
// the verified-fix chain newest to oldest in an isolated worktree and
// publishes a DRAFT from a NEW branch pinned to the newest commit passing ALL
// final gates; the author's branch, worktree and ledger stay at the addressed
// head. Real git (work repo + bare origin); every op leg, the probe checks,
// the install and the forge are scripted. No provider, network or credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { renderFindingsSection } from '../../../src/ops/dev/cycle.js';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import { BRANCH, bindCycleHarness } from './cycle-green-prefix.helpers.js';
import { makeTestRepo, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await repo.cleanup();
});

const { run, expectAuthorUntouched } = bindCycleHarness(() => repo);

describe('dev.cycle red final gates: newest green verified-fix commit (#536)', () => {
  test('an existing publication branch is refused and left untouched (never deleted)', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      beforeFinal: (T) => {
        repo.git('branch', `${BRANCH}-cq-green-${T.slice(0, 12)}`, T);
      },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') expect(r.result.error).toContain('already exists');
    expect(repo.git('rev-parse', `refs/heads/${r.pub}`).trim()).toBe(r.T);
    expect(r.installs).toEqual([]);
    expect(r.probeRoots).toEqual([]);
    expect(r.opens).toEqual([]);
  });

  test('a branch another process creates between the existence check and creation is never deleted', async () => {
    let raced: string | undefined;
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      authorHandler: (command, args) => {
        // Race: right before OUR atomic create, someone else creates the ref.
        const ref = args.find((arg) => arg.startsWith('refs/heads/') && arg.includes('-cq-green-'));
        if (command === 'git' && args.includes('update-ref') && !args.includes('-d') && ref) {
          raced = repo.git('rev-parse', 'HEAD').trim();
          repo.git('update-ref', ref, raced);
        }
        return undefined;
      },
    });
    expect(raced).toBeDefined();
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('could not be created (it may already exist)');
    expect(repo.git('rev-parse', `refs/heads/${r.pub}`).trim()).toBe(raced);
    expect(r.probeRoots).toEqual([]);
    expect(existsSync(r.probeDir)).toBe(false);
  });

  test('a push whose remote verification fails keeps the local publication branch', async () => {
    const r = await run({ greens: [true, false], stop: 'budget', remoteMismatch: true });
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human') {
      expect(r.result.reason).toMatch(/^dev\.cycle \(push\): /);
      expect(r.result.reason).toContain(
        `the remote may carry '${r.pub}', and the local branch is kept`,
      );
    }
    expect(r.opens).toEqual([]);
    expect(repo.git('rev-parse', `refs/heads/${r.pub}`).trim()).toBe(r.commits[0]);
    expect(existsSync(r.probeDir)).toBe(false);
  });

  test('a pr.open refusal after the push surfaces as the pr.open step and keeps the pushed branch', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      openInResult: async () => ({ status: 'needs-human', reason: 'pr.open: forge refused' }),
    });
    expect(r.result).toMatchObject({
      status: 'needs-human',
      reason: 'dev.cycle (pr.open): pr.open: forge refused',
    });
    expect(repo.git('rev-parse', `refs/heads/${r.pub}`).trim()).toBe(r.commits[0]);
    expect(existsSync(r.probeDir)).toBe(false);
  });

  test('a findings-section compose failure names the open draft at the published commit', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      ghEditThrows: 'body write refused',
    });
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human')
      expect(r.result.reason).toBe(
        `dev.cycle (pr body): draft PR #77 is open at ${r.commits[0]!} but the findings section could not be composed — body write refused`,
      );
    expectAuthorUntouched(r);
  });

  test('a denylist hit on the probe findings-section compose refuses and publishes no body edit', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      probePublicationHits: [{ component: 'pr-body', ruleId: 'probe-secret' }],
    });
    // The draft was created (the PR exists) but the findings section was
    // refused by the probe root's rules: the reason names the draft and
    // carries the scanner's hit evidence.
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human')
      expect(r.result.reason).toBe(
        `dev.cycle (pr body): draft PR #77 is open at ${r.commits[0]!} but the findings section could not be composed — PR publication refused by denylist scan: probe-secret at line 1`,
      );
    // No body edit reached the forge: the refusal fired before editPrBody.
    expect(r.bodies).toEqual([]);
    expectAuthorUntouched(r);
  });

  test('a publication that throws after the push attempt keeps the branch and says the remote may carry it', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      openInResult: async () => {
        throw new Error('forge transport reset');
      },
    });
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human') {
      expect(r.result.reason).toContain('then the publication threw — forge transport reset');
      expect(r.result.reason).toContain(
        `the remote may carry '${r.pub}', and the local branch is kept`,
      );
    }
    expect(repo.git('rev-parse', `refs/heads/${r.pub}`).trim()).toBe(r.commits[0]);
    expect(existsSync(r.probeDir)).toBe(false);
  });
});

test('renderFindingsSection without a selection is unchanged by #536', () => {
  const report = {
    version: 1,
    source: 'local',
    reportPath: '/tmp/x.json',
    rounds: [],
    findings: [],
    openBlocking: [],
    fixes: [],
    attempts: [],
    failed: [],
    fixesPerRun: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    wallMs: 1,
    reasons: [],
    stop: 'budget',
  } satisfies ReviewAddressReport;
  const section = renderFindingsSection(report);
  expect(section).not.toContain('PUBLISHED AT');
  expect(section).toContain('## Open findings after a run budget stop');
});
