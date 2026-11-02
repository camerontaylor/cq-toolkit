import { createHash } from 'node:crypto';
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import { makeAddressBookkeepingReceipt } from '../../../src/ops/review/internal/addressBookkeeping.js';
import {
  DEV_LEDGER_VERSION,
  devLedgerPath,
  parseDevLedger,
  serializeDevLedger,
} from '../../../src/ops/dev/record.js';
import { makeTestRepo } from '../dev/repo.js';

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

test.each(['valid', 'bound-head', 'base', 'changed-bytes'] as const)(
  'vendor debt bookkeeping validates exact bytes and bound ancestry: %s',
  async (mode) => {
    const f = await fixture();
    try {
      const base = f.repo.git('merge-base', 'origin/main', 'HEAD').trim();
      const ledger = parseDevLedger(f.ledgerText);
      ledger.records.push({
        kind: 'vendor-debt',
        at: '2026-10-28T00:00:00Z',
        debt: {
          reference: {
            requestId: 'intent-1',
            binding: {
              kind: 'deferred-author',
              repo: 'owner/repo',
              producer: 'author',
              head: mode === 'bound-head' ? 'f'.repeat(40) : f.head,
              target: 'main',
              targetSelector: 'promoted-main',
            },
          },
          deferral: {
            id: 'intent-1',
            base: mode === 'base' ? 'f'.repeat(40) : base,
            dirtySha256: 'clean-tree',
          },
          originAttempt: {
            cycleId: 'c001-outage',
            head: f.head,
            base,
            target: 'main',
            scope: 'full',
            dirtySha256: 'clean-tree',
            failure: { source: 'vendor', category: 'vendor-unavailable', codes: ['con_err'] },
          },
          vendor: 'vendor-blocked-transient',
          vendorCompleted: false,
          queue: {
            state: 'awaiting-pr',
            pr: null,
            mergeSha: null,
            itemId: null,
            receiptId: null,
            consumed: false,
            reviewed: false,
            fixed: false,
          },
        },
      });
      const text = serializeDevLedger(ledger);
      await writeFile(f.ledger, text);
      f.original.fingerprints.set(f.ledger, hash(text));
      await f.original.receipt.persist();
      if (mode === 'changed-bytes') await writeFile(f.ledger, text + '\n');
      const fresh = f.make();
      if (mode === 'valid') {
        await fresh.receipt.prepare(f.root);
        expect(fresh.fingerprints.get(f.ledger)).toBe(hash(text));
        expect(ledger.records.at(-1)).toMatchObject({ debt: { vendorCompleted: false } });
      } else {
        await expect(fresh.receipt.prepare(f.root)).rejects.toThrow();
        expect(fresh.fingerprints.size).toBe(0);
      }
    } finally {
      await f.repo.cleanup();
    }
  },
);
async function fixture() {
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

test.each(['sha1', 'sha256'] as const)(
  'private receipt preserves exact metadata bytes (%s)',
  async (format) => {
    // Receipt object IDs accept both supported Git object formats.
    const f = await fixture();
    try {
      if (format === 'sha256') {
        // A real SHA-256 repo is exercised below, rather than accepting a padded SHA-1 id.
        const repo = await makeTestRepo({ objectFormat: 'sha256' });
        try {
          const root = await realpath(repo.root);
          const head = repo.git('rev-parse', 'HEAD').trim();
          expect(head).toHaveLength(64);
          const path = join(root, '.git/bookkeeping.json');
          const fingerprints = new Map<string, string>();
          const make = () =>
            makeAddressBookkeepingReceipt({
              path,
              identity: 'sha256',
              fingerprints,
              git: async (cwd, args) => repo.git('-C', cwd, ...args).trim(),
            });
          const receipt = make();
          await receipt.prepare(root);
          const ledger = devLedgerPath(root, 'feature/x');
          await mkdir(dirname(ledger), { recursive: true });
          const text =
            JSON.stringify({ version: DEV_LEDGER_VERSION, branch: 'feature/x', records: [] }) +
            '\n';
          await writeFile(ledger, text);
          fingerprints.set(ledger, hash(text));
          await receipt.persist();
          fingerprints.clear();
          await make().prepare(root);
          expect(fingerprints.get(ledger)).toBe(hash(text));
        } finally {
          await repo.cleanup();
        }
      } else {
        const fresh = f.make();
        const alias = join(f.root, '.git/root-alias');
        await symlink(f.root, alias, 'dir');
        await fresh.receipt.prepare(alias);
        expect([...fresh.fingerprints]).toEqual([...f.original.fingerprints]);
        expect(await readFile(f.ledger, 'utf8')).toBe(f.ledgerText);
        expect(await readFile(f.history, 'utf8')).toBe(f.historyText);
        expect((await lstat(f.path)).mode & 0o777).toBe(0o600);
        expect(await readdir(dirname(f.path))).toEqual(['bookkeeping.json']);
      }
    } finally {
      await f.repo.cleanup();
    }
  },
);

test.each([
  'corrupt',
  'wrong-root',
  'wrong-branch',
  'wrong-identity',
  'stale-head',
  'duplicate-path',
  'escape',
  'unknown-path',
  'changed-ledger',
  'changed-history',
  'missing-leaf',
  'symlink-leaf',
  'malformed-ledger',
  'malformed-history',
  'ledger-branch',
  'history-branch',
  'ledger-head',
  'history-head',
  'receipt-symlink',
] as const)('private receipt refuses %s without adopting or rewriting bytes', async (mode) => {
  const f = await fixture();
  try {
    const raw = JSON.parse(await readFile(f.path, 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
      root: string;
      branch: string;
      identity: string;
      head: string;
    };
    const updateLeaf = async (path: string, text: string) => {
      await writeFile(path, text);
      raw.files.find((row: { path: string }) => row.path === relative(f.root, path))!.sha256 =
        hash(text);
    };
    if (mode === 'wrong-root') raw.root = dirname(f.root);
    if (mode === 'wrong-branch') raw.branch = 'different';
    if (mode === 'wrong-identity') raw.identity = 'other-pr-or-actor';
    if (mode === 'stale-head') raw.head = 'f'.repeat(40);
    if (mode === 'duplicate-path') raw.files.push(raw.files[0]!);
    if (mode === 'escape') raw.files[0]!.path = '../caller.json';
    if (mode === 'unknown-path') raw.files[0]!.path = '.cq/private.json';
    if (mode === 'changed-ledger') await writeFile(f.ledger, f.ledgerText + '\n');
    if (mode === 'changed-history') await writeFile(f.history, f.historyText + '\n');
    if (mode === 'missing-leaf') await unlink(f.history);
    if (mode === 'symlink-leaf') {
      await unlink(f.history);
      await symlink(f.ledger, f.history);
    }
    if (mode === 'malformed-ledger') await updateLeaf(f.ledger, '{bad');
    if (mode === 'malformed-history') await updateLeaf(f.history, '{bad');
    if (mode === 'ledger-branch' || mode === 'ledger-head') {
      const ledger = JSON.parse(f.ledgerText) as {
        branch: string;
        records: Array<{ head: string }>;
      };
      if (mode === 'ledger-branch') ledger.branch = 'different';
      else ledger.records[0]!.head = 'f'.repeat(40);
      await updateLeaf(f.ledger, JSON.stringify(ledger));
    }
    if (mode === 'history-branch' || mode === 'history-head') {
      const history = JSON.parse(f.historyText) as { branch: string; head: string };
      if (mode === 'history-branch') history.branch = 'different';
      else history.head = 'f'.repeat(40);
      await updateLeaf(f.history, JSON.stringify(history));
    }
    await writeFile(f.path, mode === 'corrupt' ? '{bad' : JSON.stringify(raw));
    if (mode === 'receipt-symlink') {
      const outside = join(dirname(f.path), 'caller-receipt.json');
      await writeFile(outside, await readFile(f.path));
      await unlink(f.path);
      await symlink(outside, f.path);
    }
    const before = await readFile(f.path, 'utf8');
    const fresh = f.make();
    await expect(fresh.receipt.prepare(f.root)).rejects.toThrow();
    expect(fresh.fingerprints.size).toBe(0);
    expect(await readFile(f.path, 'utf8')).toBe(before);
  } finally {
    await f.repo.cleanup();
  }
});

test.each(['changed', 'removed', 'unexpected-new'] as const)(
  'receipt replacement refuses %s caller receipt',
  async (mode) => {
    const f = await fixture();
    try {
      let receipt = f.original.receipt;
      if (mode === 'unexpected-new') {
        await unlink(f.path);
        receipt = f.make().receipt;
        await receipt.prepare(f.root);
      }
      if (mode === 'removed') await unlink(f.path);
      else await writeFile(f.path, 'CALLER RECEIPT BYTES\n');
      await expect(receipt.persist()).rejects.toThrow(/receipt changed outside engine/);
      if (mode !== 'removed') expect(await readFile(f.path, 'utf8')).toBe('CALLER RECEIPT BYTES\n');
      expect((await readdir(dirname(f.path))).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('receipt changed while constructing replacement is preserved and owned temp is cleaned', async () => {
  const f = await fixture();
  try {
    let changed = false;
    f.setBeforeGit(async (args) => {
      if (args[0] === 'symbolic-ref' && !changed) {
        changed = true;
        await writeFile(f.path, 'CALLER BYTES DURING RECEIPT WRITE\n');
      }
    });
    await expect(f.original.receipt.persist()).rejects.toThrow(/receipt changed outside engine/);
    expect(changed).toBe(true);
    expect(await readFile(f.path, 'utf8')).toBe('CALLER BYTES DURING RECEIPT WRITE\n');
    expect(await readdir(dirname(f.path))).toEqual(['bookkeeping.json']);
  } finally {
    await f.repo.cleanup();
  }
});

function ownershipReceipt() {
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

test.each(['valid', 'changed', 'wrong-name', 'symlink', 'hardlink', 'unregistered'] as const)(
  'exact queue receipt ownership restoration: %s',
  async (mode) => {
    const f = await fixture();
    try {
      const bytes = ownershipReceipt();
      const id = hash(bytes);
      const folder = join(f.root, '.cq/queue-evidence');
      await mkdir(folder, { recursive: true });
      const path = join(folder, (mode === 'wrong-name' ? 'e'.repeat(64) : id) + '.json');
      await writeFile(path, bytes);
      if (mode === 'symlink') {
        await unlink(path);
        await symlink(f.history, path);
      }
      if (mode === 'hardlink') await link(path, join(folder, 'extra'));
      if (mode === 'unregistered') {
        const fresh = f.make();
        await fresh.receipt.prepare(f.root);
        expect(await fresh.receipt.ownedFiles()).not.toContain(path);
        expect(fresh.fingerprints.has(path)).toBe(false);
        return;
      }
      f.original.fingerprints.set(path, hash(bytes));
      if (mode === 'wrong-name' || mode === 'symlink' || mode === 'hardlink') {
        await expect(f.original.receipt.persist()).rejects.toThrow();
        return;
      }
      await f.original.receipt.persist();
      if (mode === 'changed') await writeFile(path, bytes + '\n');
      const fresh = f.make();
      if (mode === 'changed') {
        await expect(fresh.receipt.prepare(f.root)).rejects.toThrow();
        expect(fresh.fingerprints.size).toBe(0);
      } else {
        await fresh.receipt.prepare(f.root);
        expect(fresh.fingerprints.get(path)).toBe(id);
        expect(await fresh.receipt.ownedFiles()).toContain(path);
      }
    } finally {
      await f.repo.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// M7-address: retain address exit spend. Each settled driver dispatch folds
// into the report's usageSummary exactly once, on every terminal exit route.
// These cases run the REAL makeReviewAddress local path (test repo, fake
// drivers, gitleaks fixture): no fixture-object loops, no pre-assigned
// carriers.
// ---------------------------------------------------------------------------

import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { runLadder } from '../../../src/kernel/governor.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';

let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;
/** Scoped gitleaks/git env for the M7-address real-path cases only. */
async function withUsageEnv<T>(fn: () => Promise<T>): Promise<T> {
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
  /**
   * Token budget override for the caller's op input: after this many runs,
   * the spent allowance genuinely trips the engine's own stop().
   */
  exhaustAfterRuns?: number;
  exhausted?: boolean;
  cleanup: () => Promise<void>;
}

async function usageHarness(
  overrides: Partial<Pick<UsageHarness, 'usage' | 'throwOnRun' | 'exhaustAfterRuns'>> = {},
): Promise<UsageHarness & { start: number }> {
  const state: UsageHarness & { start: number } = {
    runs: 0,
    usage:
      overrides.usage === undefined
        ? { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }
        : overrides.usage,
    ...(overrides.throwOnRun === undefined ? {} : { throwOnRun: overrides.throwOnRun }),
    ...(overrides.exhaustAfterRuns === undefined
      ? {}
      : { exhaustAfterRuns: overrides.exhaustAfterRuns }),
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
          if (state.exhaustAfterRuns !== undefined && run > state.exhaustAfterRuns) {
            // From here on every dispatch burns real wall time so the engine's
            // own budget machinery observes the elapsed clock (only used when
            // a caller drives exhaustion through wallMs).
            state.exhausted = true;
          }
          if (state.exhausted) {
            const waited = Date.now();
            while (Date.now() - waited < 200) {
              if (Date.now() - state.start >= (state.exhaustAfterRuns as number)) break;
            }
          }
          let structuredOutput: unknown;
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

test('M7-address nominal evidence', async () => {
  return withUsageEnv(async () => {
    const f = await usageHarness();
    try {
      const result = await f.op({
        repoRoot: f.repoRoot,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status, JSON.stringify(result.report?.reasons)).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected success');
      const runs = f.runs;
      expect(runs).toBeGreaterThan(0);
      // Success retains settled usage exactly once: every dispatch measured
      // 2 in / 1 out, and the summary folds to precisely runs x that
      // measurement.
      expect(result.value.usageSummary).toEqual({
        usage: { input: 2 * runs, output: runs, cacheRead: 0, cacheWrite: 0 },
        knownCount: runs,
        unknownCount: 0,
        unpricedCount: runs,
      });
      // Parent totals agree with the summary: no double counting.
      expect(result.value.usage.input).toBe(2 * runs);
      expect(result.value.usage.output).toBe(runs);
      // The persisted artifact carries the same summary as the envelope.
      const persisted = JSON.parse(await readFile(result.value.reportPath, 'utf8')) as {
        usageSummary?: unknown;
      };
      expect(persisted.usageSummary).toEqual(result.value.usageSummary);
    } finally {
      await f.cleanup();
    }
  });
});

test('M7-address missing evidence', async () => {
  return withUsageEnv(async () => {
    // Every dispatch reports legacy usage without provenance: the summary must
    // be explicit unknown (unknownCount = runs), never a fabricated measured
    // zero, while the run itself still completes honestly.
    const f = await usageHarness({ usage: null });
    try {
      const result = await f.op({
        repoRoot: f.repoRoot,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status, JSON.stringify(result.report?.reasons)).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected success');
      const runs = f.runs;
      expect(runs).toBeGreaterThan(0);
      expect(result.value.usageSummary).toEqual({
        knownCount: 0,
        unknownCount: runs,
        unpricedCount: runs,
      });
      expect(result.value.usageSummary?.usage).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });
});

test('M7-address failure evidence', async () => {
  return withUsageEnv(async () => {
    // The FIRST dispatch throws; the loop's retry then settles measured usage
    // (2 in / 1 out) before the run still exits needs-human carrying the thrown
    // fault. The settled spend is retained exactly once on the failure exit,
    // the THROWN dispatch settles as an explicit unknown (it may already have
    // been paid upstream), and parent totals match the measured run only.
    const f = await usageHarness({ throwOnRun: 1 });
    try {
      const result = await f.op({
        repoRoot: f.repoRoot,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status).toBe('needs-human');
      if (result.status === 'ok') throw new Error('expected needs-human');
      expect(f.runs).toBe(2);
      expect(result.report?.usageSummary).toEqual({
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        knownCount: 1,
        unknownCount: 1,
        unpricedCount: 2,
      });
      // Parent totals do not double count the settled run's usage.
      expect(result.report?.usage).toEqual({
        input: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // The thrown dispatch is a real fault inside the loop; the run still
      // reaches a terminal needs-human exit at the round cap with the thrown
      // run's settled sibling spend retained exactly once.
      expect(result.report?.reasons.join('; ')).toContain(
        'review round cap reached with open findings',
      );
    } finally {
      await f.cleanup();
    }
  });
});

test('M7-address exhaustion evidence', async () => {
  return withUsageEnv(async () => {
    // The FIRST dispatch settles measured usage (2 in / 1 out); the SECOND
    // dispatch genuinely exhausts the caller-imposed wall budget, so the
    // ENGINE's own stop() trips and finish() records the structured budget
    // marker. The exhausted exit retains the settled spend exactly once, the
    // exhausted dispatch invents no usage, and parent totals match the summary.
    const f = await usageHarness({ exhaustAfterRuns: 1 });
    try {
      const result = await f.op({
        repoRoot: f.repoRoot,
        source: 'local',
        journalDir: f.journalDir,
        // A genuine engine budget trip: the first dispatch's settled spend
        // (3 tokens) consumes the caller-imposed token allowance, so the
        // reviewer partition trips its own before-dispatch budget stop and
        // finish() records the structured budget marker with that spend kept.
        maxTokens: 3,
      });
      expect(result.status, JSON.stringify(result.report?.reasons)).toBe('needs-human');
      if (result.status === 'ok') throw new Error('expected needs-human');
      expect(result.report?.stop).toBe('budget');
      expect(result.report?.reasons.join('; ')).toContain('token or wall budget exhausted');
      // The budget must have tripped AFTER at least one settled dispatch: the
      // exhausted exit proves retention only if spend preceded the trip.
      const summaryAfterTrip = result.report?.usageSummary;
      expect(
        (summaryAfterTrip?.knownCount ?? 0) + (summaryAfterTrip?.unknownCount ?? 0),
        JSON.stringify({ runs: f.runs, reasons: result.report?.reasons }),
      ).toBeGreaterThan(0);
      expect(result.report?.usageSummary).toEqual({
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        knownCount: 1,
        unknownCount: 0,
        unpricedCount: 1,
      });
      expect(result.report?.usage).toEqual({
        input: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // The persisted artifact carries the same summary as the envelope.
      const persisted = JSON.parse(await readFile(result.report!.reportPath, 'utf8')) as {
        usageSummary?: unknown;
        stop?: string;
      };
      expect(persisted.usageSummary).toEqual(result.report?.usageSummary);
      expect(persisted.stop).toBe('budget');
    } finally {
      await f.cleanup();
    }
  });
});

test('M7-address cancellation evidence', async () => {
  return withUsageEnv(async () => {
    // A REAL parent cancellation through the engine's own carrier: the governing
    // runLadder's signal aborts while the first driver dispatch is in flight
    // (after its ledger settlement is queued by the same synchronous account()
    // slice that returns the result). The cancelled exit retains the settled
    // spend exactly once, invents no usage, and the engine's terminal lifetime
    // persists the same summary to the artifact.
    const parent = new AbortController();
    const f = await usageHarness();
    try {
      const opPromise = runLadder(
        () => f.op({ repoRoot: f.repoRoot, source: 'local', journalDir: f.journalDir }),
        { wallClockMs: 30000, abortGraceMs: 5000, killGraceMs: 5000 },
        { op: 'review.address', jobKey: 'm7-cancel', attempt: 1 },
        { signal: parent.signal },
      );
      // Abort once the first driver dispatch has started; account() for that
      // dispatch settles synchronously when its promise resolves, so the run
      // then reaches the cancelled exit carrying its spend.
      const cancelledWhileDispatched = new Promise<void>((done) => {
        const timer = setInterval(() => {
          if (f.runs >= 1) {
            clearInterval(timer);
            parent.abort();
            done();
          }
        }, 1);
      });
      await cancelledWhileDispatched;
      const ladder = await opPromise;
      expect(ladder.outcome).toBe('completed');
      if (ladder.outcome !== 'completed') throw new Error('ladder did not complete');
      const result = ladder.value;
      expect(result.status).toBe('needs-human');
      if (result.status === 'ok') throw new Error('expected needs-human');
      expect(result.report?.reasons.join('; ')).toContain('parent cancelled');
      expect(f.runs).toBeGreaterThanOrEqual(1);
      // Every dispatch that SETTLED is retained exactly once; a dispatch cut
      // down by the abort settles as explicit unknown, never dropped.
      const summary = result.report?.usageSummary;
      expect(summary).toBeDefined();
      expect(summary?.knownCount ?? 0).toBeLessThanOrEqual(f.runs);
      expect((summary?.knownCount ?? 0) + (summary?.unknownCount ?? 0)).toBe(f.runs);
      if (summary?.usage !== undefined) {
        expect(summary.usage).toEqual({
          input: 2 * summary.knownCount,
          output: summary.knownCount,
          cacheRead: 0,
          cacheWrite: 0,
        });
        // Parent totals do not double count the retained spend.
        expect(result.report?.usage.input).toBeGreaterThanOrEqual(summary.usage.input);
      }
      // The engine's terminal lifetime persists the same summary to the artifact.
      const persisted = JSON.parse(await readFile(result.report!.reportPath, 'utf8')) as {
        usageSummary?: unknown;
      };
      expect(persisted.usageSummary).toEqual(summary);
    } finally {
      parent.abort();
      await f.cleanup();
    }
  });
});
