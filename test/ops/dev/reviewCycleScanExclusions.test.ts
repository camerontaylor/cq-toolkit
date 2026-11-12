import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Op } from '../../../src/kernel/types.js';
import {
  SCAN_COMPONENT_CAP_BYTES,
  makeDevReview,
  type DevCycleInput,
  type DevReviewReport,
} from '../../../src/ops/dev/review.js';
import { stubScanner } from './fakes.js';
import { capturingScanner, cycleReview, managedTerminal, reviewerCalls } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

describe('dev.review cycle', () => {
  test('refuses agent cycles when a changed policy file is excluded from the upload scan', async () => {
    await repo.write('policy/denylist/patterns.yml', 'rules: []\n');
    repo.commitAll('change scanner policy');
    const effects = repoEffects(repo);
    const runAgentReviewer = vi.fn(async () => ({
      status: 'needs-human' as const,
      reason: 'fixture runner must not be called',
    }));
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer,
      patternsFile: 'policy/denylist/patterns.yml',
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('excluded from the pre-upload scan');
    expect(runAgentReviewer).not.toHaveBeenCalled();
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });

  test('refuses agent uploads when the configured corpus is a new untracked file', async () => {
    await repo.write('policy/denylist/patterns.yml', 'rules: []\n');
    const effects = repoEffects(repo);
    const runAgentReviewer = vi.fn(async () => ({
      status: 'needs-human' as const,
      reason: 'fixture runner must not be called',
    }));
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer,
      patternsFile: 'policy/denylist/patterns.yml',
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('excluded from the pre-upload scan');
    expect(runAgentReviewer).not.toHaveBeenCalled();
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });

  test('refuses managed queue submits when the configured corpus itself changed', async () => {
    await repo.write('custom/rules.yml', 'rules:\n');
    repo.commitAll('change configured scanner corpus');
    const effects = repoEffects(repo);
    const result = await cycleReview(
      effects,
      stubScanner(),
      'custom/rules.yml',
      managedTerminal(),
    )({
      repoRoot: repo.root,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('custom/rules.yml');
    expect(reviewerCalls(effects)).toEqual([]);
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });

  test('scan components: one per (leg, path) with its path; binary bytes visible; untracked read', async () => {
    await repo.write('bin/blob.dat', Buffer.from([0, 1, 2, ...Buffer.from('TOKEN-in-binary'), 0]));
    repo.commitAll('binary');
    await repo.write('src/staged.ts', 'export const s = 1;\n');
    repo.git('add', 'src/staged.ts');
    await repo.write('README.md', '# edited\n');
    await repo.write('notes/new.env', 'KEY=1\n');
    const scanner = capturingScanner();
    // S2b-i: the scan gates the managed queue submit — the scripted leg
    // never runs for this dirty tree, so the components are asserted alone.
    const submit = (() => {
      throw new Error('fixture: the managed leg must not run for a dirty tree');
    }) as unknown as ReturnType<typeof managedTerminal>;
    const result = await cycleReview(
      repoEffects(repo),
      scanner,
      undefined,
      submit,
    )({
      repoRoot: repo.root,
    });
    expect(result.status).toBe('needs-human');
    expect(scanner.seen.map((c) => [c.component, c.path])).toEqual([
      ['committed:bin/blob.dat', 'bin/blob.dat'],
      ['committed:src/a.ts', 'src/a.ts'],
      ['staged:src/staged.ts', 'src/staged.ts'],
      ['unstaged:README.md', 'README.md'],
      ['untracked:notes/new.env', 'notes/new.env'],
    ]);
    expect(scanner.seen[0]?.text).toContain('TOKEN-in-binary');
    expect(scanner.seen[3]?.text).toContain('-# fixture');
    expect(scanner.seen[4]?.text).toBe('KEY=1\n');
  });

  test('a legacy-named file without configured corpus remains in the scanner input', async () => {
    repo.git('reset', '-q', '--hard', 'origin/main');
    await repo.write('policy/denylist/patterns.yml', 'LEGACY_SECRET_PROBE\n');
    repo.commitAll('legacy-named secret');
    const scanner = capturingScanner();
    const result = await cycleReview(repoEffects(repo), (components) => {
      scanner.seen.push(...components);
      const hit = components.some((component) => component.text.includes('LEGACY_SECRET_PROBE'));
      return components.map((component) => ({
        component: component.component,
        hits:
          hit && component.path === 'policy/denylist/patterns.yml'
            ? [{ ruleId: 'fixture:legacy-secret', lines: [1] }]
            : [],
      }));
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(scanner.seen.map((component) => component.path)).toContain(
      'policy/denylist/patterns.yml',
    );
  });

  test('THE SCAN GATES THE SUBMIT: a hit or a scanner fault refuses before the managed leg runs', async () => {
    const hit = repoEffects(repo);
    const refused = await cycleReview(
      hit,
      stubScanner([{ component: 'committed:src/a.ts', ruleId: 'class:secret' }]),
      undefined,
      managedTerminal(),
    )({ repoRoot: repo.root });
    expect(refused.status).toBe('needs-human');
    if (refused.status === 'needs-human')
      expect(refused.reason).toContain('class:secret in committed:src/a.ts');
    expect(reviewerCalls(hit)).toEqual([]);

    const fault = repoEffects(repo);
    const faulted = await cycleReview(
      fault,
      () => {
        throw new Error('gitleaks missing');
      },
      undefined,
      managedTerminal(),
    )({ repoRoot: repo.root });
    expect(faulted.status).toBe('needs-human');
    if (faulted.status === 'needs-human') expect(faulted.reason).toContain('gitleaks missing');
    expect(reviewerCalls(fault)).toEqual([]);
    expect(fault.openLedger('feature/x').load().records).toEqual([]);
  });

  test('an unscannable untracked file (symlink, oversized) refuses — never silently skipped', async () => {
    await symlink('/etc/hostname', join(repo.root, 'link'));
    const linked = repoEffects(repo);
    const result = await cycleReview(
      linked,
      stubScanner(),
      undefined,
      managedTerminal(),
    )({
      repoRoot: repo.root,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain("untracked file 'link'");
    expect(reviewerCalls(linked)).toEqual([]);

    await rm(join(repo.root, 'link'));
    await repo.write('big.txt', 'x'.repeat(SCAN_COMPONENT_CAP_BYTES + 1));
    const big = await cycleReview(
      repoEffects(repo),
      stubScanner(),
      undefined,
      managedTerminal(),
    )({
      repoRoot: repo.root,
    });
    expect(big.status).toBe('needs-human');
    if (big.status === 'needs-human') expect(big.reason).toContain('per-file scan cap');
  });
});
