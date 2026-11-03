// Split provenance: test/ops/review/address-local.test.ts was split into
// subject files sharing ./address-local.helpers.ts. This file holds the
// review.run record gating cases for local clean acceptance.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { FindingsRecordSchema } from '../../../src/ops/review/findings.js';
import { fixture, useGitleaksPath } from './address-local.helpers.js';

useGitleaksPath();
test.each([
  'full',
  'uncommitted',
  'narrow-base',
  'matching-narrow-base',
  'dirty-restored',
  'staged-restored',
  'untracked-restored',
  'mutated-during-review',
] as const)('actual review.run record gates local clean acceptance: %s', async (mode) => {
  const f = await fixture();
  let calls = 0;
  const drivers: DriverFactory = {
    resolve: (request) => ({
      lane: 'ai-sdk',
      modelSpec: request.modelSpec,
      driver: {
        run: async (input) => {
          calls++;
          if (mode === 'dirty-restored' || mode === 'staged-restored')
            expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('GOOD');
          if (mode === 'mutated-during-review')
            await f.repo.write('src/a.ts', 'export const a = "GOOD";\n');
          const serialized = JSON.stringify({
            prompt: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
          });
          await request.beforeRequest?.(serialized, [{ text: input.prompt }], {
            kind: 'model-request',
          });
          return {
            stopReason: 'complete',
            structuredOutput: { findings: [] },
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          };
        },
      },
    }),
  };
  try {
    const narrow = mode === 'narrow-base' || mode === 'matching-narrow-base';
    const head = f.repo.git('rev-parse', 'HEAD').trim();
    const dirty = mode === 'dirty-restored' || mode === 'staged-restored';
    if (dirty) {
      await f.repo.write('src/a.ts', 'export const a = "GOOD";\n');
      if (mode === 'staged-restored') f.repo.git('add', '--', 'src/a.ts');
    }
    if (mode === 'untracked-restored')
      await f.repo.write('src/new.ts', 'export const newFile = 1;\n');
    const produced = await makeReviewRun({ drivers })({
      repoRoot: f.repo.root,
      ...(narrow ? { base: head } : {}),
      ...(mode === 'uncommitted' ? { uncommitted: true } : {}),
    });
    expect(produced.status).toBe(mode === 'mutated-during-review' ? 'needs-human' : 'ok');
    const record = FindingsRecordSchema.parse(
      JSON.parse(
        await readFile(
          join(f.repo.root, '.cq/review', encodeURIComponent(f.record.branch), '1.json'),
          'utf8',
        ),
      ),
    );
    if (mode === 'mutated-during-review')
      expect(record.sources).toContainEqual(
        expect.objectContaining({
          kind: 'agent',
          status: 'blocked',
          reason: 'repository state changed during agent review',
        }),
      );
    expect(record.findings).toEqual([]);
    const reviewerCalls = calls;
    expect(reviewerCalls).toBeGreaterThan(0);
    if (dirty || mode === 'mutated-during-review' || mode === 'untracked-restored') {
      expect(record.reviewed).toBeUndefined();
      f.repo.git('restore', '--source=HEAD', '--staged', '--worktree', '--', 'src/a.ts');
      if (mode === 'untracked-restored') await rm(join(f.repo.root, 'src/new.ts'));
      expect(f.repo.git('status', '--porcelain')).toBe('');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('BAD');
    }
    const result = await makeReviewAddress({ drivers, initialRecord: record })({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir: f.journalDir,
      ...(mode === 'matching-narrow-base' ? { base: head } : {}),
    });
    expect(result.status).toBe(
      mode === 'full' || mode === 'matching-narrow-base' ? 'ok' : 'needs-human',
    );
    expect(calls).toBe(reviewerCalls);
    if (result.status !== 'ok')
      expect(result.report!.reasons.join(' ')).toContain(
        mode === 'mutated-during-review' ? 'review source incomplete' : 'reviewed base/scope',
      );
  } finally {
    await f.cleanup();
  }
});
