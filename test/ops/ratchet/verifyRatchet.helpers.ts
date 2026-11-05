// Split provenance: test/ops/ratchet/verifyRatchet.test.ts was split by
// subject into verifyRatchet.{clean-pr,measurement-artifact,trust-definitions,guard-range,faults,subject-baseline,d11-authorization,advisory-posture}.test.ts;
// this module holds their shared real-git fixture (no tests). The original
// header follows.
//
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
//   6. A bound D11 authorization (the gate's predicate, d11Authorization.ts):
//      an authorized definition change is judged on its evidence (a
//      regression still fails); a dormant record or a path no admitted PR
//      contributed stays needs-human; the next unrelated PR inherits nothing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import {
  verifyRatchet,
  type VerifyRatchetInput,
  type VerifyRatchetOutcome,
} from '../../../src/ops/ratchet/verifyRatchet.js';

// Every case spawns several real git processes; on a loaded host one spawn
// can take a second, so the budgets are generous (slice 3's git tests too).
export const SLOW = { timeout: 120_000 };
// The fixture hook budget: the trust tree is built with real git spawns.
export const HOOK_MS = 120_000;

export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

export const MANIFEST = {
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

export let root: string;
export let repo: string;
export let trust: string;

export function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim();
}

export function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function baseline(
  target: string,
  metric: string,
  direction: string,
  value: number,
  unit: string,
) {
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

export function commit(message: string): string {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

/** A PR branch off `from` with `edit` applied; returns its head SHA. */
export function prBranch(name: string, from: string, edit: () => void): string {
  git(['checkout', '-q', '-B', name, from]);
  edit();
  const sha = commit(name);
  git(['checkout', '-q', 'main']);
  return sha;
}

export let artifactDir: string;
export function artifact(name: string, body: unknown): string {
  const path = join(artifactDir, name);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

export const good = (): string =>
  artifact('good.json', { schemaVersion: 1, metrics: { coverage: 90.04 } });

export async function verify(
  subject: string,
  over: Partial<VerifyRatchetInput> = {},
  op = verifyRatchet,
): Promise<VerifyRatchetOutcome> {
  const result = await op({
    repo,
    trustRef: trust,
    subject,
    subjectKind: 'pr',
    base: 'merge-queue',
    measureConclusion: 'success',
    measurementPath: good(),
    ...(over.typecheckSkipped === undefined ? { typecheckCount: 0 } : {}),
    ...over,
  });
  if (result.status !== 'ok') throw new Error(`verify ${result.status}: ${JSON.stringify(result)}`);
  return result.value;
}

export function setupFixtures(): void {
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
  write('tsconfig.json', '{ "extends": "./config/base", "include": ["src"] }\n');
  write('config/base.json', '{ "compilerOptions": { "strict": true } }\n');
  write(
    'policy/protected-paths.json',
    JSON.stringify({ schemaVersion: 1, protectedPaths: ['^policy/'], requiredChecks: [] }),
  );
  write('src/a.ts', 'export const a = 1;\n');
  trust = commit('trust');
  git(['branch', 'merge-queue', trust]);
}

export function teardownFixtures(): void {
  rmSync(root, { recursive: true, force: true });
}
