// §7 A5 — a PR that renames a ratchet target, loosens its baseline, or adds
// an extra baseline.
//
// The prior A5 row only proved that these paths match isProtectedPolicyPath.
// Under the owner-selectable `diff-check` posture a finding whose ONLY kind is
// `protected-path` passes, so A5 actually rests on the target-removed,
// definition-changed and baseline-monotonicity findings. This file judges the
// ATTACK over real git objects: a scratch repository whose trust ref carries a
// real ratchet manifest and baseline, hostile PR commits written with real
// `git fast-import`, and the real D11 check (src/ops/gates/policyDiff.ts) run
// over `merge-base..head` — offline, no network.
//
// What is pinned, as the actual verdict and finding kinds:
//   1. Renaming the target (manifest entry and its baseline, re-added looser)
//      is needs-human in BOTH postures, carrying target-removed,
//      definition-changed and baseline-loosened.
//   2. Loosening the baseline in place is needs-human in both postures,
//      carrying baseline-loosened.
//   3. Registering a new target with an extra baseline is needs-human in both
//      postures, carrying definition-changed.
//   4. An extra canonical baseline that no manifest target names is ONLY a
//      protected-path finding: needs-human under `human`, and a pass under
//      `diff-check` — that posture's documented meaning, pinned here rather
//      than left implicit. It gates nothing until (3) registers its target.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { baselineRelPath, renderBaseline } from '../../src/ops/ratchet/format.js';
import { createPolicyDiff, POLICY_LIST_PATH } from '../../src/ops/gates/policyDiff.js';
import type { PolicyDiffInput, PolicyDiffOutcome } from '../../src/ops/gates/policyDiff.js';
import type { ProtectedPathsPosture } from '../../src/ops/gates/policyConfig.js';

const SLOW = { timeout: 60_000 };
const HOOK_MS = 60_000;

// A parent git (e.g. a hook running vitest) can export variables that override
// `cwd` and point every call below at the caller's repository instead.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
for (const key of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
])
  delete GIT_ENV[key];

const MANIFEST_PATH = 'baselines/ratchets.json';
const TARGET = 'typecheck';
const METRIC = 'typecheck-count';
const BASELINE_PATH = baselineRelPath(TARGET, METRIC);

const ratchet = (target: string) => ({
  target,
  metric: METRIC,
  direction: 'lower-is-better',
  unit: 'errors',
  evidence: 'recompute',
});

const manifestText = (...targets: string[]): string =>
  `${JSON.stringify(
    {
      schemaVersion: 1,
      ratchets: targets.map(ratchet),
      definitionSet: [
        '(?:^|/)package\\.json$',
        '(?:^|/)tsconfig[^/]*\\.json$',
        '^baselines/',
        '^\\.github/workflows/',
        '^policy/protected-paths\\.json$',
      ],
    },
    null,
    2,
  )}\n`;

const baselineText = (target: string, value: number): string =>
  renderBaseline({
    schemaVersion: 1,
    target,
    metric: METRIC,
    direction: 'lower-is-better',
    value,
    unit: 'errors',
    capturedAt: '2026-09-20T00:00:00.000Z',
  });

const CI = [
  'name: ci',
  'on:',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  static:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: pnpm run lint',
  '',
].join('\n');

const TRUST_FILES: Readonly<Record<string, string>> = {
  [MANIFEST_PATH]: manifestText(TARGET),
  [BASELINE_PATH]: baselineText(TARGET, 5),
  [POLICY_LIST_PATH]: `${JSON.stringify(
    { schemaVersion: 1, protectedPaths: [], requiredChecks: ['static'] },
    null,
    2,
  )}\n`,
  'tsconfig.json': '{ "include": ["src"] }\n',
  'package.json': '{ "name": "fixture" }\n',
  '.github/workflows/ci.yml': CI,
};

const RENAMED = 'typecheck-renamed';
const SHADOW = 'typecheck-shadow';

let root: string;
let repo: string;
let trust: string;
let heads: Record<string, string>;

/** Write each named file set (`null` deletes) as one commit on `parent`, with ONE fast-import. */
function importCommits(
  specs: Readonly<Record<string, Readonly<Record<string, string | null>>>>,
  parent: string | null,
): Record<string, string> {
  const parts: string[] = [];
  const data = (t: string): void => {
    parts.push(`data ${Buffer.byteLength(t, 'utf8')}\n${t}\n`);
  };
  const names = Object.keys(specs);
  names.forEach((name, index) => {
    parts.push(`commit refs/heads/${name}\nmark :${index + 1}\n`);
    parts.push('committer test <test@example.test> 1790000000 +0000\n');
    data(name);
    if (parent !== null) parts.push(`from ${parent}\n`);
    for (const [path, content] of Object.entries(specs[name]!)) {
      if (content === null) parts.push(`D ${path}\n`);
      else {
        parts.push(`M 100644 inline ${path}\n`);
        data(content);
      }
    }
    parts.push('\n');
  });
  const marks = join(root, `marks-${String(names[0] ?? 'none')}`);
  execFileSync('git', ['fast-import', '--quiet', `--export-marks=${marks}`], {
    cwd: repo,
    env: GIT_ENV,
    input: parts.join(''),
  });
  const shas: Record<string, string> = {};
  for (const line of readFileSync(marks, 'utf8').trim().split('\n')) {
    const [mark, sha] = line.split(' ');
    const name = names[Number(mark!.slice(1)) - 1];
    if (name !== undefined && sha !== undefined) shas[name] = sha;
  }
  return shas;
}

async function judge(subject: string, posture: ProtectedPathsPosture): Promise<PolicyDiffOutcome> {
  const input: PolicyDiffInput = {
    repo,
    trustRef: trust,
    subject,
    subjectKind: 'pr',
    base: 'merge-queue',
  };
  const result = await createPolicyDiff({ posture, layer: 'env' })(input);
  if (result.status !== 'ok') throw new Error(`policy ${result.status}: ${JSON.stringify(result)}`);
  return result.value as PolicyDiffOutcome;
}

const kinds = (out: PolicyDiffOutcome): string[] =>
  [...new Set(out.findings.map((f) => f.kind))].sort();

async function bothPostures(subject: string) {
  const human = await judge(subject, 'human');
  const diffCheck = await judge(subject, 'diff-check');
  return { human, diffCheck };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-a5-ratchet-'));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: GIT_ENV });
  trust = importCommits({ main: TRUST_FILES }, null)['main']!;
  execFileSync('git', ['update-ref', 'refs/heads/merge-queue', trust], {
    cwd: repo,
    env: GIT_ENV,
  });
  heads = importCommits(
    {
      rename: {
        [MANIFEST_PATH]: manifestText(RENAMED),
        [BASELINE_PATH]: null,
        [baselineRelPath(RENAMED, METRIC)]: baselineText(RENAMED, 50),
      },
      loosen: { [BASELINE_PATH]: baselineText(TARGET, 50) },
      'register-target': {
        [MANIFEST_PATH]: manifestText(TARGET, SHADOW),
        [baselineRelPath(SHADOW, METRIC)]: baselineText(SHADOW, 500),
      },
      'extra-baseline': { [baselineRelPath(SHADOW, METRIC)]: baselineText(SHADOW, 500) },
    },
    trust,
  );
}, HOOK_MS);

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('§7 A5 ratchet target rename and extra baseline', SLOW, () => {
  test('renaming the target (re-added looser) is needs-human in both postures', async () => {
    const { human, diffCheck } = await bothPostures(heads['rename']!);
    expect(human.verdict).toBe('needs-human');
    expect(diffCheck.verdict).toBe('needs-human');
    expect(kinds(diffCheck)).toEqual(
      expect.arrayContaining(['target-removed', 'definition-changed', 'baseline-loosened']),
    );
    expect(diffCheck.findings).toContainEqual(
      expect.objectContaining({ kind: 'target-removed', path: MANIFEST_PATH }),
    );
    expect(diffCheck.findings).toContainEqual(
      expect.objectContaining({ kind: 'baseline-loosened', path: BASELINE_PATH }),
    );
  });

  test('loosening the baseline in place is needs-human in both postures', async () => {
    const { human, diffCheck } = await bothPostures(heads['loosen']!);
    expect(human.verdict).toBe('needs-human');
    expect(diffCheck.verdict).toBe('needs-human');
    expect(diffCheck.findings).toContainEqual(
      expect.objectContaining({ kind: 'baseline-loosened', path: BASELINE_PATH }),
    );
  });

  test('registering a new target with an extra baseline is needs-human in both postures', async () => {
    const { human, diffCheck } = await bothPostures(heads['register-target']!);
    expect(human.verdict).toBe('needs-human');
    expect(diffCheck.verdict).toBe('needs-human');
    expect(diffCheck.findings).toContainEqual(
      expect.objectContaining({ kind: 'definition-changed', path: MANIFEST_PATH }),
    );
  });

  test('an unregistered extra baseline is protected-path only: needs-human under human, pass under diff-check', async () => {
    const { human, diffCheck } = await bothPostures(heads['extra-baseline']!);
    expect(kinds(human)).toEqual(['protected-path']);
    expect(human.verdict).toBe('needs-human');
    expect(kinds(diffCheck)).toEqual(['protected-path']);
    expect(diffCheck.verdict).toBe('pass');
  });
});
