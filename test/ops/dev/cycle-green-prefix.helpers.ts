// Split provenance: test/ops/dev/cycle-green-prefix.test.ts was split by
// subject into cycle-green-prefix.selection.test.ts,
// cycle-green-prefix.red-final.test.ts, cycle-green-prefix.probe-scan.test.ts,
// cycle-green-prefix.install.test.ts, cycle-green-prefix.publication.test.ts
// and cycle-green-prefix.worktree.test.ts. This module holds the shared
// scenario harness (the real-git repo fixture wiring, the scripted op legs and
// the two shared assertions); it declares no tests.
import { expect, vi } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeDevCycle } from '../../../src/ops/dev/cycle.js';
import type { DevCheckInput, DevCheckReport } from '../../../src/ops/dev/check.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { DEV_LEDGER_VERSION, type DevCheckRecord } from '../../../src/ops/dev/record.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import type { PrOpenInput, PrOpenReport } from '../../../src/ops/pr/open.js';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import type { AddressFix } from '../../../src/ops/review/addressWorker.js';
import type { OpResult } from '../../../src/kernel/types.js';
import { checkRecord, stubScanner } from './fakes.js';
import { repoEffects, type TestRepo } from './repo.js';

export const BRANCH = 'feature/x';

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
  const read = await readWorkState(effects, { target: 'main' });
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

export interface Scenario {
  laterUncommittedRed?: boolean;
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
  /**
   * Use the DEFAULT probe publication leg (no openIn): the harness still
   * wires a stub author scanner, and the probe-root factory is the
   * scenario's `probeScannerFor` (omit it for the unbindable-probe refusal).
   * The factory's received roots are recorded for the root-binding assertion.
   */
  defaultProbePublication?: {
    probeScannerFor?: (root: string) => DiffSecretScanner | undefined;
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
  /** Change a dependency input in the fix at this chain index. */
  dependencyChangeAt?: number;
  /** The dependency input changed (default package.json). */
  dependencyFile?: string;
  /** Inject `open` without `gh` and no `openIn` (the injected leg owns the forge). */
  injectedOpenOwnsForge?: boolean;
  /** Called at the start of each probe check. */
  onProbe?: () => void;
  /** Scripted author-side git commands (a race injected before real git runs). */
  authorHandler?: Parameters<typeof repoEffects>[1];
  /** Replace the probe worktree's pr.open result (or throw). */
  openInResult?: () => Promise<OpResult<PrOpenReport>>;
  /** The findings-section body edit throws. */
  ghEditThrows?: string;
  /** Hits the probe publication scanner returns (the findings-compose refusal). */
  probePublicationHits?: { component: string; ruleId: string }[];
  /** The red final check returns this non-failed status instead. */
  finalCheckStatus?: 'budget-exhausted';
  /** The final check's ledger record says passed although the leg failed. */
  finalRecordPassed?: boolean;
}

export async function run(repo: TestRepo, scenario: Scenario) {
  const author = repoEffects(repo, scenario.authorHandler);
  const admitted = repo.git('rev-parse', 'HEAD').trim();
  const commits: string[] = [];
  const verdicts = new Map<string, boolean>();
  const pushes: string[][] = [];
  const opens: { input: PrOpenInput; root: string }[] = [];
  const installs: string[] = [];
  const probeRoots: string[] = [];
  const probeSteps: DevCheckInput[] = [];
  const publicationProbeRoots: string[] = [];
  let pushedSha: string | undefined;
  let authorChecks = 0;
  const bodies: string[] = [];
  let body = '<!-- cq:dev-readiness-gaps -->\nGAPS\n<!-- /cq:dev-readiness-gaps -->';
  const gh = {
    getPrBody: async () => body,
    editPrBody: async (_n: number, next: string) => {
      if (scenario.ghEditThrows !== undefined) throw new Error(scenario.ghEditThrows);
      bodies.push(next);
      body = next;
    },
  } as unknown as PrEffects;

  const op = makeDevCycle({
    effects: author,
    ...(scenario.injectedOpenOwnsForge === true
      ? {
          open: async () => {
            throw new Error('the injected open leg must not be called on a red final gate');
          },
        }
      : { gh }),
    ...(scenario.push === undefined ? {} : {}),
    check: async () => {
      authorChecks += 1;
      if (authorChecks === 1) return scriptedCheck(author, true, 'k001-open');
      scenario.beforeFinal?.(commits.at(-1)!);
      if (scenario.finalCheckMs !== undefined) {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + scenario.finalCheckMs);
      }
      if (scenario.finalCheckStatus !== undefined) return { status: scenario.finalCheckStatus };
      if (scenario.finalRecordPassed === true) {
        await scriptedCheck(author, true, 'k002-final');
        if (scenario.laterUncommittedRed === true) {
          const read = await readWorkState(author, { target: 'main' });
          if (!read.ok) throw new Error(read.reason);
          appendCheck(
            author,
            read.state.branch,
            checkRecord({
              head: read.state.head,
              base: read.state.base,
              dirtySha256: read.state.dirtySha256,
              scope: 'uncommitted',
              passed: false,
              gates: [
                {
                  name: 'format:check',
                  status: 'fail',
                  durationMs: 0,
                  evidence: 'limited-scope failure',
                },
              ],
            }),
          );
        }
        return { status: 'failed', error: 'dev.check: the final gate failed' };
      }
      return scriptedCheck(author, false, 'k002-final');
    },
    review: async () => {
      const read = await readWorkState(author, { target: 'main' });
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
          await repo.write(
            scenario.dependencyFile ?? 'package.json',
            `{"name":"fixture","version":"1.0.${String(index)}"}\n`,
          );
        // Commit the fix files only: `.cq/` holds the ledger and stays untracked.
        repo.git(
          'add',
          'src/a.ts',
          ...(scenario.dependencyChangeAt === index
            ? [scenario.dependencyFile ?? 'package.json']
            : []),
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
        version: 1,
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
            const read = await readWorkState(effects, { target: 'main' });
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
    // The publication scanners the default legs bind (production always
    // carries them; the findings-section composes scan under their rules).
    // A scenario using the DEFAULT probe publication leg overrides the
    // factory (or omits it for the unbindable-probe refusal); otherwise the
    // stub factory records its root and returns a clean scanner.
    publicationScanner: stubScanner(),
    publicationScannerFor: (root: string) => {
      publicationProbeRoots.push(root);
      if (scenario.defaultProbePublication?.probeScannerFor !== undefined)
        return scenario.defaultProbePublication.probeScannerFor(root);
      // A probe hit scenario: the findings compose scans under the probe
      // root's rules, so the probe scanner carries the hits.
      if (scenario.probePublicationHits !== undefined)
        return stubScanner(scenario.probePublicationHits);
      return stubScanner();
    },
    ...(scenario.injectedOpenOwnsForge === true
      ? {}
      : scenario.defaultProbePublication !== undefined
        ? {}
        : {
            openIn: (effects: DevEffects, root: string) => async (input: PrOpenInput) => {
              opens.push({ input, root });
              if (scenario.openInResult !== undefined) return scenario.openInResult();
              const read = await readWorkState(effects, { target: 'main' });
              if (!read.ok) throw new Error(read.reason);
              const value: PrOpenReport = {
                number: 77,
                url: 'https://example.invalid/pull/77',
                created: true,
                base: input.target ?? 'main',
                head: read.state.head,
                branch: read.state.branch,
                evidenceClass: 'author',
                ready: false,
              };
              return { status: 'ok', value };
            },
          }),
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
    publicationProbeRoots,
    bodies,
    probeDir,
    probeParent,
    probePrefix,
    pub,
    author,
  };
}

/** The author's branch, head and ledger stay exactly where the run left them. */
export function expectAuthorUntouched(repo: TestRepo, r: Awaited<ReturnType<typeof run>>): void {
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

/**
 * Every #638 exit carries the typed usage envelope. These fixtures script all
 * legs (no driver is ever dispatched), so the truthful summary is zero known,
 * zero unknown and zero unpriced — and no invented `usage`/`costUSD` rides it.
 */
export function expectNoDispatchUsage(r: Awaited<ReturnType<typeof run>>): void {
  expect(r.result).toHaveProperty('report.usageSummary', {
    knownCount: 0,
    unknownCount: 0,
    unpricedCount: 0,
  });
}

/**
 * Bind the harness to one test file's per-test repo fixture: every split file
 * owns `repo` through its own beforeEach/afterEach pair, so `run` and
 * `expectAuthorUntouched` must resolve it at call time, not at import time.
 */
export function bindCycleHarness(bind: () => TestRepo): {
  run: (scenario: Scenario) => ReturnType<typeof run>;
  expectAuthorUntouched: (r: Awaited<ReturnType<typeof run>>) => void;
} {
  return {
    run: (scenario) => run(bind(), scenario),
    expectAuthorUntouched: (r) => expectAuthorUntouched(bind(), r),
  };
}
