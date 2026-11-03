// Split provenance: test/ops/review/addressBookkeeping.test.ts was split into the
// addressBookkeeping.*.test.ts siblings in this directory; the shared fixtures and
// helpers live here.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { makeAddressBookkeepingReceipt } from '../../../src/ops/review/internal/addressBookkeeping.js';
import { DEV_LEDGER_VERSION, devLedgerPath } from '../../../src/ops/dev/record.js';
import { makeTestRepo } from '../dev/repo.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';

export const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

export async function fixture() {
  const repo = await makeTestRepo();
  const root = await realpath(repo.root);
  const head = repo.git('rev-parse', 'HEAD').trim();
  const branch = 'feature/x';
  const path = join(root, '.git/cq-review-address/test/bookkeeping.json');
  const ledger = devLedgerPath(root, branch);
  const history = join(root, '.cq/review', encodeURIComponent(branch), '1.json');
  const ledgerText =
    JSON.stringify({
      version: DEV_LEDGER_VERSION,
      branch,
      records: [
        {
          kind: 'disposition',
          findingId: 'f',
          action: 'fixed',
          why: 'verified locally',
          head,
          at: '2026-10-24T00:00:00Z',
        },
      ],
    }) + '\n';
  const historyText =
    JSON.stringify({ schemaVersion: 1, branch, head, sources: [], findings: [] }) + '\n';
  await mkdir(dirname(path), { recursive: true });
  await mkdir(dirname(ledger), { recursive: true });
  await mkdir(dirname(history), { recursive: true });
  let beforeGit: ((args: string[]) => Promise<void>) | undefined;
  const make = (fingerprints = new Map<string, string>()) => ({
    fingerprints,
    receipt: makeAddressBookkeepingReceipt({
      path,
      identity: 'test-identity',
      fingerprints,
      git: async (cwd, args) => {
        await beforeGit?.(args);
        return repo.git('-C', cwd, ...args).trim();
      },
    }),
  });
  const original = make();
  await original.receipt.prepare(root);
  await writeFile(ledger, ledgerText);
  await writeFile(history, historyText);
  original.fingerprints.set(ledger, hash(ledgerText));
  original.fingerprints.set(history, hash(historyText));
  await original.receipt.persist();
  return {
    repo,
    root,
    branch,
    head,
    path,
    ledger,
    ledgerText,
    history,
    historyText,
    make,
    original,
    setBeforeGit: (action: (args: string[]) => Promise<void>) => {
      beforeGit = action;
    },
  };
}

export function ownershipReceipt() {
  const paths: unknown[] = [];
  return JSON.stringify({
    version: 1,
    item_id: 'current-ownership',
    request_id: 'original',
    source: {
      repo: 'owner/repo',
      pr: 1,
      merge_sha: 'a'.repeat(40),
      target_selector: 'promoted-main',
      policy: 'affected-current-additions-v1',
    },
    capture: {
      target: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      paths,
      scope_digest: createHash('sha256').update('[]').digest('hex'),
      equivalence: 'd'.repeat(64),
      policy: 'affected-current-additions-v1',
      projection: 'current-affected-files/full-file-addition-projection',
      reviewer: 'coderabbit-review-agent-committed-v1',
      reviewer_version: 'fixture',
      captured_at: '2026-10-28T00:00:00Z',
    },
    outcome: 'no-current-code',
    counted: false,
    classification: null,
    findings: [],
    run_id: null,
    started_at: null,
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  });
}

let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;
/** Scoped gitleaks/git env for the M7-address real-path cases only. */
export async function withUsageEnv<T>(fn: () => Promise<T>): Promise<T> {
  scanner = await makeGitleaksFixture();
  vi.stubEnv('PATH', scanner.path);
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
  vi.stubEnv('GIT_AUTHOR_NAME', 'Review fixture');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'review-fixture@example.invalid');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Review fixture');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'review-fixture@example.invalid');
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
    await rm(scanner.root, { recursive: true, force: true });
  }
}

interface UsageHarness {
  op: ReturnType<typeof makeReviewAddress>;
  repoRoot: string;
  journalDir: string;
  runs: number;
  /** Usage each driver run reports; a null entry reports unmeasured spend. */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  /** When set, the Nth driver run (1-based) throws after settling usage. */
  throwOnRun?: number;
  /** The parent abort signal. The driver's settle path checks
   * `state.abortSignal?.aborted` and rejects the dispatch when it is
   * already aborted; `holdUntilAbortAfter` additionally holds a later
   * dispatch in flight until this signal fires, then rejects it. */
  abortSignal?: AbortSignal | undefined;
  /**
   * When set with abortSignal, every dispatch AFTER this 1-based run index
   * pends until the abort lands and then rejects: dispatches that start,
   * are cut down, and must settle as explicit unknowns. 0 = every dispatch.
   */
  holdUntilAbortAfter?: number | undefined;
  /** Last completed dispatch's output schema name, for abort timing. */
  lastSchema?: string | undefined;
  cleanup: () => Promise<void>;
}

export async function usageHarness(
  overrides: Partial<
    Pick<UsageHarness, 'usage' | 'throwOnRun' | 'abortSignal' | 'holdUntilAbortAfter'>
  > = {},
): Promise<UsageHarness & { start: number }> {
  const state: UsageHarness & { start: number } = {
    runs: 0,
    usage:
      overrides.usage === undefined
        ? { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }
        : overrides.usage,
    ...(overrides.throwOnRun === undefined ? {} : { throwOnRun: overrides.throwOnRun }),
    ...(overrides.abortSignal === undefined ? {} : { abortSignal: overrides.abortSignal }),
    ...(overrides.holdUntilAbortAfter === undefined
      ? {}
      : { holdUntilAbortAfter: overrides.holdUntilAbortAfter }),
    lastSchema: undefined,
    repoRoot: '',
    journalDir: '',
    op: undefined as unknown as ReturnType<typeof makeReviewAddress>,
    cleanup: async () => undefined,
    start: 0,
  };
  const repo = await makeTestRepo();
  repo.git('config', 'user.name', 'Test');
  repo.git('config', 'user.email', 'test@example.invalid');
  const journalDir = await mkdtemp(join(tmpdir(), 'cq-address-usage-'));
  const role = { provider: 'mock', model: 'worker' };
  const config: CqConfig = {
    schemaVersion: 2,
    checks: [
      { adapter: 'tsc-lines', command: { command: process.execPath, args: ['scripts/check.cjs'] } },
    ],
    roles: {
      worker: role,
      reviewer: { ...role, model: 'reviewer' },
    },
    review: { reviewers: ['agent'], rounds: 1 },
    budgets: { run: { maxTokens: 10000, wallMs: 20000 }, step: { wallMs: 5000 } },
    escalation: { workerAttempts: 1, rescueBase: 0 },
  };
  await repo.write('.gitignore', '.cq/\n');
  await repo.write('src/a.ts', 'export const a = "BAD";\n');
  await repo.write('scripts/check.cjs', 'process.exitCode = 0;\n');
  await repo.write('cq.json', JSON.stringify(config));
  repo.commitAll('review address usage fixture');
  const head = repo.git('rev-parse', 'HEAD').trim();
  const finding: Finding = {
    id: 'seed-a',
    source: 'agent',
    file: 'src/a.ts',
    line: 1,
    severity: 'major',
    text: 'Replace BAD with GOOD',
    status: 'open',
  };
  const record: FindingsRecord = {
    schemaVersion: 1,
    branch: 'feature/x',
    head,
    sources: [{ kind: 'agent', status: 'terminal' }],
    findings: [finding],
  };
  const drivers: DriverFactory = {
    resolve: (request) => ({
      lane: 'ai-sdk',
      modelSpec: request.modelSpec,
      driver: {
        run: async (input) => {
          state.runs += 1;
          const run = state.runs;
          const content = await readFile(join(input.workspace!.path, 'src/a.ts'), 'utf8');
          if (state.throwOnRun === run) {
            // A REAL post-settlement fault: the dispatch itself throws.
            throw new Error(`driver run ${run} lost after settlement`);
          }
          if (state.abortSignal?.aborted === true) {
            // A REAL dispatch cut down by the parent cancel: it rejects, so
            // the engine settles it as an explicit unknown observation.
            throw new Error('parent cancelled; dispatch aborted');
          }
          if (
            state.holdUntilAbortAfter !== undefined &&
            run > state.holdUntilAbortAfter &&
            state.abortSignal
          ) {
            // Hold the second dispatch IN FLIGHT until the cancel lands, then
            // reject: the dispatch started, so its rejection is an explicit
            // unknown, never a silent drop.
            const signal = state.abortSignal;
            if (!signal.aborted)
              await new Promise<void>((done) =>
                signal.addEventListener('abort', () => done(), { once: true }),
              );
            throw new Error('parent cancelled; dispatch aborted');
          }
          let structuredOutput: unknown;
          state.lastSchema = input.outputSchema?.name;
          if (input.outputSchema?.name === 'review.agent/v3') {
            const serialized = JSON.stringify({
              prompt: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
            });
            await request.beforeRequest?.(serialized, [{ text: input.prompt }], {
              kind: 'model-request',
            });
            structuredOutput = {
              findings: content.includes('BAD')
                ? [{ file: 'src/a.ts', line: 1, severity: 'high', text: finding.text }]
                : [],
            };
          } else if (input.outputSchema?.name === 'review.address.closure/v1')
            structuredOutput = { closed: content.includes('GOOD'), reason: 'verified candidate' };
          else {
            if (!input.prompt.startsWith('related-check feedback'))
              await writeFile(
                join(input.workspace!.path, 'src/a.ts'),
                content.replace('BAD', 'GOOD'),
              );
            structuredOutput = { disposition: 'fixed', reason: 'fixed seeded issue', evidence: [] };
          }
          return {
            stopReason: 'complete' as const,
            structuredOutput,
            ...(state.usage === null
              ? // Legacy result: usage without provenance. The engine treats
                // absence as unknown, and the ledger must agree.
                { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
              : { usage: state.usage, usageProvenance: 'measured' as const }),
            denials: [],
          };
        },
      },
    }),
  };
  state.repoRoot = repo.root;
  state.journalDir = journalDir;
  state.op = makeReviewAddress({ drivers, initialRecord: record });
  state.cleanup = async () => {
    await repo.cleanup();
    await rm(journalDir, { recursive: true, force: true });
  };
  const start = Date.now();
  // state IS the harness: the driver closures and the test both hold this
  // same object, so live counters (runs, exhausted) are visible to both.
  return Object.assign(state, { start });
}
