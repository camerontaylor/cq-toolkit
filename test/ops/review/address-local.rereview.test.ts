import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
// Split provenance: test/ops/review/address-local.test.ts was split into
// subject files sharing ./address-local.helpers.ts. This file holds the
// re-review cases: an adopted no-ignore repository and the #509 blocked
// re-review recovery.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { makeAddressWorker } from '../../../src/ops/review/addressWorker.js';
import { makeReviewAddress, type ReviewAddressReport } from '../../../src/ops/review/address.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { fixture, useGitleaksPath } from './address-local.helpers.js';

useGitleaksPath();
test('adopted no-ignore repository can re-review ledger revisions and commit a second round', async () => {
  const f = await fixture();
  try {
    await f.repo.write('.gitignore', '');
    f.repo.commitAll('adopted repository');
    const record = { ...f.record, head: f.repo.git('rev-parse', 'HEAD').trim() };
    let reviews = 0;
    const reviewedHeads = new Set<string>();
    const drivers: DriverFactory = {
      resolve(request) {
        const resolved = f.drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            ...resolved.driver,
            run: async (input) => {
              if (input.outputSchema?.name === 'review.agent/v3') {
                const serialized = JSON.stringify({
                  prompt: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
                });
                await request.beforeRequest?.(serialized, [{ text: input.prompt }], {
                  kind: 'model-request',
                });
                const reviewHead = /^Head: ([a-f0-9]{40,64})$/m.exec(input.prompt)?.[1];
                expect(reviewHead).toBeDefined();
                if (!reviewedHeads.has(reviewHead!)) {
                  reviewedHeads.add(reviewHead!);
                  reviews++;
                }
                return {
                  stopReason: 'complete',
                  usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
                  denials: [],
                  structuredOutput: {
                    findings:
                      reviews === 1
                        ? [
                            {
                              file: 'src/a.ts',
                              line: 1,
                              severity: 'high',
                              text: 'Replace GOOD with FINAL',
                            },
                          ]
                        : [],
                  },
                };
              }
              if (
                reviews === 1 &&
                input.outputSchema?.name === 'review.address.outcome/v1' &&
                !input.prompt.startsWith('related-check feedback')
              ) {
                const path = join(input.workspace!.path, 'src/a.ts');
                await writeFile(path, (await readFile(path, 'utf8')).replace('GOOD', 'FINAL'));
              }
              const result = await resolved.driver.run(input);
              if (reviews === 1 && input.outputSchema?.name === 'review.address.closure/v1')
                return {
                  ...result,
                  structuredOutput: { closed: true, reason: 'FINAL candidate checked' },
                };
              return result;
            },
          },
        };
      },
    };
    const result = await makeReviewAddress({ drivers, initialRecord: record })({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir: f.journalDir,
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const report = result.status === 'ok' ? result.value : result.report!;
    expect(report.fixesPerRun).toBe(2);
    expect(reviews).toBe(2);
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('FINAL');
    expect(f.repo.git('status', '--porcelain')).toContain('.cq/');
  } finally {
    await f.cleanup();
  }
});

describe('review.address blocked re-review (#509)', () => {
  test('a re-review blocked on the transient class is retried once and the run completes', async () => {
    // The session retries a transient driver failure once itself, so two
    // failures block one review.run; the address retry then succeeds.
    const f = await fixture('fix', 10000, { count: 2, errorClass: 'transient' });
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.fixesPerRun).toBe(1);
      expect(result.value.reasons).toContain(
        're-review blocked on a network/transient class; retrying once',
      );
      expect(f.reviewRequests.count).toBe(3);
    } finally {
      await f.cleanup();
    }
  });

  test('still blocked after the retry with a verified fix: stop marks rereview-blocked', async () => {
    const f = await fixture('fix', 10000, { count: 4, errorClass: 'transient' });
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status).toBe('needs-human');
      const report = (result as { report?: { stop?: string; fixesPerRun: number } }).report;
      expect(report?.fixesPerRun).toBe(1);
      expect(report?.stop).toBe('rereview-blocked');
      expect(f.reviewRequests.count).toBe(4);
    } finally {
      await f.cleanup();
    }
  });

  test('still blocked after the retry with NO verified fix: no publication marker', async () => {
    const f = await fixture('defer', 10000, { count: 4, errorClass: 'transient' });
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status).toBe('needs-human');
      const report = (result as { report?: { stop?: string; fixesPerRun: number } }).report;
      expect(report?.fixesPerRun).toBe(0);
      expect(report?.stop).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  test('a re-review blocked on a non-transient class is neither retried nor marked', async () => {
    const f = await fixture('fix', 10000, { count: 4, errorClass: 'auth' });
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status).toBe('needs-human');
      const report = (result as { report?: { stop?: string; reasons: string[] } }).report;
      expect(report?.stop).toBeUndefined();
      expect(report?.reasons.join(' ')).not.toContain('retrying once');
      expect(f.reviewRequests.count).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
});

describe('final re-review wall guard (#533)', () => {
  test.each([0, 16_000, 60_000])(
    'attributes final review after fixing uses %i ms',
    async (elapsed) => {
      const realNow = Date.now.bind(Date);
      let offset = 0;
      const f = await fixture('fix');
      if (elapsed === 16_000)
        f.record.findings.push({ ...f.record.findings[0]!, id: 'reserved-batch' });
      let fixes = 0;
      const started = realNow();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => started + offset);
      try {
        const op = makeReviewAddress({
          drivers: f.drivers,
          initialRecord: f.record,
          workerFactory: (deps) => {
            const worker = makeAddressWorker(deps);
            return {
              ...worker,
              fix: async (finding, round) => {
                fixes += 1;
                const result = await worker.fix(finding, round);
                offset = elapsed;
                return result;
              },
            };
          },
        });
        const result = await op({
          repoRoot: f.repo.root,
          source: 'local',
          journalDir: f.journalDir,
        });
        await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
        expect(fixes).toBe(1);
        expect(f.reviewRequests.count).toBe(elapsed >= 20_000 ? 0 : 1);
        if (elapsed >= 20_000)
          expect((result as { report?: ReviewAddressReport }).report?.stop).toBe('budget');
      } finally {
        clock.mockRestore();
        await f.cleanup();
      }
    },
  );
});
