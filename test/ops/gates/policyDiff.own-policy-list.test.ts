import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POLICY_LIST_PATH, createPolicyDiff } from '../../../src/ops/gates/policyDiff.js';
import {
  hasUnresolvableCheckName,
  producersOf,
  scanWorkflow,
} from '../../../src/ops/gates/workflowScan.js';
import {
  HOOK_MS,
  SLOW,
  importCommits,
  repo,
  setupFixtures,
  teardownFixtures,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe("the toolkit's own policy list", () => {
  const REPO_ROOT = join(__dirname, '..', '..', '..');
  const list = JSON.parse(readFileSync(join(REPO_ROOT, POLICY_LIST_PATH), 'utf8')) as {
    schemaVersion: number;
    protectedPaths: string[];
    requiredChecks: string[];
    requiredJobs?: Record<string, string[]>;
  };

  /**
   * Entries protecting a tree that has not landed yet, each with the PR that
   * lands it. A pending entry must match NOTHING: once its tree lands the
   * test fails until the entry leaves this list, so it cannot go stale.
   */
  const PENDING: Readonly<Record<string, string>> = {};

  // Retired at C2: the old gate's wait-list file is gone. requiredChecks keeps
  // its teeth by naming checks the retained CI workflows actually produce.
  test('requiredChecks are produced by the retained CI workflows', () => {
    const producers: Record<string, string> = {
      static: 'ci.yml',
      denylist: 'denylist.yml',
    };
    expect([...list.requiredChecks].sort()).toEqual(['denylist', 'static']);
    for (const check of list.requiredChecks) {
      const file = producers[check];
      expect(file, `${check}: has a retained producer`).toBeDefined();
      const scan = scanWorkflow(readFileSync(join(REPO_ROOT, '.github/workflows', file!), 'utf8'));
      expect(scan.ok, `${file}: scans ok`).toBe(true);
      if (!scan.ok) continue;
      expect(producersOf(scan, check), `${check}: produced by retained ${file}`).toContain(check);
    }
  });

  test('every protectedPaths source compiles and matches a tracked file', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(list.schemaVersion).toBe(1);
    for (const source of list.protectedPaths) {
      const pattern = new RegExp(source);
      expect(
        tracked.some((path) => pattern.test(path)),
        Object.hasOwn(PENDING, source) ? `${source} (pending: ${PENDING[source]!})` : source,
      ).toBe(!Object.hasOwn(PENDING, source));
    }
    for (const source of Object.keys(PENDING)) expect(list.protectedPaths).toContain(source);
  });

  test(
    'the real list parses at a trust ref (window bounded, requiredJobs well-formed)',
    async () => {
      const at = importCommits(repo, {
        'toolkit-list': {
          files: { [POLICY_LIST_PATH]: readFileSync(join(REPO_ROOT, POLICY_LIST_PATH), 'utf8') },
        },
      })['toolkit-list']!;
      const result = await createPolicyDiff({ posture: 'human', layer: 'default' })({
        repo,
        trustRef: at,
        subject: at,
        subjectKind: 'pr',
        base: 'merge-queue',
      });
      expect(result.status).toBe('ok');
    },
    SLOW.timeout,
  );

  test('requiredJobs name jobs the verified workflows define, by display name', () => {
    expect(list.requiredJobs).toEqual({
      'ci.yml': ['static', 'crq-python', 'from-source'],
      'denylist.yml': ['denylist'],
    });
    for (const [file, jobs] of Object.entries(list.requiredJobs ?? {})) {
      const scan = scanWorkflow(readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8'));
      expect(scan.ok, `${file}: scans ok`).toBe(true);
      if (!scan.ok) continue;
      for (const job of jobs) {
        // The jobs API reports the display name (`name:`, else the id): no matrix, no dynamic name.
        const named = [...scan.jobs.values()].filter(
          (j) => !hasUnresolvableCheckName(j) && (j.name ?? j.id) === job,
        );
        expect(named, `${file}: a job displayed as ${job}`).toHaveLength(1);
      }
    }
  });
});
