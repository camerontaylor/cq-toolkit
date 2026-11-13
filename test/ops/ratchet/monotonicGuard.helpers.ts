// Shared fixtures and diff-builder helpers for the split monotonicGuard
// test files, moved verbatim from the pre-split monotonicGuard.test.ts so
// review tooling can see below the 256 KiB single-file cap; every symbol
// is exported once here and imported by exactly the subject files that
// use it. No test titles live in this module (non-.test files are never
// collected).

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile, Direction } from '../../../src/ops/ratchet/format.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
const TARGET = 'typecheck';
const METRIC = 'typecheck-count';
const REL = baselineRelPath(TARGET, METRIC);
const COV_TARGET = 'coverage';
const COV_METRIC = 'coverage';
const REL_COV = baselineRelPath(COV_TARGET, COV_METRIC);

/** A real baseline body, rendered by the production serializer. */
function body(
  direction: Direction,
  value: number,
  overrides: Omit<Partial<BaselineFile>, 'unit'> & { unit?: string | null } = {},
): string {
  const { unit = 'errors', ...rest } = overrides;
  return renderBaseline({
    schemaVersion: 1,
    target: TARGET,
    metric: METRIC,
    direction,
    value,
    ...(unit === null ? {} : { unit }),
    capturedAt: CAPTURED_AT,
    ...rest,
  });
}

function covBody(value: number): string {
  return body('higher-is-better', value, {
    target: COV_TARGET,
    metric: COV_METRIC,
    unit: 'pct',
  });
}

function bodyLines(b: string): string[] {
  return b.split('\n').filter((l) => l !== '');
}

/**
 * Build one real staged diff containing all five baseline cases. The
 * section keys are stable fixture names so the single `git diff --cached`
 * can be split without committing any canned output.
 */
async function realGitDiffCases(
  extra: Record<string, { before: string | null; after: string | null }> = {},
): Promise<Record<string, string>> {
  const ws = await mkdtemp(join(tmpdir(), 'cq-gitdiff-'));
  const env = scrubbedGitEnv();
  const run = (args: string[]): void => {
    const r = spawnSync('git', args, {
      cwd: ws,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    if (r.error !== undefined || r.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed: ${r.error?.message ?? ''} ${String(r.stderr)}`,
      );
    }
  };
  const cases: Record<string, { before: string | null; after: string | null }> = {
    tighten: { before: body('lower-is-better', 3), after: body('lower-is-better', 2) },
    loosen: { before: body('lower-is-better', 2), after: body('lower-is-better', 3) },
    'clock-only': {
      before: body('lower-is-better', 2),
      after: body('lower-is-better', 2, { capturedAt: '2026-09-15T01:00:00.000Z' }),
    },
    added: { before: null, after: body('lower-is-better', 3) },
    deleted: { before: body('lower-is-better', 3), after: null },
    ...extra,
  };
  try {
    run(['init', '-q']);
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, 'README.md'), 'seed commit\n', 'utf8');
    for (const [name, fixture] of Object.entries(cases)) {
      if (fixture.before !== null) {
        await writeFile(join(ws, 'baselines', `${name}.json`), fixture.before, 'utf8');
      }
    }
    run(['add', '-A']);
    run([
      '-c',
      'user.email=guard@test',
      '-c',
      'user.name=guard',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'base',
    ]);
    for (const [name, fixture] of Object.entries(cases)) {
      const path = join(ws, 'baselines', `${name}.json`);
      if (fixture.after === null) await rm(path, { force: true });
      else await writeFile(path, fixture.after, 'utf8');
    }
    run(['add', '-A']);
    const diff = spawnSync(
      'git',
      ['-c', 'diff.renames=false', '-c', 'diff.noprefix=false', 'diff', '--cached'],
      {
        cwd: ws,
        env,
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      },
    );
    if (diff.error !== undefined || diff.status !== 0 || typeof diff.stdout !== 'string') {
      throw new Error(`git diff failed: ${diff.error?.message ?? ''} ${String(diff.stderr)}`);
    }
    const sections: Record<string, string> = {};
    for (const section of diff.stdout.split(/(?=^diff --git )/m)) {
      const match = /^diff --git \S+\/baselines\/(.+?)\.json /.exec(section);
      if (match?.[1] !== undefined) sections[match[1]] = section;
    }
    return sections;
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

/** Full-file-rewrite form: every old line removed, every new line added. */
function fullRewrite(rel: string, oldBody: string, newBody: string): string {
  return (
    [
      `diff --git a/${rel} b/${rel}`,
      'index 1111111..2222222 100644',
      `--- a/${rel}`,
      `+++ b/${rel}`,
      '@@ -1,7 +1,7 @@',
      ...bodyLines(oldBody).map((l) => `-${l}`),
      ...bodyLines(newBody).map((l) => `+${l}`),
    ].join('\n') + '\n'
  );
}

/**
 * Hunk form for bodies identical except one replaced line: only the
 * replaced line (plus `context` surrounding lines) appears, as a real git
 * diff would render it — context lines are space-prefixed and undiffed.
 */
function hunkDiff(rel: string, oldBody: string, newBody: string, context: number): string {
  const a = bodyLines(oldBody);
  const b = bodyLines(newBody);
  let first = 0;
  while (first < a.length && a[first] === b[first]) first += 1;
  let lastA = a.length - 1;
  while (lastA >= first && a[lastA] === b[lastA]) lastA -= 1;
  const start = Math.max(0, first - context);
  const end = Math.min(a.length - 1, lastA + context);
  const lines: string[] = [
    `diff --git a/${rel} b/${rel}`,
    'index 1111111..2222222 100644',
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${start + 1},${end - start + 1} +${start + 1},${end - start + 1} @@`,
  ];
  for (let k = start; k <= end; k++) {
    if (k < first || k > lastA) lines.push(` ${a[k]}`);
    else {
      lines.push(`-${a[k]}`);
      lines.push(`+${b[k]}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Hand-built MODIFIED section with exactly the given `-`/`+` content lines. */
function modifiedSection(rel: string, minus: string[], plus: string[]): string {
  return (
    [
      `diff --git a/${rel} b/${rel}`,
      'index 1111111..2222222 100644',
      `--- a/${rel}`,
      `+++ b/${rel}`,
      `@@ -1,${minus.length} +1,${plus.length} @@`,
      ...minus.map((l) => `-${l}`),
      ...plus.map((l) => `+${l}`),
    ].join('\n') + '\n'
  );
}

/** A `--no-renames` deleted-file section: the whole old body as `-` lines. */
function deletedSection(rel: string, oldBody: string): string {
  const lines = bodyLines(oldBody);
  return (
    [
      `diff --git a/${rel} b/${rel}`,
      'deleted file mode 100644',
      'index 1111111..0000000',
      `--- a/${rel}`,
      '+++ /dev/null',
      `@@ -1,${lines.length} +0,0 @@`,
      ...lines.map((l) => `-${l}`),
    ].join('\n') + '\n'
  );
}

/** A `--no-renames` added-file section: the whole new body as `+` lines. */
function addedSection(rel: string, newBody: string): string {
  const lines = bodyLines(newBody);
  return (
    [
      `diff --git a/${rel} b/${rel}`,
      'new file mode 100644',
      'index 0000000..2222222',
      '--- /dev/null',
      `+++ b/${rel}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
    ].join('\n') + '\n'
  );
}

/** Same (target, metric) at NEW paths — e.g. a path-hash scheme change. */
const REL_MOVED = 'baselines/typecheck--typecheck-count--0123456789ab.json';
const REL_MOVED_2 = 'baselines/typecheck--typecheck-count--ba9876543210.json';
const REL_MOVED_3 = 'baselines/typecheck--typecheck-count--fedcba987654.json';

const REL_CX = baselineRelPath('complexity', 'complexity');

function cxBody(value: number): string {
  return renderBaseline({
    schemaVersion: 1,
    target: 'complexity',
    metric: 'complexity',
    direction: 'lower-is-better',
    value,
    unit: 'avg-cx',
    capturedAt: CAPTURED_AT,
  });
}

export {
  CAPTURED_AT,
  COV_METRIC,
  COV_TARGET,
  METRIC,
  REL,
  REL_COV,
  REL_CX,
  REL_MOVED,
  REL_MOVED_2,
  REL_MOVED_3,
  TARGET,
  addedSection,
  body,
  bodyLines,
  covBody,
  cxBody,
  deletedSection,
  fullRewrite,
  hunkDiff,
  modifiedSection,
  realGitDiffCases,
};
