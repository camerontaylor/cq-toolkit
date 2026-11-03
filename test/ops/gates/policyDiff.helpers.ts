// W1.9 (D11) — the protected-path policy check (src/ops/gates/policyDiff.ts),
// over real tmp git repos (no network).
//
// Pinned (docs/methods-w1-9.md, "The check", is normative):
//   1. Each finding kind, under BOTH postures where it matters: `human`
//      routes every finding to needs-human; `diff-check` passes a plain
//      protected-path edit and routes every other kind to needs-human; `lint`
//      is `fail` in both (fail beats needs-human). `advisory` routes only
//      privileged-path (the trust-ref project list), baseline-loosened,
//      target-removed and entry-removed findings to needs-human; every other
//      finding passes as an `advisory:` report annotation; `lint` still fails.
//   2. #224 composition: a changed path with a `.git` segment (built with
//      plumbing, since the porcelain refuses it) or a backslash is an
//      `unsafe-path` finding and is never read.
//   3. #221/W1.7 composition: a repository configured with an external diff,
//      a textconv driver the head's `.gitattributes` selects, and an
//      fsmonitor hook runs none of them, and the verdict still sees the real
//      change.
//   4. The override record: honoured only with the C3 attestation on the
//      trust ref; dormant without it; an App-applied label is invalid; a push
//      subject carries no label of its own; an unreadable events file is
//      invalid, never `failed`. A push subject passes only through a bound
//      D11 authorization covering every needs-human path; `lint` stays fail.
//   5. The posture comes from the resolved config: the registry schema has no
//      posture field and a bogus env value fails the dispatch.
//
// Runtime: every fixture commit is written by ONE `git fast-import` per
// describe (no checkout, no index), each scenario is a branch off the trust
// commit, and a plain run is memoised per (subject, posture).
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import {
  POLICY_LIST_PATH,
  createPolicyDiff,
  type PolicyDiffInput,
  type PolicyDiffOutcome,
} from '../../../src/ops/gates/policyDiff.js';
import type { ProtectedPathsPosture } from '../../../src/ops/gates/policyConfig.js';

// Git-heavy suite: explicit budgets for hooks and tests (verifyRatchet's idiom).
export const SLOW = { timeout: 60_000 };
export const HOOK_MS = 60_000;

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
  // Deliberately WITHOUT `^\.github/` (the toolkit's own set has it): here a
  // workflow edit is judged by the workflow rules alone, so a comment-only
  // edit can pass under diff-check.
  definitionSet: [
    '(?:^|/)package\\.json$',
    '(?:^|/)tsconfig[^/]*\\.json$',
    '(?:^|/)\\.gitattributes$',
    '^baselines/',
    '^policy/protected-paths\\.json$',
    '^policy/attestations/',
  ],
};

export const POLICY = {
  schemaVersion: 1,
  protectedPaths: ['^src/guarded/'],
  // `build` has NO statically resolvable producer: matrix.yml's job is a matrix.
  requiredChecks: ['static', 'build'],
  requiredJobs: { 'ci.yml': ['static'] },
};

const wf = (...lines: string[]): string => `${lines.join('\n')}\n`;

/** Non-privileged; its `static` job produces the required check. */
export const CI = wf(
  'name: ci',
  'on:',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  static:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      # lint the tree',
  '      - run: npm run lint',
);

/** Privileged (`contents: write`), calling the local action `./actions/setup`. */
const DEPLOY = wf(
  'name: deploy',
  'on:',
  '  push:',
  '    branches:',
  '      - main',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  deploy:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: write',
  '    steps:',
  '      - uses: ./actions/setup',
  '      - run: echo deploy',
);

/** Non-privileged matrix job: GitHub suffixes its check names, so it resolves no producer. */
const MATRIX = wf(
  'name: matrix',
  'on:',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    strategy:',
  '      matrix:',
  '        node: [22, 24]',
  '    steps:',
  '      - run: npm run build',
);

export const CI_PATH = '.github/workflows/ci.yml';
export const MATRIX_PATH = '.github/workflows/matrix.yml';
export const DEPLOY_PATH = '.github/workflows/deploy.yml';
export const MANIFEST_PATH = 'baselines/ratchets.json';
export const COVERAGE_PATH = baselineRelPath('coverage', 'coverage');

export const baselineText = (value: number): string =>
  renderBaseline({
    schemaVersion: 1,
    target: 'coverage',
    metric: 'coverage',
    direction: 'higher-is-better',
    value,
    unit: 'pct',
    capturedAt: '2026-09-20T00:00:00.000Z',
  });

/** The trust commit's tree. */
const TRUST_FILES: Readonly<Record<string, string>> = {
  [MANIFEST_PATH]: `${JSON.stringify(MANIFEST, null, 2)}\n`,
  [COVERAGE_PATH]: baselineText(90),
  [POLICY_LIST_PATH]: `${JSON.stringify(POLICY, null, 2)}\n`,
  'tsconfig.json': '{ "include": ["src"] }\n',
  'package.json': '{ "name": "fixture" }\n',
  [CI_PATH]: CI,
  [DEPLOY_PATH]: DEPLOY,
  [MATRIX_PATH]: MATRIX,
  'actions/setup/action.yml': 'runs:\n  using: composite\n  steps: []\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/guarded/g.ts': 'export const g = 1;\n',
  'lint/x.txt': 'rule\n',
};

/** A fixture commit: file writes (`null` deletes) on top of `from` (default: the trust commit). */
export interface Spec {
  files: Readonly<Record<string, string | null>>;
  /** Symlink entries (mode 120000): path → link target. */
  symlinks?: Readonly<Record<string, string>>;
  from?: string;
}

export let root: string;
export let repo: string;
export let trust: string;
export let attestedTrust: string;
/** C3 attested AFTER the override tests' label: the #338 P1 no-retroactive case. */
export let lateAttestedTrust: string;
export let placeholderTrust: string;
export let eventsDir: string;
let savedPath: string | undefined;

export function gitIn(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    ...(input === undefined ? {} : { input }),
  }).trim();
}

/**
 * Write every spec as one commit on `refs/heads/<name>` with ONE
 * `git fast-import` (no checkout, no index — which is also how a `.GIT`
 * segment or a backslash path gets into a tree: the porcelain refuses them).
 * Returns name → commit SHA.
 */
export function importCommits(
  dir: string,
  specs: Readonly<Record<string, Spec>>,
  parent: string | null = trust,
): Record<string, string> {
  const parts: Buffer[] = [];
  const text = (t: string): void => {
    parts.push(Buffer.from(t, 'utf8'));
  };
  const data = (t: string): void => {
    text(`data ${Buffer.byteLength(t, 'utf8')}\n${t}\n`);
  };
  const names = Object.keys(specs);
  names.forEach((name, index) => {
    const spec = specs[name]!;
    text(`commit refs/heads/${name}\nmark :${index + 1}\n`);
    text('committer test <test@example.test> 1790000000 +0000\n');
    data(name);
    const from = spec.from ?? parent;
    if (from !== null) text(`from ${from}\n`);
    for (const [path, content] of Object.entries(spec.files)) {
      if (content === null) text(`D ${path}\n`);
      else {
        text(`M 100644 inline ${path}\n`);
        data(content);
      }
    }
    for (const [path, target] of Object.entries(spec.symlinks ?? {})) {
      text(`M 120000 inline ${path}\n`);
      data(target);
    }
    text('\n');
  });
  const marks = join(root, `marks-${names[0] ?? 'none'}`);
  execFileSync('git', ['fast-import', '--quiet', `--export-marks=${marks}`], {
    cwd: dir,
    env: GIT_ENV,
    input: Buffer.concat(parts),
  });
  const shas: Record<string, string> = {};
  for (const line of readFileSync(marks, 'utf8').trim().split('\n')) {
    const [mark, sha] = line.split(' ');
    const name = names[Number(mark!.slice(1)) - 1];
    if (name !== undefined && sha !== undefined) shas[name] = sha;
  }
  return shas;
}
/** A trust-tree file with one textual replacement (fails loudly if the needle is absent). */
export function edit(path: string, from: string, to: string): string {
  const base = TRUST_FILES[path]!;
  if (!base.includes(from)) throw new Error(`fixture: '${from}' not in ${path}`);
  return base.replace(from, to);
}

/**
 * Spawning git is the cost of every case, so a plain (no-override) run is
 * memoised per (subject, posture): the op is a pure function of the git
 * objects.
 */
const plainRuns = new Map<string, Promise<PolicyDiffOutcome>>();

async function judgeOnce(
  subject: string,
  posture: ProtectedPathsPosture,
  over: Partial<PolicyDiffInput>,
): Promise<PolicyDiffOutcome> {
  const result = await createPolicyDiff({ posture, layer: 'env' })({
    repo,
    trustRef: trust,
    subject,
    subjectKind: 'pr',
    base: 'merge-queue',
    ...over,
  });
  if (result.status !== 'ok') throw new Error(`policy ${result.status}: ${JSON.stringify(result)}`);
  return result.value;
}

export function run(
  subject: string,
  posture: ProtectedPathsPosture = 'human',
  over: Partial<PolicyDiffInput> = {},
): Promise<PolicyDiffOutcome> {
  if (Object.keys(over).length > 0) return judgeOnce(subject, posture, over);
  const key = `${subject}:${posture}`;
  let pending = plainRuns.get(key);
  if (pending === undefined) {
    pending = judgeOnce(subject, posture, over);
    plainRuns.set(key, pending);
  }
  return pending;
}

export const kinds = (o: PolicyDiffOutcome): string[] =>
  [...new Set(o.findings.map((f) => f.kind))].sort();

/** Both postures' verdicts for one subject. */
export async function verdicts(
  subject: string,
): Promise<Record<Exclude<ProtectedPathsPosture, 'advisory'>, string>> {
  const human = await run(subject, 'human');
  const diffCheck = await run(subject, 'diff-check');
  return { human: human.verdict, 'diff-check': diffCheck.verdict };
}

/**
 * The directory holding the `git` the PATH resolves to. Node's spawn walks
 * PATH entry by entry; on a host with a long PATH that walk costs more than
 * the git call itself. Prepending the resolved directory keeps the SAME git
 * binary (the op still spawns `git` by name, hardened argv unchanged) while
 * making the lookup O(1).
 */
function gitDir(): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, 'git'), constants.X_OK);
      return dir;
    } catch {
      // not here
    }
  }
  return undefined;
}

export function setupFixtures(): void {
  savedPath = process.env['PATH'];
  const dir = gitDir();
  if (dir !== undefined) process.env['PATH'] = `${dir}${delimiter}${savedPath ?? ''}`;
  GIT_ENV['PATH'] = process.env['PATH'];
  root = mkdtempSync(join(tmpdir(), 'cq-policy-diff-'));
  repo = join(root, 'repo');
  eventsDir = join(root, 'events');
  mkdirSync(eventsDir);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: GIT_ENV });
  trust = importCommits(repo, { main: { files: TRUST_FILES } }, null)['main']!;
  gitIn(repo, ['update-ref', 'refs/heads/merge-queue', trust]);
  const attestations = importCommits(repo, {
    attested: {
      files: {
        'policy/attestations/c3.json': `${JSON.stringify({ schemaVersion: 1, attests: 'C3', attestedAt: '2026-09-20T00:00:00Z' })}\n`,
      },
    },
    'late-attestation': {
      files: {
        'policy/attestations/c3.json': `${JSON.stringify({ schemaVersion: 1, attests: 'C3', attestedAt: '2026-09-26T00:00:00Z' })}\n`,
      },
    },
    'placeholder-attestation': { files: { 'policy/attestations/c3.json': '{}\n' } },
  });
  attestedTrust = attestations['attested']!;
  lateAttestedTrust = attestations['late-attestation']!;
  placeholderTrust = attestations['placeholder-attestation']!;
}

export function teardownFixtures(): void {
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
  rmSync(root, { recursive: true, force: true });
}

export function localActionFixtures() {
  // Own range bases, so the shared trust tree (and every case above) keeps a
  // `static` producer with no local action: `origin/merge-queue` is the
  // trust commit plus a producer running ./.github/actions/gate, which nests
  // ./.github/actions/inner; `origin/main` is the same with gate's metadata
  // carrying a `uses:` the line scan cannot read and the producer carrying a
  // block-scalar `uses:`. Both carry twin.yml, whose `twin` job also runs
  // gate: it produces a required check only under TWIN_POLICY's trust commit.
  const GATE = '.github/actions/gate/action.yml';
  const INNER = '.github/actions/inner/action.yml';
  const INNER_SCRIPT = '.github/actions/inner/check.sh';
  const OTHER = '.github/actions/other/action.yml';
  const OTHER_EDIT = 'runs:\n  using: composite\n  steps: [] # x\n';
  const MOVED = '.github/actions/moved/action.yml';
  const MOVED_SCRIPT = '.github/actions/moved/check.sh';
  const TWIN_PATH = '.github/workflows/twin.yml';
  const PRODUCER = `${CI_PATH}:static`;
  const TWIN = wf(
    'name: twin',
    'on:',
    '  pull_request:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  twin:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: ./.github/actions/gate',
  );
  const GATE_ACTION = wf(
    'name: gate',
    'runs:',
    '  using: composite',
    '  steps:',
    '    # the inner gate',
    '    - uses: ./.github/actions/inner',
    '    - shell: bash',
    '      run: npm run lint',
  );
  const INNER_ACTION = wf(
    'name: inner',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - shell: bash',
    '      run: ${{ github.action_path }}/check.sh',
  );
  const LA_FILES: Readonly<Record<string, string>> = {
    [CI_PATH]: edit(
      CI_PATH,
      '      - run: npm run lint\n',
      '      - uses: ./.github/actions/gate\n      - run: npm run lint\n',
    ),
    [GATE]: GATE_ACTION,
    [INNER]: INNER_ACTION,
    [INNER_SCRIPT]: 'npm run lint\n',
    [OTHER]: 'runs:\n  using: composite\n  steps: []\n',
    [TWIN_PATH]: TWIN,
  };
  const ROOT_BLOCK = '      - uses: >-\n          ./.github/actions/gate\n';
  const deepChain: Record<string, string> = {
    [GATE]: GATE_ACTION.replace('./.github/actions/inner', './.github/actions/d0'),
  };
  for (let i = 0; i < 10; i += 1) {
    deepChain[`.github/actions/d${i}/action.yml`] =
      `runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/d${i + 1}\n`;
  }
  // d6 nests d7 and e, and d7 nests e: e is in the depth-8 frontier AND queued
  // again for depth 9, where the bound check must skip it as already visited.
  const dedupChain: Record<string, string> = {
    [GATE]: GATE_ACTION.replace('./.github/actions/inner', './.github/actions/d0'),
    '.github/actions/e/action.yml': 'runs:\n  using: composite\n  steps: []\n',
  };
  for (let i = 0; i < 7; i += 1) {
    const uses =
      i === 6
        ? '    - uses: ./.github/actions/d7\n    - uses: ./.github/actions/e\n'
        : `    - uses: ./.github/actions/d${i + 1}\n`;
    dedupChain[`.github/actions/d${i}/action.yml`] = `runs:\n  using: composite\n  steps:\n${uses}`;
  }
  dedupChain['.github/actions/d7/action.yml'] =
    'runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/e\n';
  const changed = (path: string, target: string): unknown => ({
    kind: 'required-check',
    path,
    reason: `changes ${path} in local action ./${target} run by ${PRODUCER}, a producer of required check static`,
  });
  const notLiteral = (side: string): unknown => ({
    kind: 'required-check',
    path: CI_PATH,
    reason: `local action of required check static unresolvable at the ${side} (${PRODUCER}: a uses: value is not a literal)`,
  });
  let c: Record<string, string>;
  let laBase: string;
  let brokenBase: string;
  let twinTrust: string;
  const setup = async (): Promise<void> => {
    const bases = importCommits(repo, {
      'la-base': { files: LA_FILES },
      'la-broken': {
        files: {
          ...LA_FILES,
          [GATE]: GATE_ACTION.replace('- uses: ./', '- uses: >-\n        ./'),
          [CI_PATH]: LA_FILES[CI_PATH]!.replace(
            '      - run: npm run lint\n',
            `${ROOT_BLOCK.replace('/gate', '/other')}      - run: npm run lint\n`,
          ),
        },
      },
      'la-twin-trust': {
        files: {
          [POLICY_LIST_PATH]: `${JSON.stringify({ ...POLICY, requiredChecks: ['static', 'twin'] }, null, 2)}\n`,
        },
      },
    });
    laBase = bases['la-base']!;
    brokenBase = bases['la-broken']!;
    twinTrust = bases['la-twin-trust']!;
    gitIn(repo, ['update-ref', 'refs/remotes/origin/merge-queue', laBase]);
    gitIn(repo, ['update-ref', 'refs/remotes/origin/main', brokenBase]);
    c = importCommits(
      repo,
      {
        'la-action-edit': {
          files: { [GATE]: GATE_ACTION.replace('npm run lint', 'npm run lint -- --quiet') },
        },
        'la-nested-edit': { files: { [INNER_SCRIPT]: 'true\n' } },
        'la-unrelated': { files: { 'src/a.ts': 'export const a = 2;\n' } },
        'la-other-action': { files: { [OTHER]: 'runs:\n  using: composite\n  steps: [] # x\n' } },
        'la-comment': {
          files: { [GATE]: GATE_ACTION.replace('# the inner gate', '# the whole inner gate') },
        },
        'la-metadata-gone': { files: { [INNER]: null } },
        'la-metadata-symlink': {
          files: { [INNER]: null },
          symlinks: { [INNER]: '../gate/action.yml' },
        },
        'la-escape': {
          files: { [GATE]: `${GATE_ACTION}    - uses: ./.github/../outside\n` },
        },
        'la-cycle': {
          files: { [INNER]: `${INNER_ACTION}    - uses: ./.github/actions/gate/\n` },
        },
        'la-deep': { files: deepChain },
        'la-deep-dedup': { files: dedupChain },
        'la-hidden-cr': {
          files: {
            // The hidden line sits behind a `#` line: an LF-only splitter
            // reads the whole physical line as a comment and skips it.
            [GATE]: GATE_ACTION.replace(
              'name: gate\n',
              'name: gate\n# x\r    - Uses: ./.github/actions/other\n',
            ),
          },
        },
        'la-hidden-ls': {
          files: {
            [GATE]: GATE_ACTION.replace(
              'name: gate\n',
              'name: gate\n# x\u2028    - Uses: ./.github/actions/other\n',
            ),
          },
        },
        'la-root-continued': {
          files: {
            [CI_PATH]: LA_FILES[CI_PATH]!.replace(
              '      - uses: ./.github/actions/gate\n',
              '      - uses: ./.github/actions/gate\n          x\n',
            ),
          },
        },
        'la-nested-continued': {
          files: {
            [GATE]: GATE_ACTION.replace(
              '- uses: ./.github/actions/inner',
              '- uses: ./.github/actions/inner\n        x',
            ),
          },
        },
        'la-prose-causes': {
          files: {
            [GATE]: GATE_ACTION.replace(
              'name: gate\n',
              'name: gate\ndescription: Fixes what causes the statuses to differ.\n',
            ),
          },
        },
        'la-sibling': { files: { '.github/actions/gate2/x': 'x\n' } },
        'la-ref-add': {
          files: {
            [GATE]: `${GATE_ACTION}    - uses: ./.github/actions/other\n`,
            [OTHER]: OTHER_EDIT,
          },
        },
        'la-ref-remove': {
          files: {
            [GATE]: GATE_ACTION.replace('    - uses: ./.github/actions/inner\n', ''),
            [INNER_SCRIPT]: 'true\n',
          },
        },
        'la-ref-rename': {
          files: {
            [GATE]: GATE_ACTION.replace('./.github/actions/inner', './.github/actions/moved'),
            [INNER]: null,
            [INNER_SCRIPT]: null,
            [MOVED]: INNER_ACTION,
            [MOVED_SCRIPT]: 'npm run lint\n',
          },
        },
        'la-value-single-quoted': {
          files: {
            [GATE]: GATE_ACTION.replace('./.github/actions/inner', "'./.github/actions/other'"),
            [OTHER]: OTHER_EDIT,
          },
        },
        'la-value-double-quoted': {
          files: {
            [GATE]: GATE_ACTION.replace('./.github/actions/inner', '"./.github/actions/other"'),
            [OTHER]: OTHER_EDIT,
          },
        },
        'la-value-comment': {
          files: {
            [GATE]: GATE_ACTION.replace(
              './.github/actions/inner',
              './.github/actions/other # pinned',
            ),
            [OTHER]: OTHER_EDIT,
          },
        },
        'la-key-double-quoted': {
          files: { [GATE]: GATE_ACTION.replace('- uses:', '- "uses":') },
        },
        'la-key-single-quoted': {
          files: { [GATE]: GATE_ACTION.replace('- uses:', "- 'uses':") },
        },
        'la-key-uppercase': { files: { [GATE]: GATE_ACTION.replace('- uses:', '- Uses:') } },
        'la-key-escaped': {
          files: { [GATE]: GATE_ACTION.replace('- uses:', '- "\\u0075ses":') },
        },
        'la-key-explicit': {
          files: {
            [GATE]: GATE_ACTION.replace(
              '- uses: ./.github/actions/inner',
              '- ? uses\n      : ./.github/actions/inner',
            ),
          },
        },
        'la-value-hash': {
          files: {
            [GATE]: GATE_ACTION.replace('./.github/actions/inner', './.github/actions/inner#2'),
          },
        },
        'la-root-block': {
          files: {
            [CI_PATH]: LA_FILES[CI_PATH]!.replace(
              '      - uses: ./.github/actions/gate\n',
              ROOT_BLOCK,
            ),
          },
        },
        'la-broken-unrelated': {
          files: { 'src/a.ts': 'export const a = 3;\n' },
          from: brokenBase,
        },
      },
      laBase,
    );
  };

  const judge = (name: string, posture: ProtectedPathsPosture = 'diff-check') =>
    run(c[name]!, posture, {
      base: name.startsWith('la-broken')
        ? 'refs/remotes/origin/main'
        : 'refs/remotes/origin/merge-queue',
    });

  // Separate base/subject commits ensure these regressions exercise action-only
  // edits: a workflow edit must not accidentally supply the required finding.
  const actionOnly = async (
    name: string,
    files: Record<string, string>,
  ): Promise<PolicyDiffOutcome> => {
    const base = importCommits(repo, { [`${name}-base`]: { files } }, laBase)[`${name}-base`]!;
    const subject = importCommits(
      repo,
      {
        [`${name}-subject`]: { files: { [INNER_SCRIPT]: 'regression edit\n' } },
      },
      base,
    )[`${name}-subject`]!;
    gitIn(repo, ['update-ref', 'refs/remotes/origin/main', base]);
    try {
      return await run(subject, 'diff-check', { base: 'refs/remotes/origin/main' });
    } finally {
      gitIn(repo, ['update-ref', 'refs/remotes/origin/main', brokenBase]);
    }
  };
  return {
    setup,
    judge,
    actionOnly,
    changed,
    notLiteral,
    PRODUCER,
    TWIN_PATH,
    GATE_ACTION,
    GATE,
    INNER,
    INNER_SCRIPT,
    OTHER,
    MOVED,
    MOVED_SCRIPT,
    LA_FILES,
    get c() {
      return c;
    },
    get twinTrust() {
      return twinTrust;
    },
  };
}
