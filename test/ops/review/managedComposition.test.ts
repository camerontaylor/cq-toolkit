import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeDevCycle } from '../../../src/ops/dev/cycle.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { repoEffects } from '../dev/repo.js';
import { bindCycleRepo, greenCheck } from '../dev/cycle.helpers.js';
import { fixture, useGitleaksPath } from './address-local.helpers.js';

useGitleaksPath();

test('cycle default review reaches managed submit with a nonempty real diff', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(join(f.repo.root, 'cq.json'), 'utf8')) as CqConfig;
    config.review = { ...config.review, reviewers: ['coderabbit'] };
    await f.repo.write('cq.json', JSON.stringify(config));
    f.repo.commitAll('managed cycle config');
    bindCycleRepo(f.repo);
    const managedSubmit = vi.fn(async () => ({
      status: 'refused' as const,
      reason: 'offline queue sentinel',
    }));
    const result = await makeDevCycle({
      effects: repoEffects(f.repo),
      check: greenCheck(),
      managedSubmit,
    })({ repoRoot: f.repo.root });
    expect(managedSubmit).toHaveBeenCalledTimes(1);
    expect(managedSubmit.mock.calls[0]).toBeDefined();
    expect(result.status).toBe('needs-human');
    expect(managedSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: f.repo.root, head: f.repo.git('rev-parse', 'HEAD').trim() }),
    );
    expect(JSON.stringify(result)).not.toContain('no managed submit leg');
  } finally {
    await f.cleanup();
  }
});

test('address default refreshed review uses managed submit after the real worker fixes a finding', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(join(f.repo.root, 'cq.json'), 'utf8')) as CqConfig;
    // The address policy stays agent-only, like addressMany; refreshed review
    // resolves cq.json independently and must retain the queue dependency.
    await f.repo.write(
      'cq.json',
      JSON.stringify({ ...config, review: { reviewers: ['coderabbit'] } }),
    );
    f.repo.commitAll('managed refresh config');
    const managedSubmit = vi.fn(async () => ({
      status: 'refused' as const,
      reason: 'offline refresh sentinel',
    }));
    const result = await makeReviewAddress({
      config,
      drivers: f.drivers,
      managedSubmit,
      initialRecord: { ...f.record, head: f.repo.git('rev-parse', 'HEAD').trim() },
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('GOOD');
    expect(managedSubmit).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('needs-human');
    expect(managedSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: f.repo.root, head: f.repo.git('rev-parse', 'HEAD').trim() }),
    );
    expect(JSON.stringify(result)).not.toContain('no managed submit leg');
  } finally {
    await f.cleanup();
  }
});
