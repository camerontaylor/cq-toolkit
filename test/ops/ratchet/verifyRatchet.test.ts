// W1.7 — the trusted ratchet verifier (src/ops/ratchet/verifyRatchet.ts),
// over real tmp git repos (no network).
//
// Pinned:
//   1. Definitions and baselines come from the TRUST ref: a head that renames
//      a target and commits a looser baseline (A5) changes nothing the
//      verifier enumerates, and is needs-human (it edits ratchets.json).
//   2. Definition check: any definition-set path (workflows, .gitattributes,
//      test configs, the trust tsconfig graph) changed in
//      merge-base(subject, base)..subject → needs-human; an already-queued
//      sibling change on the base is NOT charged to a PR that doesn't touch it.
//   3. The guard runs over the same range: an unreplaced baseline delete and
//      an in-place loosening both fail.
//   4. Evidence is untrusted: the artifact is lstat-checked, size-capped and
//      strict-schema validated; a failed measure run, an absent recompute
//      count, and every malformed artifact fail — never pass (I5).
//   5. Coverage compares at one decimal place on both sides.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import {
  MEASUREMENT_MAX_BYTES,
  verifyRatchet,
  type VerifyRatchetInput,
  type VerifyRatchetOutcome,
} from '../../../src/ops/ratchet/verifyRatchet.js';

// Every case spawns several real git processes; on a loaded host one spawn
// can take a second, so the budgets are generous (slice 3's git tests too).
const SLOW = { timeout: 120_000 };

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

const MANIFEST = {
  schemaVersion: 1,
  ratchets: [
    {
      target: 'typecheck',
      metric: 'typecheck-count',
      direction: 'lower-is-better',
      unit: 'errors',
      evidence: 'recompute',
    },
    {
      target: 'coverage',
      metric: 'coverage',
      direction: 'higher-is-better',
      unit: 'pct',
      evidence: 'measurement',
    },
  ],
  definitionSet: [
    '^\\.github/workflows/',
    '(?:^|/)vitest\\.config\\.[^/]+$',
    '(?:^|/)tsconfig[^/]*\\.json$',
    '(?:^|/)\\.gitattributes$',
    '^baselines/ratchets\\.json$',
  ],
};

let root: string;
let repo: string;
let trust: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim();
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function baseline(target: string, metric: string, direction: string, value: number, unit: string) {
  write(
    baselineRelPath(target, metric),
    renderBaseline({
      schemaVersion: 1,
      target,
      metric,
      direction: direction as 'lower-is-better' | 'higher-is-better',
      value,
      unit,
      capturedAt: '2026-09-20T00:00:00.000Z',
    }),
  );
}

function commit(message: string): string {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

/** A PR branch off `from` with `edit` applied; returns its head SHA. */
function prBranch(name: string, from: string, edit: () => void): string {
  git(['checkout', '-q', '-B', name, from]);
  edit();
  const sha = commit(name);
  git(['checkout', '-q', 'main']);
  return sha;
}

let artifactDir: string;
function artifact(name: string, body: unknown): string {
  const path = join(artifactDir, name);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

const good = (): string =>
  artifact('good.json', { schemaVersion: 1, metrics: { coverage: 90.04 } });

async function verify(
  subject: string,
  over: Partial<VerifyRatchetInput> = {},
): Promise<VerifyRatchetOutcome> {
  const result = await verifyRatchet({
    repo,
    trustRef: trust,
    subject,
    subjectKind: 'pr',
    base: 'merge-queue',
    measureConclusion: 'success',
    measurementPath: good(),
    typecheckCount: 0,
    ...over,
  });
  if (result.status !== 'ok') throw new Error(`verify ${result.status}: ${JSON.stringify(result)}`);
  return result.value;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-verify-ratchet-'));
  repo = join(root, 'repo');
  artifactDir = join(root, 'artifacts');
  mkdirSync(repo);
  mkdirSync(artifactDir);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.test']);
  git(['config', 'user.name', 'test']);
  write('baselines/ratchets.json', `${JSON.stringify(MANIFEST, null, 2)}\n`);
  baseline('typecheck', 'typecheck-count', 'lower-is-better', 0, 'errors');
  baseline('coverage', 'coverage', 'higher-is-better', 90, 'pct');
  write('tsconfig.json', '{ "extends": "./config/base.json", "include": ["src"] }\n');
  write('config/base.json', '{ "compilerOptions": { "strict": true } }\n');
  write('src/a.ts', 'export const a = 1;\n');
  trust = commit('trust');
  git(['branch', 'merge-queue', trust]);
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('verifyRatchet: a clean PR', SLOW, () => {
  test('passes with one-decimal coverage and the recompute count', async () => {
    const head = prBranch('pr-clean', 'merge-queue', () =>
      write('src/b.ts', 'export const b = 2;\n'),
    );
    const v = await verify(head);
    expect(v.verdict).toBe('pass');
    expect(v.trustRef).toBe(trust);
    expect(v.definitionChanges).toEqual([]);
    expect(v.results).toEqual([
      expect.objectContaining({
        metric: 'typecheck-count',
        value: 0,
        baseline: 0,
        verdict: 'pass',
      }),
      expect.objectContaining({ metric: 'coverage', value: 90, baseline: 90, verdict: 'pass' }),
    ]);
  });

  test('coverage is judged at one decimal place (89.96 → 90.0 passes, 89.94 → 89.9 fails)', async () => {
    const head = prBranch('pr-cov', 'merge-queue', () =>
      write('src/c.ts', 'export const c = 3;\n'),
    );
    const up = artifact('up.json', { schemaVersion: 1, metrics: { coverage: 89.96 } });
    expect((await verify(head, { measurementPath: up })).verdict).toBe('pass');
    const down = artifact('down.json', { schemaVersion: 1, metrics: { coverage: 89.94 } });
    const v = await verify(head, { measurementPath: down });
    expect(v.verdict).toBe('fail');
    expect(v.reasons.join('\n')).toMatch(/coverage\/coverage: .*regressed 90 → 89\.9/);
  });

  test('a typecheck regression or an absent recompute count fails (I5)', async () => {
    const head = prBranch('pr-tc', 'merge-queue', () => write('src/d.ts', 'export const d = 4;\n'));
    expect((await verify(head, { typecheckCount: 1 })).verdict).toBe('fail');
    const { typecheckCount: _omit, ...noCount } = {
      repo,
      trustRef: trust,
      subject: head,
      subjectKind: 'pr' as const,
      base: 'merge-queue',
      measureConclusion: 'success',
      measurementPath: good(),
      typecheckCount: 0,
    };
    const result = await verifyRatchet(noCount);
    expect(result).toMatchObject({ status: 'ok', value: { verdict: 'fail' } });
  });
});

describe('verifyRatchet: the measurement artifact is untrusted data', SLOW, () => {
  let head: string;
  beforeAll(() => {
    head = prBranch('pr-art', 'merge-queue', () => write('src/e.ts', 'export const e = 5;\n'));
  }, 120_000);

  test('a failed measure run voids the artifact', async () => {
    expect((await verify(head, { measureConclusion: 'failure' })).verdict).toBe('fail');
  });

  test.each([
    ['extra top-level key', { schemaVersion: 1, metrics: { coverage: 95 }, note: 'x' }],
    ['string value', { schemaVersion: 1, metrics: { coverage: '95' } }],
    ['nested object', { schemaVersion: 1, metrics: { coverage: { pct: 95 } } }],
    ['wrong schema version', { schemaVersion: 2, metrics: { coverage: 95 } }],
    ['coverage above 100', { schemaVersion: 1, metrics: { coverage: 101 } }],
    ['no coverage value', { schemaVersion: 1, metrics: {} }],
    ['not JSON', '{"schemaVersion": 1,'],
  ])('%s fails', async (_label, body) => {
    const v = await verify(head, { measurementPath: artifact('bad.json', body) });
    expect(v.verdict).toBe('fail');
  });

  test('an oversized artifact fails without being parsed', async () => {
    const big = artifact('big.json', `${' '.repeat(MEASUREMENT_MAX_BYTES)}{}`);
    const v = await verify(head, { measurementPath: big });
    expect(v.verdict).toBe('fail');
    expect(v.reasons.join('\n')).toMatch(/exceeds/);
  });

  test('a symlinked artifact is refused, never followed', async () => {
    const link = join(artifactDir, 'link.json');
    symlinkSync(good(), link);
    const v = await verify(head, { measurementPath: link });
    expect(v.verdict).toBe('fail');
    expect(v.reasons.join('\n')).toMatch(/not a regular file/);
  });

  test('a missing artifact fails', async () => {
    const v = await verify(head, { measurementPath: join(artifactDir, 'absent.json') });
    expect(v.verdict).toBe('fail');
  });
});

describe('verifyRatchet: definitions come from the trust ref (A5, D-C)', SLOW, () => {
  test('a head that renames the coverage target and adds a looser baseline changes nothing', async () => {
    const head = prBranch('pr-a5', 'merge-queue', () => {
      const manifest = structuredClone(MANIFEST);
      const cov = manifest.ratchets[1];
      if (cov === undefined) throw new Error('fixture');
      cov.target = 'coverage2';
      write('baselines/ratchets.json', `${JSON.stringify(manifest, null, 2)}\n`);
      git(['rm', '-q', baselineRelPath('coverage', 'coverage')]);
      baseline('coverage2', 'coverage', 'higher-is-better', 50, 'pct');
    });
    const low = artifact('low.json', { schemaVersion: 1, metrics: { coverage: 60 } });
    const v = await verify(head, { measurementPath: low });
    expect(v.verdict).toBe('needs-human');
    expect(v.definitionChanges).toContain('baselines/ratchets.json');
    // The trust ref's target is still the one judged, against its baseline.
    expect(v.results.find((r) => r.metric === 'coverage')).toMatchObject({
      target: 'coverage',
      baseline: 90,
      value: 60,
      verdict: 'fail',
    });
    // And the guard names the unreplaced delete.
    expect(v.guard.ok).toBe(false);
    expect(v.reasons.join('\n')).toMatch(/deleted without a replacement/);
  });

  test.each([
    ['.gitattributes', '.gitattributes', 'src/a.ts export-ignore\n'],
    ['a nested .gitattributes', 'src/.gitattributes', '*.ts -diff\n'],
    ['a workflow', '.github/workflows/cq-measure.yml', 'name: x\n'],
    ['the test config', 'vitest.config.ts', 'export default {};\n'],
    ['a tsconfig extends target (graph, not the static set)', 'config/base.json', '{}\n'],
  ])('editing %s is needs-human (D11 records are dormant)', async (_label, rel, content) => {
    const head = prBranch(`pr-def-${rel.replace(/[^a-z]/g, '')}`, 'merge-queue', () =>
      write(rel, content),
    );
    const v = await verify(head);
    expect(v.verdict).toBe('needs-human');
    expect(v.definitionChanges).toEqual([rel]);
    expect(v.reasons[0]).toMatch(/^needs-human \(D11\)/);
  });

  test('a queued sibling definition change on the base is not charged to an unrelated PR', async () => {
    git(['checkout', '-q', 'merge-queue']);
    write('vitest.config.ts', 'export default { queued: true };\n');
    commit('queued definition change');
    git(['checkout', '-q', 'main']);
    const head = prBranch('pr-sibling', 'merge-queue', () =>
      write('src/f.ts', 'export const f = 6;\n'),
    );
    const v = await verify(head);
    expect(v.definitionChanges).toEqual([]);
    expect(v.verdict).toBe('pass');
    // The merge-queue tip itself, judged as a push subject against main, IS charged.
    const tip = git(['rev-parse', 'merge-queue']);
    const pushV = await verify(tip, { subjectKind: 'push', base: 'main' });
    expect(pushV.verdict).toBe('needs-human');
    expect(pushV.definitionChanges).toContain('vitest.config.ts');
  });
});

describe('verifyRatchet: the guard judges the same range', SLOW, () => {
  test('an in-place baseline loosening fails; the trust baseline still governs', async () => {
    const head = prBranch('pr-loosen', 'merge-queue', () =>
      baseline('coverage', 'coverage', 'higher-is-better', 80, 'pct'),
    );
    const v = await verify(head, {
      measurementPath: artifact('85.json', { schemaVersion: 1, metrics: { coverage: 85 } }),
    });
    expect(v.verdict).toBe('fail');
    expect(v.guard).toMatchObject({ ok: false, violations: [{ why: 'loosened' }] });
    expect(v.results.find((r) => r.metric === 'coverage')).toMatchObject({ baseline: 90 });
  });

  test('a baseline tightening passes the guard', async () => {
    const head = prBranch('pr-tighten', 'merge-queue', () =>
      baseline('coverage', 'coverage', 'higher-is-better', 95, 'pct'),
    );
    expect((await verify(head)).guard.ok).toBe(true);
  });
});

describe('verifyRatchet: faults are failed, never a pass', SLOW, () => {
  const coveragePath = baselineRelPath('coverage', 'coverage');

  test.each([
    [
      'missing',
      () => {
        git(['rm', '-q', coveragePath]);
      },
      /missing at the trust ref/,
    ],
    [
      'misnamed',
      () => {
        write(
          coveragePath,
          renderBaseline({
            schemaVersion: 1,
            target: 'another-target',
            metric: 'coverage',
            direction: 'higher-is-better',
            value: 90,
            unit: 'pct',
            capturedAt: '2026-09-20T00:00:00.000Z',
          }),
        );
      },
      /names another ratchet/,
    ],
    [
      'wrong-direction',
      () => baseline('coverage', 'coverage', 'lower-is-better', 90, 'pct'),
      /direction lower-is-better disagrees/,
    ],
    ['invalid-json', () => write(coveragePath, 'not JSON'), /not valid JSON/],
  ])('a %s trust baseline fails the coverage ratchet', async (name, edit, reason) => {
    const head = prBranch('pr-bad-trust-' + name, 'merge-queue', () =>
      write('src/bad-trust-' + name + '.ts', 'export const example = 1;\n'),
    );
    const variant = prBranch('trust-' + name, trust, edit);
    const verdict = await verify(head, { trustRef: variant });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.results.find((r) => r.metric === 'coverage')).toMatchObject({
      verdict: 'fail',
      value: null,
    });
    expect(verdict.reasons.join('\n')).toMatch(reason);
  });

  test('unsupported recompute metrics and invalid recompute counts fail closed', async () => {
    const head = prBranch('pr-recompute-evidence', 'merge-queue', () =>
      write('src/recompute-evidence.ts', 'export const example = 1;\n'),
    );
    for (const count of [-1, 1.5]) {
      const verdict = await verify(head, { typecheckCount: count });
      expect(verdict.verdict).toBe('fail');
      expect(verdict.reasons.join('\n')).toMatch(/not a non-negative integer/);
    }

    const variant = prBranch('trust-unsupported-recompute', trust, () => {
      const manifest = structuredClone(MANIFEST);
      manifest.ratchets.push({
        target: 'custom',
        metric: 'custom-count',
        direction: 'lower-is-better',
        unit: 'errors',
        evidence: 'recompute',
      });
      write('baselines/ratchets.json', JSON.stringify(manifest));
      baseline('custom', 'custom-count', 'lower-is-better', 0, 'errors');
    });
    const verdict = await verify(head, { trustRef: variant });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reasons.join('\n')).toMatch(
      /no trusted recompute exists for metric 'custom-count'/,
    );
  });

  test('an unresolvable subject is `failed`', async () => {
    const result = await verifyRatchet({
      repo,
      trustRef: trust,
      subject: 'no-such-ref',
      subjectKind: 'pr',
      base: 'merge-queue',
      measureConclusion: 'success',
    });
    expect(result.status).toBe('failed');
  });

  test('a trust ref without the manifest is `failed`', async () => {
    const bare = git(['commit-tree', git(['mktree']), '-m', 'empty']);
    const result = await verifyRatchet({
      repo,
      trustRef: bare,
      subject: trust,
      subjectKind: 'push',
      base: 'main',
      measureConclusion: 'success',
    });
    expect(result.status).toBe('failed');
  });

  test('an option-shaped ref never reaches git as an option', async () => {
    const result = await verifyRatchet({
      repo,
      trustRef: '--output=/tmp/cq-w17-pwn',
      subject: trust,
      subjectKind: 'pr',
      base: 'merge-queue',
      measureConclusion: 'success',
    });
    expect(result.status).toBe('failed');
  });
});
