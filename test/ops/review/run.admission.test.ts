import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

describe('review.run', () => {
  it('requires a readable cq.json before starting a review', async () => {
    const repo = await makeTestRepo();
    try {
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
      })({ repoRoot: repo.root });
      expect(result).toEqual({
        status: 'needs-human',
        reason: 'review.run: cq.json is required',
        usageSummary: { knownCount: 0, unknownCount: 0, unpricedCount: 0 },
      });
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('maps an unreadable cq.json (EISDIR) to needs-human naming the errno', async () => {
    const repo = await makeTestRepo();
    try {
      await mkdir(join(repo.root, 'cq.json')); // present-but-unreadable; only ENOENT means "no config"
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('review.run: cq.json could not be read (EISDIR)');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('maps an unresolvable target to needs-human before starting a reviewer', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
      })({ repoRoot: repo.root, target: 'missing-target' });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain('origin/missing-target');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('accepts an adopter target and immutable base pin consistently', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      repo.git('push', '-q', 'origin', 'origin/main:refs/heads/release');
      repo.git('fetch', '-q', 'origin');
      const base = repo.git('rev-parse', 'HEAD~1').trim();
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, target: 'release', base });
      expect(result.status).toBe('ok');
      const ledger = effects.openLedger('feature/x').load();
      const cycle = ledger.records.find((entry) => entry.kind === 'cycle');
      expect(cycle).toMatchObject({ target: 'release', base, reviewer: 'agent:reviewer' });
    } finally {
      await repo.cleanup();
    }
  });

  it('maps an invalid cq.json to needs-human before invoking a reviewer', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write('cq.json', '{ invalid');
      repo.commitAll('add malformed review config');
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain('not valid JSON');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });
});
