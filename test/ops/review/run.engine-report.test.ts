import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assembleReadiness, DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { dispositionRecord } from '../dev/fakes.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

it('keeps blocked evidence when an engine report carries malformed coverage', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    const effects = repoEffects(repo);
    const malformed = { version: 999, nonsense: true };
    const result = await makeReviewRun({
      drivers: scriptedDrivers(),
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
      runAgentReviewer: async () => ({
        status: 'needs-human',
        reason: 'fixture engine blocked',
        report: {
          findings: [],
          usage: 1,
          usageSummary: { knownCount: 0, unknownCount: 1, unpricedCount: 1 },
          coverage: malformed as never,
          advisories: ['fixture advisory'],
          limitations: ['fixture limitation'],
        },
      }),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(result.report?.sources[0]).toMatchObject({
      kind: 'agent',
      status: 'blocked',
      reason: 'fixture engine blocked',
    });
    expect(result.report?.sources[0]).not.toHaveProperty('coverage');
    expect(result.report?.advisories).toEqual(['fixture advisory']);
    expect(effects.logs[0]).toContain('"version":999');
    const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
    const [recordFile] = await readdir(folder);
    const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
      sources: { kind: string; status: string; coverage?: unknown }[];
    };
    expect(persisted.sources[0]).toMatchObject({ kind: 'agent', status: 'blocked' });
    expect(persisted.sources[0]).not.toHaveProperty('coverage');
  } finally {
    await repo.cleanup();
  }
});

it('maps blocked partial findings to the ledger cycle so a disposition closes them', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    const effects = repoEffects(repo);
    const result = await makeReviewRun({
      drivers: scriptedDrivers(),
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
      runAgentReviewer: async () => ({
        status: 'needs-human',
        reason: 'fixture engine blocked',
        report: {
          findings: [
            {
              id: 'session-1-1',
              source: 'agent',
              severity: 'major',
              text: 'blocked partial finding',
              status: 'open',
            },
          ],
          usage: 1,
          usageSummary: { knownCount: 0, unknownCount: 1, unpricedCount: 1 },
          coverage: undefined as never,
          advisories: ['blocked advisory'],
          limitations: [],
        },
      }),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    const ledger = effects.openLedger('feature/x').load();
    const cycle = ledger.records.find(
      (entry) => entry.kind === 'cycle' && entry.reviewer === 'agent:reviewer',
    );
    if (cycle?.kind !== 'cycle') throw new Error('missing agent cycle');
    const findingId = cycle.findings[0]?.id;
    expect(findingId).toBe(`c001-${cycle.head.slice(0, 8)}#f1`);
    expect(result.report?.findings).toEqual([
      expect.objectContaining({ id: findingId, text: 'blocked partial finding' }),
    ]);
    expect(result.report?.advisories).toEqual(['blocked advisory']);

    const readiness = assembleReadiness({
      branch: ledger.branch,
      target: 'main',
      identity: {
        base: cycle.base,
        head: cycle.head,
        dirtySha256: cycle.dirtySha256,
      },
      ledger: {
        version: DEV_LEDGER_VERSION,
        branch: ledger.branch,
        records: [
          ...ledger.records,
          dispositionRecord({
            findingId: findingId!,
            action: 'fixed',
            why: 'fixture disposition closes the blocked partial finding',
            head: cycle.head,
          }),
        ],
      },
      untracked: [],
      configuredReviewers: ['agent'],
      nowIso: '2026-10-26T00:00:00.000Z',
    });
    expect(readiness.ready).toBe(false);
    if (!readiness.ready)
      expect(readiness.gaps.some((gap) => gap.field === 'open-blocking-findings')).toBe(false);
  } finally {
    await repo.cleanup();
  }
});

it.each(['', undefined])(
  'agent blocked partial findings persist file identity: %j',
  async (file) => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
        runAgentReviewer: async () => ({
          status: 'needs-human',
          reason: 'fixture partial evidence',
          report: {
            findings: [
              {
                id: 'partial',
                source: 'agent',
                severity: 'major',
                text: 'identity',
                status: 'open',
                ...(file === undefined ? {} : { file }),
              },
            ],
            usage: 1,
            coverage: undefined as never,
            advisories: [],
            limitations: [],
          },
        }),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      const cycle = effects
        .openLedger('feature/x')
        .load()
        .records.find((entry) => entry.kind === 'cycle' && entry.reviewer === 'agent:reviewer');
      if (cycle?.kind !== 'cycle') throw new Error('missing agent cycle');
      const persisted = JSON.parse(
        await readFile(join(repo.root, '.cq/review/feature%2Fx/1.json'), 'utf8'),
      ) as { findings: Array<{ file?: string }> };
      if (file === undefined) {
        expect(cycle.findings[0]).not.toHaveProperty('fileName');
        expect(persisted.findings[0]).not.toHaveProperty('file');
      } else {
        expect(cycle.findings[0]).toHaveProperty('fileName', '');
        expect(persisted.findings[0]).toHaveProperty('file', '');
      }
    } finally {
      await repo.cleanup();
    }
  },
);
