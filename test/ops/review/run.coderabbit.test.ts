import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ManagedReviewSubmit } from '../../../src/ops/dev/managedReview.js';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

/**
 * S2b-i: the CodeRabbit leg rides the managed queue route — the tests script
 * the submit outcome (submit-wait-fetch is covered in managedReview.test.ts).
 * The CLI fixtures below are inert (no CLI is spawned); the scripted leg
 * carries the same finding shapes the CLI stream used to emit.
 */
const managedTerminal = (
  findings: { severity: string; fileName?: string; comment?: string }[] = [
    { severity: 'major', fileName: 'src/a.ts', comment: 'seeded CodeRabbit finding' },
  ],
): ManagedReviewSubmit =>
  (async () => ({
    status: 'completed',
    value: {
      receiptId: 'r'.repeat(64),
      completion: { kind: 'terminal' },
      findings: findings.map((finding) => ({
        severity: finding.severity,
        ...(finding.fileName === undefined ? {} : { fileName: finding.fileName }),
        ...(finding.comment === undefined ? {} : { excerpt: finding.comment }),
      })),
      advisories: [],
    },
  })) as ManagedReviewSubmit;

const managedBlocked = (reason: string): ManagedReviewSubmit =>
  (async () => ({
    status: 'completed',
    value: {
      receiptId: 'b'.repeat(64),
      completion: { kind: 'blocked', reason },
      findings: [
        { severity: 'critical', fileName: 'src/a.ts', excerpt: 'partial critical evidence' },
      ],
      advisories: [],
    },
  })) as ManagedReviewSubmit;

const runWithManaged = (managedSubmit: ManagedReviewSubmit) => ({
  drivers: scriptedDrivers(),
  scannerFactory: () => async (components: readonly ScanComponentInput[]) =>
    components.map((component) => ({ component: component.component, hits: [] })),
  managedSubmit,
});

describe('review.run', () => {
  it.each([
    [
      'a delivery-unknown queue refusal is marked blockedTransient',
      { status: 'refused', reason: 'status — queue delivery unknown', transient: true },
      true,
    ],
    ['any other managed refusal is not', { status: 'refused', reason: 'submit — refused' }, false],
    [
      'a refused queue submit without the network class is not',
      { status: 'refused', reason: 'the queue saw no committed changes to review' },
      false,
    ],
  ] as const)('#509 (managed route): %s', async (_label, outcome, transient) => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          review: { reviewers: ['coderabbit'] },
        }),
      );
      repo.commitAll('configure CodeRabbit-only review');
      const submit = (async () => outcome) as ManagedReviewSubmit;
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        ...runWithManaged(submit),
        effectsFactory: () => effects,
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      expect(result.report?.blockedTransient).toBe(transient ? true : undefined);
    } finally {
      await repo.cleanup();
    }
  });

  it('normalizes a successful CodeRabbit-only cycle and persists its finding', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          review: { reviewers: ['coderabbit'] },
        }),
      );
      repo.commitAll('configure CodeRabbit-only review');
      const effects = repoEffects(repo);
      const runDeps = runWithManaged(managedTerminal());
      const result = await makeReviewRun({
        ...runDeps,
        effectsFactory: () => effects,
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.sources).toEqual([
        expect.objectContaining({ kind: 'coderabbit', status: 'terminal' }),
      ]);
      expect(result.value.findings).toEqual([
        expect.objectContaining({
          source: 'coderabbit',
          severity: 'major',
          file: 'src/a.ts',
          text: 'seeded CodeRabbit finding',
          status: 'open',
        }),
      ]);
      expect(runDeps.drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps findings from a blocked CodeRabbit cycle in the portable record', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['coderabbit', 'agent'] },
        }),
      );
      repo.commitAll('fixture blocked CodeRabbit review');
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        ...runWithManaged(managedBlocked('the queue returned no countable verdict')),
        effectsFactory: () => effects,
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') return;
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; cycleId?: string }[];
        findings: { id: string; source: string; severity: string; file?: string; text: string }[];
      };
      const source = persisted.sources.find((item) => item.kind === 'coderabbit');
      expect(source).toMatchObject({ kind: 'coderabbit', status: 'blocked' });
      expect(source?.cycleId).toMatch(/^c001-/);
      expect(persisted.findings).toContainEqual(
        expect.objectContaining({
          id: `${source?.cycleId}#f1`,
          source: 'coderabbit',
          severity: 'critical',
          file: 'src/a.ts',
          text: 'partial critical evidence',
          status: 'open',
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('reports uncertainty when a blocked cycle ledger cannot be read back', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['coderabbit', 'agent'] },
        }),
      );
      repo.commitAll('fixture blocked CodeRabbit review');
      const effects = repoEffects(repo);
      const openLedger = effects.openLedger.bind(effects);
      effects.openLedger = (branch) => {
        const ledger = openLedger(branch);
        return {
          ...ledger,
          load: () => {
            throw new Error('ledger read fault');
          },
        };
      };
      const result = await makeReviewRun({
        ...runWithManaged(managedBlocked('the queue returned no countable verdict')),
        effectsFactory: () => effects,
      })({ repoRoot: repo.root });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.detail).toContain('ledger read fault');
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a diff command rejection to failed', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo);
      const run = effects.runCommand;
      effects.runCommand = async (command, args, options) => {
        if (
          command === 'git' &&
          args[0] === 'diff' &&
          args.includes('--no-textconv') &&
          args.includes('--name-only')
        )
          throw new Error('spawn failed');
        return run(command, args, options);
      };
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components: readonly ScanComponentInput[]) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toContain('spawn failed');
    } finally {
      await repo.cleanup();
    }
  });
});
