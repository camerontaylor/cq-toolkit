// #536 (Giles D2/D2b): red final gates after verified fixes. dev.cycle probes
// the verified-fix chain newest to oldest in an isolated worktree and
// publishes a DRAFT from a NEW branch pinned to the newest commit passing ALL
// final gates; the author's branch, worktree and ledger stay at the addressed
// head. Real git (work repo + bare origin); every op leg, the probe checks,
// the install and the forge are scripted. No provider, network or credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeDevCycle, renderFindingsSection } from '../../../src/ops/dev/cycle.js';
import type { DevCheckInput, DevCheckReport } from '../../../src/ops/dev/check.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { DEV_LEDGER_VERSION, type DevCheckRecord } from '../../../src/ops/dev/record.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import type { PrOpenInput, PrOpenReport } from '../../../src/ops/pr/open.js';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import type { AddressFix } from '../../../src/ops/review/addressWorker.js';
import type { OpResult } from '../../../src/kernel/types.js';
import { checkRecord } from './fakes.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await repo.cleanup();
});

const BRANCH = 'feature/x';

/** Append one check record to `effects`' ledger for `branch`. */
function appendCheck(effects: DevEffects, branch: string, record: DevCheckRecord): void {
  const store = effects.openLedger(branch);
  const ledger = store.load();
  store.save({
    version: DEV_LEDGER_VERSION,
    branch,
    records: [...ledger.records, record],
  });
}

/** A check leg result + record at the CURRENT state of `effects`' checkout. */
async function scriptedCheck(
  effects: DevEffects,
  passed: boolean,
  checkId: string,
): Promise<OpResult<DevCheckReport>> {
  const read = await readWorkState(effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const record = checkRecord({
    checkId,
    base: read.state.base,
    head: read.state.head,
    dirtySha256: read.state.dirtySha256,
    passed,
    gates: [
      {
        name: 'format:check',
        status: passed ? 'pass' : 'fail',
        exitCode: passed ? 0 : 1,
        durationMs: 5,
        evidence: passed ? 'ok' : 'drift',
      },
    ],
  });
  appendCheck(effects, read.state.branch, record);
  if (passed) {
    const { kind: _kind, ...value } = record;
    return { status: 'ok', value };
  }
  return {
    status: 'failed',
    error: `dev.check: 1 gate(s) red (format:check) — record ${checkId} is in the branch dev-record`,
  };
}

interface Scenario {
  /** Green verdict per chain commit, oldest first; the LAST entry is T (always red). */
  greens: boolean[];
  /** The address leg's structured stop; undefined = a clean (ok) address leg. */
  stop?: 'budget' | 'rereview-blocked' | 'round-cap';
  /** Mutate the report before it is returned. */
  tamper?: (report: ReviewAddressReport, admitted: string) => void;
  installDeps?: ((root: string, signal: AbortSignal) => Promise<void>) | null;
  probeFault?: string;
  push?: boolean;
  /** Advance Date.now by this much during the red final check. */
  finalCheckMs?: number;
  /** Runs at the start of the red final check, with the addressed head. */
  beforeFinal?: (T: string) => void;
  /** Use the DEFAULT probe check leg (no checkIn), with these scanner deps. */
  defaultProbeCheck?: {
    scanSecrets?: true;
    scanSecretsFor?: (root: string) => never;
  };
  /** Advance Date.now by this much inside each (green) probe. */
  probeAdvanceMs?: number;
  /** The remote reports another head after the push (verification fails). */
  remoteMismatch?: boolean;
  /** The probe check throws. */
  probeThrows?: string;
  /** review.run reports this head instead of the reviewed one. */
  reviewHead?: string;
  /** Named test files passed to dev.cycle (absolute paths are re-rooted). */
  testFiles?: (root: string) => string[];
  /** Change a dependency input (package.json) in the fix at this chain index. */
  dependencyChangeAt?: number;
  /** Called at the start of each probe check. */
  onProbe?: () => void;
  /** Scripted author-side git commands (a race injected before real git runs). */
  authorHandler?: Parameters<typeof repoEffects>[1];
}

async function run(scenario: Scenario) {
  const author = repoEffects(repo, scenario.authorHandler);
  const admitted = repo.git('rev-parse', 'HEAD').trim();
  const commits: string[] = [];
  const verdicts = new Map<string, boolean>();
  const pushes: string[][] = [];
  const opens: { input: PrOpenInput; root: string }[] = [];
  const installs: string[] = [];
  const probeRoots: string[] = [];
  const probeSteps: DevCheckInput[] = [];
  let pushedSha: string | undefined;
  let authorChecks = 0;
  const bodies: string[] = [];
  let body = '<!-- cq:dev-readiness-gaps -->\nGAPS\n<!-- /cq:dev-readiness-gaps -->';
  const gh = {
    getPrBody: async () => body,
    editPrBody: async (_n: number, next: string) => {
      bodies.push(next);
      body = next;
    },
  } as unknown as PrEffects;

  const op = makeDevCycle({
    effects: author,
    gh,
    ...(scenario.push === undefined ? {} : {}),
    check: async () => {
      authorChecks += 1;
      if (authorChecks === 1) return scriptedCheck(author, true, 'k001-open');
      scenario.beforeFinal?.(commits.at(-1)!);
      if (scenario.finalCheckMs !== undefined) {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + scenario.finalCheckMs);
      }
      return scriptedCheck(author, false, 'k002-final');
    },
    review: async () => {
      const read = await readWorkState(author, { target: 'merge-queue' });
      if (!read.ok) throw new Error(read.reason);
      return {
        status: 'ok',
        value: {
          schemaVersion: 1,
          branch: BRANCH,
          head: scenario.reviewHead ?? read.state.head,
          reviewed: { base: read.state.base, scope: 'full' },
          sources: [{ kind: 'agent', status: 'terminal' }],
          findings: [],
        },
      };
    },
    address: async () => {
      const fixes: AddressFix[] = [];
      let observed = admitted;
      for (const [index, green] of scenario.greens.entries()) {
        await repo.write('src/a.ts', `export const a = ${String(index + 2)};\n`);
        if (scenario.dependencyChangeAt === index)
          await repo.write('package.json', `{"name":"fixture","version":"1.0.${String(index)}"}\n`);
        // Commit the fix files only: `.cq/` holds the ledger and stays untracked.
        repo.git(
          'add',
          'src/a.ts',
          ...(scenario.dependencyChangeAt === index ? ['package.json'] : []),
        );
        repo.git('commit', '-q', '-m', `fix f${String(index + 1)}`);
        const commit = repo.git('rev-parse', 'HEAD').trim();
        commits.push(commit);
        verdicts.set(commit, green);
        fixes.push({
          finding: {
            id: `c001#f${String(index + 1)}`,
            source: 'agent',
            file: 'src/a.ts',
            severity: 'major',
            text: `finding ${String(index + 1)}`,
            status: 'fixed',
            reason: 'verified',
          },
          commit,
          observedHead: observed,
          reason: 'verified',
          validation: [],
        });
        observed = commit;
      }
      const report: ReviewAddressReport = {
        source: 'local',
        reportPath: '/tmp/green-prefix-fixture/review-address-report.json',
        rounds: [
          {
            round: 1,
            record: {
              schemaVersion: 1,
              branch: BRANCH,
              head: admitted,
              sources: [{ kind: 'agent', status: 'terminal' }],
              findings: [],
            },
            runs: [],
          },
        ],
        findings: [],
        openBlocking: [],
        fixes,
        attempts: [],
        failed: [],
        fixesPerRun: fixes.length,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        wallMs: 1,
        reasons: [],
        verifiedHead: observed,
        ...(scenario.stop === undefined ? {} : { stop: scenario.stop }),
      };
      scenario.tamper?.(report, admitted);
      return scenario.stop === undefined
        ? { status: 'ok', value: report }
        : {
            status: 'needs-human',
            reason: `review.address stopped (${scenario.stop}); report: /tmp/r.json`,
            report,
          };
    },
    git: async (args) => {
      pushes.push([...args]);
      if (args.includes('push')) {
        pushedSha = args.at(-1)!.split(':')[0];
        return { code: 0, stdout: '', stderr: '' };
      }
      return {
        code: 0,
        stdout: `${scenario.remoteMismatch === true ? 'f'.repeat(40) : (pushedSha ?? '')}\trefs/heads/x\n`,
        stderr: '',
      };
    },
    effectsFor: (root) => makeSubprocessDevEffects(root),
    ...(scenario.installDeps === null
      ? {}
      : {
          installDeps:
            scenario.installDeps ??
            (async (root) => {
              installs.push(root);
            }),
        }),
    ...(scenario.defaultProbeCheck?.scanSecrets === true
      ? { scanSecrets: (async () => ({ ok: true, findings: [] })) as never }
      : {}),
    ...(scenario.defaultProbeCheck?.scanSecretsFor === undefined
      ? {}
      : {
          scanSecretsFor: (root: string) => {
            probeRoots.push(root);
            return scenario.defaultProbeCheck!.scanSecretsFor!(root);
          },
        }),
    ...(scenario.defaultProbeCheck !== undefined
      ? {}
      : {
          checkIn: (effects: DevEffects, root: string) => async (step: DevCheckInput) => {
            probeSteps.push(step);
            probeRoots.push(root);
            scenario.onProbe?.();
            if (scenario.probeThrows !== undefined) throw new Error(scenario.probeThrows);
            if (scenario.probeFault !== undefined)
              return { status: 'needs-human', reason: scenario.probeFault };
            const read = await readWorkState(effects, { target: 'merge-queue' });
            if (!read.ok) throw new Error(read.reason);
            if (scenario.probeAdvanceMs !== undefined) {
              const now = Date.now();
              vi.spyOn(Date, 'now').mockReturnValue(now + scenario.probeAdvanceMs);
            }
            return scriptedCheck(
              effects,
              verdicts.get(read.state.head) === true,
              `k-probe-${read.state.head.slice(0, 8)}`,
            );
          },
        }),
    openIn: (effects, root) => async (input) => {
      opens.push({ input, root });
      const read = await readWorkState(effects, { target: 'merge-queue' });
      if (!read.ok) throw new Error(read.reason);
      const value: PrOpenReport = {
        number: 77,
        url: 'https://example.invalid/pull/77',
        created: true,
        base: input.target ?? 'merge-queue',
        head: read.state.head,
        branch: read.state.branch,
        evidenceClass: 'author',
        ready: false,
      };
      return { status: 'ok', value };
    },
  });
  const result = await op({
    repoRoot: repo.root,
    ...(scenario.push === undefined ? {} : { push: scenario.push }),
    ...(scenario.testFiles === undefined ? {} : { testFiles: scenario.testFiles(repo.root) }),
  });
  const T = commits.at(-1)!;
  const probeParent = join(dirname(repo.root), '.cq-dev-cycle-probes');
  const probePrefix = `${basename(repo.root)}-${T.slice(0, 12)}-`;
  // The probe path is run-unique: the one the probes ran in, if any.
  const probeDir = probeRoots[0] ?? join(probeParent, `${probePrefix}(none)`);
  const pub = `${BRANCH}-cq-green-${T.slice(0, 12)}`;
  return {
    result,
    commits,
    T,
    pushes,
    opens,
    installs,
    probeRoots,
    probeSteps,
    bodies,
    probeDir,
    probeParent,
    probePrefix,
    pub,
    author,
  };
}

/** The author's branch, head and ledger stay exactly where the run left them. */
function expectAuthorUntouched(r: Awaited<ReturnType<typeof run>>): void {
  expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(BRANCH);
  expect(repo.git('rev-parse', 'HEAD').trim()).toBe(r.T);
  expect(repo.git('status', '--porcelain', '--', '.', ':(exclude).cq').trim()).toBe('');
  const checks = r.author
    .openLedger(BRANCH)
    .load()
    .records.filter((record) => record.kind === 'check');
  expect(checks.map((record) => record.checkId)).toEqual(['k001-open', 'k002-final']);
  expect(existsSync(r.probeDir)).toBe(false);
  const leftovers = existsSync(r.probeParent)
    ? readdirSync(r.probeParent).filter((name) => name.startsWith(r.probePrefix))
    : [];
  expect(leftovers).toEqual([]);
  expect(repo.git('worktree', 'list', '--porcelain')).not.toContain(r.probePrefix);
}

describe('dev.cycle red final gates: newest green verified-fix commit (#536)', () => {
  test.each([
    ['green-red-green: the NEWEST green wins', [true, false, true, false], 2, 1],
    ['red-green-red: scans past a red candidate', [false, true, false, false], 1, 2],
  ] as const)('%s', async (_label, greens, selectedIndex, probes) => {
    const r = await run({ greens: [...greens], stop: 'budget' });
    const G = r.commits[selectedIndex]!;
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human') {
      expect(r.result.reason).toContain(`draft PR #77 published from '${r.pub}' at ${G}`);
      expect(r.result.reason).toContain(`red at the addressed head ${r.T} (format:check)`);
      expect(r.result.reason).toContain(
        `dropping ${String(greens.length - 1 - selectedIndex)} fix(es)`,
      );
    }
    expect(r.probeRoots).toHaveLength(probes);
    expect(r.probeRoots.every((root) => root === r.probeDir)).toBe(true);
    expect(r.probeDir.startsWith(join(r.probeParent, r.probePrefix))).toBe(true);
    expect(r.installs).toEqual([r.probeDir]);
    // The pinned push sends G's object to the NEW publication branch only.
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([
      ['-C', repo.root, 'push', 'origin', `${G}:refs/heads/${r.pub}`],
    ]);
    // pr.open ran inside the probe worktree, on the publication branch at G.
    expect(r.opens).toHaveLength(1);
    expect(r.opens[0]!.root).toBe(r.probeDir);
    expect(r.opens[0]!.input).toMatchObject({
      repoRoot: r.probeDir,
      draft: true,
      draftWhenNotReady: true,
    });
    const section = r.bodies.at(-1)!;
    expect(section).toContain(`PUBLISHED AT \`${G}\``);
    expect(section).toContain('NOT re-reviewed at the published commit');
    // Giles D2c: the author's ledger is referenced, never bound.
    expect(section).toContain('unbound deferred debt from the abandoned tip; not acknowledged');
    expect(section).toMatch(/feature_x\.json|feature%2Fx\.json|\.cq\/dev\//);
    expect(section).toMatch(/sha256 `[0-9a-f]{64}`/);
    for (const dropped of r.commits.slice(selectedIndex + 1))
      expect(section).toContain(`\`${dropped}\``);
    expectAuthorUntouched(r);
    // The published branch stays (it is on the forge now); the worktree is gone.
    expect(repo.git('rev-parse', `refs/heads/${r.pub}`).trim()).toBe(G);
  });

  test('every candidate red: the red result verbatim plus per-probe attribution, nothing published', async () => {
    const r = await run({ greens: [false, false, false], stop: 'rereview-blocked' });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toMatch(
        /^dev\.cycle \(dev\.check \(final\)\): dev\.check: 1 gate\(s\) red \(format:check\)/,
      );
      expect(r.result.error).toContain('no candidate passed all final gates (2 probed)');
      expect(r.result.error).toContain(`${r.commits[1]!} red`);
      expect(r.result.error).toContain(`${r.commits[0]!} red`);
      expect(r.result.error).toContain('nothing published');
    }
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([]);
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('the clean-address path with red final gates publishes too (D2b)', async () => {
    const r = await run({ greens: [true, false] });
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human')
      expect(r.result.reason).toContain(`at ${r.commits[0]!}, the newest verified-fix commit`);
    expect(r.bodies.at(-1)).toContain('## Findings after red final gates');
    expectAuthorUntouched(r);
  });

  test('a reserve that cannot cover one probe publishes nothing and says why', async () => {
    const r = await run({ greens: [true, false], stop: 'budget', finalCheckMs: 9 * 60 * 1000 });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('cannot cover a worktree setup and one');
    expect(r.installs).toEqual([]);
    expect(r.probeRoots).toEqual([]);
    expect(r.opens).toEqual([]);
  });

  test('an admitted head that is not this run’s green opening check publishes nothing', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      reviewHead: 'b'.repeat(40),
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain("is not this run's green opening check");
    expect(r.probeRoots).toEqual([]);
    expect(r.opens).toEqual([]);
  });

  test('a first round re-reviewed at the fixed head (rounds[0].record replaced) still publishes', async () => {
    const r = await run({
      greens: [true, false],
      tamper: (report) => {
        // review.address replaces a round's record with its re-review.
        report.rounds[0]!.record.head = report.verifiedHead!;
      },
    });
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human')
      expect(r.result.reason).toContain(`at ${r.commits[0]!}, the newest verified-fix commit`);
  });

  test('a first fix not dispatched at the admitted head publishes nothing', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      tamper: (report) => {
        report.fixes[0]!.observedHead = 'c'.repeat(40);
      },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the first verified fix was dispatched at');
    expect(r.probeRoots).toEqual([]);
  });

  test('absolute named test files under the author checkout are re-rooted into the probe checkout', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      testFiles: (root) => [join(root, 'test/a.test.ts'), 'test/b.test.ts', '/elsewhere/c.test.ts'],
    });
    expect(r.result.status).toBe('needs-human');
    expect(r.probeSteps.map((step) => step.testFiles)).toEqual([
      [join(r.probeDir, 'test/a.test.ts'), 'test/b.test.ts', '/elsewhere/c.test.ts'],
    ]);
    expect(r.probeSteps[0]!.repoRoot).toBe(r.probeDir);
  });

  test('a candidate whose dependency inputs differ is reinstalled before its probe', async () => {
    // c0 green, c1 changes package.json (red), T red: probing c1 then c0
    // crosses the dependency change, so c0 gets its own install.
    const r = await run({ greens: [true, false, false], stop: 'budget', dependencyChangeAt: 1 });
    expect(r.result.status).toBe('needs-human');
    expect(r.installs).toEqual([r.probeDir, r.probeDir]);
    expect(r.probeRoots).toHaveLength(2);
  });

  test('candidates with identical dependency inputs share one install', async () => {
    const r = await run({ greens: [true, false, false], stop: 'budget' });
    expect(r.result.status).toBe('needs-human');
    expect(r.installs).toEqual([r.probeDir]);
    expect(r.probeRoots).toHaveLength(2);
  });

  test('recorded fix commits that are not the linear history publish nothing (no commit-presence shortcut)', async () => {
    const r = await run({
      greens: [true, false, false],
      stop: 'budget',
      tamper: (report) => {
        report.fixes.splice(1, 1);
      },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('are not the linear history');
    expect(r.probeRoots).toEqual([]);
  });

  test('a probe fault stops the scan: no misattributed red, nothing published, worktree removed', async () => {
    const r = await run({ greens: [true, false], stop: 'budget', probeFault: 'host lock busy' });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toContain(`probe of ${r.commits[0]!} faulted: host lock busy`);
      expect(r.result.error).toContain('nothing published');
    }
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
  });

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

  test('a worktree git materialized before its add failed is still released', async () => {
    let materialized: string | undefined;
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      authorHandler: (command, args) => {
        if (command !== 'git' || !args.includes('worktree') || !args.includes('add'))
          return undefined;
        // Simulate an interrupted add: git registers and checks out, then fails.
        const at = args.indexOf('add');
        materialized = args[at + 1]!;
        repo.git('worktree', 'add', '-q', materialized, args[at + 2]!);
        return { exitCode: 1, stdout: '', stderr: 'interrupted checkout', timedOut: false };
      },
    });
    expect(materialized).toBeDefined();
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the probe worktree could not be created');
    expect(existsSync(materialized!)).toBe(false);
    expect(repo.git('worktree', 'list', '--porcelain')).not.toContain(materialized!);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('a reserve exhausted during the publication binding re-reads stops before the push', async () => {
    let probes = 0;
    let bound = false;
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      onProbe: () => {
        probes += 1;
      },
      authorHandler: (command, args) => {
        // The first author re-read after a probe ran: the binding step.
        if (!bound && command === 'git' && args[0] === 'symbolic-ref' && probes > 0) {
          bound = true;
          const now = Date.now();
          vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
        }
        return undefined;
      },
    });
    expect(bound).toBe(true);
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the reserve ran out during the publication binding');
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([]);
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
  });

  test('without a scanner bound to the probe root, the author scanner is never reused: no probe certifies', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      defaultProbeCheck: { scanSecrets: true },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('no secret scanner could be bound to the probe worktree');
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('the probe scanner is built from the PROBE root; a throw there releases the worktree and branch', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      defaultProbeCheck: {
        scanSecrets: true,
        scanSecretsFor: () => {
          throw new Error('candidate cq.json unreadable');
        },
      },
    });
    expect(r.probeRoots).toEqual([r.probeDir]);
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the probe phase threw — candidate cq.json unreadable');
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('a thrown probe check releases the worktree and branch with attribution', async () => {
    const r = await run({ greens: [true, false], stop: 'budget', probeThrows: 'ledger corrupt' });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the probe phase threw — ledger corrupt');
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('a green probe that overruns the reserve publishes nothing', async () => {
    const r = await run({ greens: [true, false], stop: 'budget', probeAdvanceMs: 60 * 60 * 1000 });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toContain('the probes overran the reserve');
      expect(r.result.error).toContain('nothing published');
    }
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([]);
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
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

  test('an install failure publishes nothing and removes the worktree', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      installDeps: async () => {
        throw new Error('offline store miss');
      },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('dependency install failed — offline store miss');
    expect(r.probeRoots).toEqual([]);
    expectAuthorUntouched(r);
  });

  test.each([
    ['no installDeps hook', { installDeps: null }],
    ['push opted out', { push: false }],
  ] as const)('%s: the red final result is returned verbatim', async (_label, extra) => {
    const r = await run({ greens: [true, false], stop: 'budget', ...extra });
    expect(r.result).toEqual({
      status: 'failed',
      error:
        'dev.cycle (dev.check (final)): dev.check: 1 gate(s) red (format:check) — record k002-final is in the branch dev-record',
    });
    expect(r.probeRoots).toEqual([]);
    expect(r.installs).toEqual([]);
  });
});

test('renderFindingsSection without a selection is unchanged by #536', () => {
  const report = {
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
