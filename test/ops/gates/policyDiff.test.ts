// W1.9 (D11) — the protected-path policy check (src/ops/gates/policyDiff.ts),
// over real tmp git repos (no network).
//
// Pinned (docs/methods-w1-9.md, "The check", is normative):
//   1. Each finding kind, under BOTH postures where it matters: `human`
//      routes every finding to needs-human; `diff-check` passes a plain
//      protected-path edit and routes every other kind to needs-human; `lint`
//      is `fail` in both (fail beats needs-human).
//   2. #224 composition: a changed path with a `.git` segment (built with
//      plumbing, since the porcelain refuses it) or a backslash is an
//      `unsafe-path` finding and is never read.
//   3. #221/W1.7 composition: a repository configured with an external diff,
//      a textconv driver the head's `.gitattributes` selects, and an
//      fsmonitor hook runs none of them, and the verdict still sees the real
//      change.
//   4. The override record: honoured only with the C3 attestation on the
//      trust ref; dormant without it; an App-applied label is invalid; a push
//      subject is never evaluated; an unreadable events file is invalid,
//      never `failed`.
//   5. The posture comes from the resolved config: the registry schema has no
//      posture field and a bogus env value fails the dispatch.
//
// Runtime: every fixture commit is written by ONE `git fast-import` per
// describe (no checkout, no index), each scenario is a branch off the trust
// commit, and a plain run is memoised per (subject, posture).
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import {
  LABEL_EVENTS_MAX_BYTES,
  POLICY_LIST_PATH,
  createPolicyDiff,
  type PolicyDiffInput,
  type PolicyDiffOutcome,
} from '../../../src/ops/gates/policyDiff.js';
import type { ProtectedPathsPosture } from '../../../src/ops/gates/policyConfig.js';
import { registry } from '../../../src/ops/gates/registry.js';

// Git-heavy suite: explicit budgets for hooks and tests (verifyRatchet's idiom).
const SLOW = { timeout: 60_000 };
const HOOK_MS = 60_000;

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

const POLICY = {
  schemaVersion: 1,
  protectedPaths: ['^src/guarded/'],
  // `build` has NO statically resolvable producer: matrix.yml's job is a matrix.
  requiredChecks: ['static', 'build'],
};

const wf = (...lines: string[]): string => `${lines.join('\n')}\n`;

/** Non-privileged; its `static` job produces the required check. */
const CI = wf(
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

const CI_PATH = '.github/workflows/ci.yml';
const MATRIX_PATH = '.github/workflows/matrix.yml';
const DEPLOY_PATH = '.github/workflows/deploy.yml';
const MANIFEST_PATH = 'baselines/ratchets.json';
const COVERAGE_PATH = baselineRelPath('coverage', 'coverage');

const baselineText = (value: number): string =>
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
interface Spec {
  files: Readonly<Record<string, string | null>>;
  /** Symlink entries (mode 120000): path → link target. */
  symlinks?: Readonly<Record<string, string>>;
  from?: string;
}

let root: string;
let repo: string;
let trust: string;
let attestedTrust: string;
let placeholderTrust: string;
let eventsDir: string;
let savedPath: string | undefined;

function gitIn(cwd: string, args: string[], input?: string): string {
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
function importCommits(
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

/** One raw tree entry: mode, name, 20-byte oid. */
interface RawEntry {
  mode: string;
  name: string;
  oid: Buffer;
}

/** Write `bytes` as a loose object of `type` with NO fsck (`hash-object --literally`). */
function writeLiteral(dir: string, type: 'blob' | 'tree', bytes: Buffer): string {
  return execFileSync('git', ['hash-object', '--literally', '-t', type, '-w', '--stdin'], {
    cwd: dir,
    env: GIT_ENV,
    input: bytes,
  })
    .toString('utf8')
    .trim();
}

/** Git's tree order: byte order, with a tree's name compared as if it ended in `/`. */
function treeKey(e: RawEntry): Buffer {
  return Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name, 'utf8');
}

function serializeTree(entries: RawEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeKey(a), treeKey(b)));
  return Buffer.concat(
    sorted.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), e.oid]),
  );
}

/**
 * A commit on `parent` adding one file at `<dir>/<name>` (or `<name>` at the
 * root when `dir` is null), with every object written raw — the only way to
 * get a `.GIT` segment into a tree once fast-import's fsck refuses it.
 */
function literalCommit(
  dir: string,
  parent: string,
  sub: string | null,
  name: string,
  content: string,
): string {
  const raw = execFileSync('git', ['cat-file', 'tree', `${parent}^{tree}`], {
    cwd: dir,
    env: GIT_ENV,
  });
  const entries: RawEntry[] = [];
  for (let at = 0; at < raw.length;) {
    const nul = raw.indexOf(0, at);
    const [mode, ...rest] = raw.subarray(at, nul).toString('utf8').split(' ');
    entries.push({ mode: mode!, name: rest.join(' '), oid: raw.subarray(nul + 1, nul + 21) });
    at = nul + 21;
  }
  const blob = Buffer.from(writeLiteral(dir, 'blob', Buffer.from(content, 'utf8')), 'hex');
  const file: RawEntry = { mode: '100644', name, oid: blob };
  if (sub === null) entries.push(file);
  else {
    const tree = writeLiteral(dir, 'tree', serializeTree([file]));
    entries.push({ mode: '40000', name: sub, oid: Buffer.from(tree, 'hex') });
  }
  const root = writeLiteral(dir, 'tree', serializeTree(entries));
  return execFileSync('git', ['commit-tree', root, '-p', parent, '-m', `literal ${name}`], {
    cwd: dir,
    env: {
      ...GIT_ENV,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  })
    .toString('utf8')
    .trim();
}

/** A trust-tree file with one textual replacement (fails loudly if the needle is absent). */
function edit(path: string, from: string, to: string): string {
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

function run(
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

const kinds = (o: PolicyDiffOutcome): string[] =>
  [...new Set(o.findings.map((f) => f.kind))].sort();

/** Both postures' verdicts for one subject. */
async function verdicts(subject: string): Promise<Record<ProtectedPathsPosture, string>> {
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

beforeAll(() => {
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
        'policy/attestations/c3.json': `${JSON.stringify({ schemaVersion: 1, attests: 'C3', attestedAt: '2026-09-26T00:00:00Z' })}\n`,
      },
    },
    'placeholder-attestation': { files: { 'policy/attestations/c3.json': '{}\n' } },
  });
  attestedTrust = attestations['attested']!;
  placeholderTrust = attestations['placeholder-attestation']!;
}, HOOK_MS);

afterAll(() => {
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe('policyDiff: plain changes', SLOW, () => {
  let c: Record<string, string>;
  beforeAll(() => {
    c = importCommits(repo, {
      clean: { files: { 'src/a.ts': 'export const a = 2;\n' } },
      'lint-edit': { files: { 'lint/x.txt': 'rule2\n' } },
      guarded: { files: { 'src/guarded/g.ts': 'export const g = 2;\n' } },
      pkg: { files: { 'package.json': '{ "name": "fixture2" }\n' } },
    });
  }, HOOK_MS);

  test('a clean non-protected change passes in both postures', async () => {
    const subject = c['clean']!;
    const out = await run(subject);
    expect(out.findings).toEqual([]);
    expect(out.rangeBase).toBe(trust);
    expect(out.report[0]).toBe('posture: human (layer env)');
    expect(out.report).toContain(`range: ${trust}..${subject} (trust ${trust})`);
    expect(out.report.at(-1)).toBe('verdict: pass');
    expect(await verdicts(subject)).toEqual({ human: 'pass', 'diff-check': 'pass' });
  });

  test('a protected non-definition change needs a human only under `human`', async () => {
    const out = await run(c['lint-edit']!, 'diff-check');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: 'lint/x.txt', reason: 'changes a protected path' },
    ]);
    expect(await verdicts(c['lint-edit']!)).toEqual({ human: 'needs-human', 'diff-check': 'pass' });
  });

  test('the trust-ref policy list protects project paths', async () => {
    expect(kinds(await run(c['guarded']!))).toEqual(['protected-path']);
    expect(await verdicts(c['guarded']!)).toEqual({ human: 'needs-human', 'diff-check': 'pass' });
  });

  test('a definition-set file (package.json) is needs-human under diff-check', async () => {
    expect(kinds(await run(c['pkg']!))).toEqual(['definition-changed', 'protected-path']);
    expect(await verdicts(c['pkg']!)).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
  });
});

describe('policyDiff: baselines and definitions', SLOW, () => {
  let c: Record<string, string>;
  beforeAll(() => {
    const m = structuredClone(MANIFEST);
    m.definitionSet = m.definitionSet.filter((e) => e !== '(?:^|/)package\\.json$');
    m.ratchets = m.ratchets.filter((r) => r.target !== 'coverage');
    c = importCommits(repo, {
      loosen: { files: { [COVERAGE_PATH]: baselineText(80) } },
      tighten: { files: { [COVERAGE_PATH]: baselineText(95) } },
      manifest: { files: { [MANIFEST_PATH]: `${JSON.stringify(m, null, 2)}\n` } },
      'manifest-bad': { files: { [MANIFEST_PATH]: '{ nope' } },
      'policy-trim': {
        files: {
          [POLICY_LIST_PATH]: JSON.stringify({ ...POLICY, protectedPaths: [], requiredChecks: [] }),
        },
      },
      'policy-delete': { files: { [POLICY_LIST_PATH]: null } },
    });
  }, HOOK_MS);

  test('a loosened baseline needs a human in both postures', async () => {
    const out = await run(c['loosen']!, 'diff-check');
    // The canonical value file is judged by the guard, not the definition rule.
    expect(kinds(out)).toEqual(['baseline-loosened', 'protected-path']);
    expect(out.findings.find((f) => f.kind === 'baseline-loosened')?.reason).toMatch(/loosened/);
    expect(await verdicts(c['loosen']!)).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
  });

  test('a tightened baseline passes under diff-check', async () => {
    expect(kinds(await run(c['tighten']!))).toEqual(['protected-path']);
    expect(await verdicts(c['tighten']!)).toEqual({ human: 'needs-human', 'diff-check': 'pass' });
  });

  test('a removed definitionSet entry and a removed ratchet target are findings', async () => {
    const out = await run(c['manifest']!, 'diff-check');
    expect(out.findings).toEqual(
      expect.arrayContaining([
        {
          kind: 'entry-removed',
          path: MANIFEST_PATH,
          reason: 'removes definitionSet entry (?:^|/)package\\.json$',
        },
        {
          kind: 'target-removed',
          path: MANIFEST_PATH,
          reason: 'removes ratchet coverage/coverage',
        },
        {
          kind: 'definition-changed',
          path: MANIFEST_PATH,
          reason: 'changes a ratchet definition (definition set or tsconfig graph)',
        },
      ]),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('an unparseable subject manifest is an entry-removed finding', async () => {
    const out = await run(c['manifest-bad']!, 'diff-check');
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'entry-removed', path: MANIFEST_PATH }),
    );
    expect(out.findings.find((f) => f.kind === 'entry-removed')?.reason).toMatch(
      /subject manifest unreadable/,
    );
  });

  test('removed policy-list entries and a deleted policy list are findings', async () => {
    expect((await run(c['policy-trim']!, 'diff-check')).findings).toEqual(
      expect.arrayContaining([
        {
          kind: 'entry-removed',
          path: POLICY_LIST_PATH,
          reason: 'removes protectedPaths entry ^src/guarded/',
        },
        {
          kind: 'entry-removed',
          path: POLICY_LIST_PATH,
          reason: 'removes requiredChecks entry static',
        },
      ]),
    );
    const out = await run(c['policy-delete']!, 'diff-check');
    expect(out.findings).toContainEqual({
      kind: 'entry-removed',
      path: POLICY_LIST_PATH,
      reason: 'subject policy list unreadable (deleted)',
    });
    expect(out.verdict).toBe('needs-human');
  });
});

describe('policyDiff: workflows', SLOW, () => {
  const PRIVILEGE: readonly (readonly [string, string])[] = [
    ['permissions write', '    permissions:\n      contents: write\n'],
    ['a secret', '    env:\n      KEY: ${{ secrets.DEPLOY_KEY }}\n'],
    ['an environment', '    environment: prod\n'],
  ];
  const RUNS_ON = '    runs-on: ubuntu-latest\n';
  let c: Record<string, string>;
  beforeAll(() => {
    const specs: Record<string, Spec> = {
      'new-wf': { files: { '.github/workflows/new.yml': CI } },
      trigger: {
        files: { [CI_PATH]: edit(CI_PATH, '  pull_request:\n', '  pull_request:\n  push:\n') },
      },
      'priv-edit': {
        files: { [DEPLOY_PATH]: edit(DEPLOY_PATH, 'echo deploy', 'echo deploy now') },
      },
      comment: { files: { [CI_PATH]: edit(CI_PATH, '# lint the tree', '# lint the whole tree') } },
      'producer-if': {
        files: { [CI_PATH]: edit(CI_PATH, RUNS_ON, `${RUNS_ON}    if: false\n`) },
      },
      'producer-step': {
        files: { [CI_PATH]: edit(CI_PATH, 'npm run lint', 'npm run lint -- --quiet') },
      },
      'producer-context': {
        files: { [CI_PATH]: edit(CI_PATH, 'permissions:\n', 'env:\n  CI: "1"\npermissions:\n') },
      },
      rename: { files: { [CI_PATH]: edit(CI_PATH, '  static:\n', '  lint:\n') } },
      'phantom-job': {
        files: {
          [CI_PATH]: `${CI}  shadow:\n    name: static\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n`,
        },
      },
      'matrix-edit': {
        files: { [MATRIX_PATH]: edit(MATRIX_PATH, 'npm run build', 'npm run build -- --fast') },
      },
      'dynamic-name': {
        files: {
          [CI_PATH]: `${CI}  dyn:\n    name: \${{ github.event_name }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n`,
        },
      },
      lint: {
        files: {
          [CI_PATH]: edit(
            CI_PATH,
            '      - run: npm run lint\n',
            '      - uses: actions/checkout@v5\n        with:\n          persist-credentials: true\n      - run: npm run lint\n',
          ),
        },
      },
      unparseable: { files: { [CI_PATH]: edit(CI_PATH, 'jobs:\n', 'x: &anchor 1\njobs:\n') } },
      symlink: { files: {}, symlinks: { '.github/workflows/link.yml': 'ci.yml' } },
      'local-action': {
        files: { 'actions/setup/action.yml': 'runs:\n  using: composite\n  steps: [] # x\n' },
      },
    };
    for (const [why, block] of PRIVILEGE) {
      specs[`priv-${why.replace(/ /g, '-')}`] = {
        files: { [CI_PATH]: edit(CI_PATH, RUNS_ON, `${RUNS_ON}${block}`) },
      };
    }
    c = importCommits(repo, specs);
  }, HOOK_MS);

  test('a new workflow needs a human; a copied producer is a phantom producer', async () => {
    const out = await run(c['new-wf']!, 'diff-check');
    expect(kinds(out)).toEqual(['protected-path', 'required-check', 'workflow-new']);
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: '.github/workflows/new.yml',
      reason: 'adds a producer of required check static (.github/workflows/new.yml:static)',
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a new same-name job in an existing workflow is a phantom producer', async () => {
    const out = await run(c['phantom-job']!, 'diff-check');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: CI_PATH, reason: 'changes a protected path' },
      {
        kind: 'required-check',
        path: CI_PATH,
        reason: `adds a producer of required check static (${CI_PATH}:shadow)`,
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test('a required check with no resolvable producer fails closed when a matrix producer changes', async () => {
    const out = await run(c['matrix-edit']!, 'diff-check');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: MATRIX_PATH, reason: 'changes a protected path' },
      {
        kind: 'required-check',
        path: MATRIX_PATH,
        reason: `producer of required check build unresolvable; ${MATRIX_PATH} changed`,
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test('...or when a changed workflow gains a dynamically named job', async () => {
    const out = await run(c['dynamic-name']!, 'diff-check');
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: CI_PATH,
      reason: `producer of required check build unresolvable; ${CI_PATH} changed`,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a trigger change needs a human (and is not also a producer change)', async () => {
    const out = await run(c['trigger']!, 'diff-check');
    expect(kinds(out)).toEqual(['protected-path', 'trigger-changed']);
    expect(out.verdict).toBe('needs-human');
  });

  test.each(PRIVILEGE)('a job made privileged by %s needs a human', async (why) => {
    const out = await run(c[`priv-${why.replace(/ /g, '-')}`]!, 'diff-check');
    expect(kinds(out)).toContain('privileged-job');
    expect(out.verdict).toBe('needs-human');
  });

  test('an edit to an already-privileged job needs a human', async () => {
    const out = await run(c['priv-edit']!, 'diff-check');
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'privileged-job', path: DEPLOY_PATH }),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('a comment-only edit to the producer workflow passes under diff-check', async () => {
    expect(kinds(await run(c['comment']!))).toEqual(['protected-path']);
    expect(await verdicts(c['comment']!)).toEqual({ human: 'needs-human', 'diff-check': 'pass' });
  });

  test.each([
    ['producer-if', 'job static changed'],
    ['producer-step', 'job static changed'],
    ['producer-context', 'workflow-level context changed'],
  ])('a changed producer (%s) needs a human', async (name, detail) => {
    const out = await run(c[name]!, 'diff-check');
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: CI_PATH,
      reason: `changes the producer of required check static (${detail})`,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('renaming the job that produces a required check needs a human', async () => {
    const out = await run(c['rename']!, 'diff-check');
    expect(out.findings).toEqual(
      expect.arrayContaining([
        { kind: 'required-check', path: CI_PATH, reason: 'removed required check static' },
        {
          kind: 'required-check',
          path: CI_PATH,
          reason: 'changes the producer of required check static (job static removed)',
        },
      ]),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('a lint violation fails, even under `human` (fail beats needs-human)', async () => {
    const out = await run(c['lint']!, 'human');
    expect(kinds(out)).toContain('lint');
    expect(await verdicts(c['lint']!)).toEqual({ human: 'fail', 'diff-check': 'fail' });
    expect(out.report.at(-1)).toBe('verdict: fail');
  });

  test('an unparseable workflow fails closed to needs-human', async () => {
    const out = await run(c['unparseable']!, 'diff-check');
    expect(kinds(out)).toContain('workflow-unparseable');
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: CI_PATH,
      reason: 'changes the producer of required check static (workflow unparseable at the subject)',
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a changed workflow path that is a regular file at neither end fails closed', async () => {
    const out = await run(c['symlink']!, 'diff-check');
    expect(out.findings).toContainEqual({
      kind: 'workflow-unparseable',
      path: '.github/workflows/link.yml',
      reason: 'changed workflow path is not a regular file at either end',
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a changed local action used by a privileged job needs a human', async () => {
    const out = await run(c['local-action']!, 'diff-check');
    expect(out.findings).toEqual([
      {
        kind: 'privileged-job',
        path: 'actions/setup/action.yml',
        reason: `changes actions/setup/action.yml used by privileged job ${DEPLOY_PATH}:deploy`,
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });
});

describe('policyDiff: local actions of required-check producers', SLOW, () => {
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
  beforeAll(() => {
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
  }, HOOK_MS);

  const judge = (name: string, posture: ProtectedPathsPosture = 'diff-check') =>
    run(c[name]!, posture, {
      base: name.startsWith('la-broken')
        ? 'refs/remotes/origin/main'
        : 'refs/remotes/origin/merge-queue',
    });

  test('an edit only to a local action a producer runs needs a human under diff-check', async () => {
    const out = await judge('la-action-edit');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: GATE, reason: 'changes a protected path' },
      changed(GATE, '.github/actions/gate'),
    ]);
    expect(out.verdict).toBe('needs-human');
    expect((await judge('la-action-edit', 'human')).verdict).toBe('needs-human');
  });

  test('a comment-only edit to the action metadata is still a producer change', async () => {
    // Unlike workflow job text, a local action is compared by path, not normalised text.
    const out = await judge('la-comment');
    expect(out.findings).toContainEqual(changed(GATE, '.github/actions/gate'));
    expect(out.verdict).toBe('needs-human');
  });

  test('any file under a nested local action is followed transitively', async () => {
    const out = await judge('la-nested-edit');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: INNER_SCRIPT, reason: 'changes a protected path' },
      changed(INNER_SCRIPT, '.github/actions/inner'),
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test('unchanged local actions add no finding', async () => {
    const out = await judge('la-unrelated');
    expect(out.findings).toEqual([]);
    expect(out.verdict).toBe('pass');
  });

  test('a local action no producer runs is only a protected path', async () => {
    const out = await judge('la-other-action');
    expect(kinds(out)).toEqual(['protected-path']);
    expect(out.verdict).toBe('pass');
  });

  test('nested-use cycles terminate and are judged by path', async () => {
    const out = await judge('la-cycle');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: INNER, reason: 'changes a protected path' },
      changed(INNER, '.github/actions/inner'),
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test.each([
    ['la-metadata-gone', 'no action.yml or action.yaml'],
    ['la-metadata-symlink', 'not a regular file'],
  ])('local action metadata unreadable at the subject (%s) fails closed', async (name, why) => {
    const out = await judge(name);
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: './.github/actions/inner',
      reason: expect.stringMatching(
        new RegExp(
          `^local action of required check static unresolvable at the subject \\(${PRODUCER.replace(/\./g, '\\.')}: .*${why}`,
        ),
      ) as unknown,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a `..` escape in a nested local use fails closed', async () => {
    const out = await judge('la-escape');
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: './.github/../outside',
      reason: expect.stringContaining('unresolvable at the subject') as unknown,
    });
    expect(out.findings.find((f) => f.path === './.github/../outside')?.reason).toContain(
      'dot segment',
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('a nesting chain past the depth bound fails closed', async () => {
    const out = await judge('la-deep');
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        kind: 'required-check',
        reason: expect.stringContaining(`${PRODUCER} nests local actions deeper than 8`) as unknown,
      }),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('a nesting chain whose past-the-bound target was already visited is not flagged', async () => {
    const out = await judge('la-deep-dedup');
    expect(out.findings.filter((f) => f.reason.includes('nests local actions deeper'))).toEqual([]);
    expect(out.findings.filter((f) => f.reason.includes('unresolvable'))).toEqual([]);
  });

  test.each(['la-hidden-cr', 'la-hidden-ls'])(
    'a `uses:` hidden behind a YAML line break other than \\n (%s) fails closed',
    async (name) => {
      const out = await judge(name);
      expect(out.findings).toContainEqual({
        kind: 'required-check',
        path: './.github/actions/gate',
        reason: expect.stringContaining(`${GATE}: unreadable uses line`) as unknown,
      });
      expect(out.verdict).toBe('needs-human');
    },
  );

  test('a root `uses:` continued onto the next line fails closed', async () => {
    const out = await judge('la-root-continued');
    expect(out.findings).toContainEqual(notLiteral('subject'));
    expect(out.verdict).toBe('needs-human');
  });

  test('a nested `uses:` continued onto the next line fails closed', async () => {
    const out = await judge('la-nested-continued');
    // The unresolvable target is the action whose METADATA is ambiguous
    // (gate), as for the hidden-line cases, not the action it names.
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: './.github/actions/gate',
      reason: expect.stringContaining(
        `${GATE}: uses value continues onto the next line`,
      ) as unknown,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('prose with "causes" or "statuses" in metadata is not an unreadable uses line', async () => {
    const out = await judge('la-prose-causes');
    expect(out.findings.filter((f) => f.reason.includes('unreadable uses line'))).toEqual([]);
    expect(out.findings).toContainEqual(changed(GATE, '.github/actions/gate'));
  });

  test('an unreadable `uses:` in unchanged metadata fails closed at both ends', async () => {
    const out = await judge('la-broken-unrelated');
    for (const side of ['range base', 'subject']) {
      expect(out.findings).toContainEqual({
        kind: 'required-check',
        path: './.github/actions/gate',
        reason: expect.stringContaining(
          `unresolvable at the ${side} (${PRODUCER}: ${GATE}: unreadable uses line`,
        ) as unknown,
      });
    }
    expect(out.verdict).toBe('needs-human');
  });

  test('a block-scalar `uses:` in an unchanged producer fails closed at both ends', async () => {
    // workflowScan reads no literal from `uses: >-`, so localUses omits it.
    const out = await judge('la-broken-unrelated');
    expect(out.findings).toContainEqual(notLiteral('range base'));
    expect(out.findings).toContainEqual(notLiteral('subject'));
  });

  test('a block-scalar `uses:` in a producer at the subject fails closed', async () => {
    const out = await judge('la-root-block');
    expect(out.findings).toContainEqual(notLiteral('subject'));
    expect(out.findings).not.toContainEqual(notLiteral('range base'));
    expect(out.verdict).toBe('needs-human');
  });

  test('a sibling sharing the action directory as a name prefix is not under it', async () => {
    const out = await judge('la-sibling');
    expect(out.findings).toEqual([
      {
        kind: 'protected-path',
        path: '.github/actions/gate2/x',
        reason: 'changes a protected path',
      },
    ]);
    expect(out.verdict).toBe('pass');
  });

  test('a nested reference added at the subject is traced there', async () => {
    const out = await judge('la-ref-add');
    expect(out.findings).toContainEqual(changed(GATE, '.github/actions/gate'));
    expect(out.findings).toContainEqual(changed(OTHER, '.github/actions/other'));
    expect(out.verdict).toBe('needs-human');
  });

  test('a nested reference removed at the subject is still traced at the range base', async () => {
    const out = await judge('la-ref-remove');
    expect(out.findings).toContainEqual(changed(GATE, '.github/actions/gate'));
    expect(out.findings).toContainEqual(changed(INNER_SCRIPT, '.github/actions/inner'));
    expect(out.verdict).toBe('needs-human');
  });

  test('a renamed nested action is traced under both names', async () => {
    const out = await judge('la-ref-rename');
    for (const [path, target] of [
      [GATE, '.github/actions/gate'],
      [INNER, '.github/actions/inner'],
      [INNER_SCRIPT, '.github/actions/inner'],
      [MOVED, '.github/actions/moved'],
      [MOVED_SCRIPT, '.github/actions/moved'],
    ] as const) {
      expect(out.findings).toContainEqual(changed(path, target));
    }
    expect(out.findings.filter((f) => f.reason.includes('unresolvable'))).toEqual([]);
    expect(out.verdict).toBe('needs-human');
  });

  test.each(['la-value-single-quoted', 'la-value-double-quoted', 'la-value-comment'])(
    'a nested `uses:` value read through quotes or a trailing comment is traced (%s)',
    async (name) => {
      const out = await judge(name);
      expect(out.findings).toContainEqual(changed(OTHER, '.github/actions/other'));
      expect(out.findings.filter((f) => f.reason.includes('unresolvable'))).toEqual([]);
      expect(out.verdict).toBe('needs-human');
    },
  );

  test.each([
    'la-key-double-quoted',
    'la-key-single-quoted',
    'la-key-uppercase',
    'la-key-escaped',
    'la-key-explicit',
    'la-value-hash',
  ])('a nested `uses` the strict line scan does not read fails closed (%s)', async (name) => {
    const out = await judge(name);
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: './.github/actions/gate',
      reason: expect.stringContaining(
        `unresolvable at the subject (${PRODUCER}: ${GATE}: unreadable uses line`,
      ) as unknown,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a change under an action two required checks run is one finding per check', async () => {
    const out = await run(c['la-action-edit']!, 'diff-check', {
      base: 'refs/remotes/origin/merge-queue',
      trustRef: twinTrust,
    });
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: GATE, reason: 'changes a protected path' },
      changed(GATE, '.github/actions/gate'),
      {
        kind: 'required-check',
        path: GATE,
        reason: `changes ${GATE} in local action ./.github/actions/gate run by ${TWIN_PATH}:twin, a producer of required check twin`,
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });
});

describe('policyDiff: unsafe paths (#224 composition)', SLOW, () => {
  let c: Record<string, string>;
  beforeAll(() => {
    // Both paths are refused by the porcelain (update-index), and newer git's
    // fast-import fsck refuses `.GIT` too, so the trees are written raw.
    c = {
      dotgit: literalCommit(repo, trust, '.GIT', 'x', 'hostile\n'),
      backslash: literalCommit(repo, trust, null, 'a\\b.txt', 'x\n'),
    };
  }, HOOK_MS);

  test('a `.GIT` segment is unsafe-path and never read', async () => {
    const out = await run(c['dotgit']!, 'diff-check');
    expect(out.findings).toEqual([
      {
        kind: 'unsafe-path',
        path: '".GIT/x"',
        reason: "ratchet git: refusing changed path '.GIT/x' (.git segment)",
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test('a backslash path is unsafe-path', async () => {
    const out = await run(c['backslash']!, 'diff-check');
    expect(kinds(out)).toEqual(['unsafe-path']);
    expect(out.verdict).toBe('needs-human');
  });
});

describe('policyDiff: no-shell composition (#221 / W1.7 argv)', SLOW, () => {
  test('configured diff programs and hooks never run; the real change is still judged', async () => {
    // A separate clone, so the hostile config cannot leak into other cases.
    const clone = join(root, 'hostile');
    execFileSync('git', ['clone', '-q', '--no-checkout', repo, clone], { env: GIT_ENV });
    const subject = importCommits(clone, {
      hostile: {
        files: { '.gitattributes': '* diff=evil\n', [COVERAGE_PATH]: baselineText(80) },
      },
    })['hostile']!;
    const marker = join(root, 'MARKER');
    const script = join(root, 'evil.sh');
    // If git ran it, the textconv would also blank the diff and hide the loosening.
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(script, 0o755);
    for (const key of ['diff.external', 'diff.evil.textconv', 'core.fsmonitor', 'core.pager']) {
      gitIn(clone, ['config', key, script]);
    }
    const result = await createPolicyDiff({ posture: 'diff-check', layer: 'env' })({
      repo: clone,
      trustRef: trust,
      subject,
      subjectKind: 'pr',
      base: 'refs/remotes/origin/main',
    });
    expect(existsSync(marker)).toBe(false);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    expect(result.value.findings).toContainEqual(
      expect.objectContaining({ kind: 'baseline-loosened' }),
    );
    expect(result.value.findings).toContainEqual(
      expect.objectContaining({ kind: 'definition-changed', path: '.gitattributes' }),
    );
    expect(result.value.verdict).toBe('needs-human');
  });
});

describe('policyDiff: the override record', SLOW, () => {
  const PR = 7;
  const OWNER_ID = 1001;
  const EPOCH = '2026-09-20T10:00:00.000Z';
  let subject: string;

  const labelEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    event: 'labeled',
    label: { name: 'cq-override' },
    actor: { login: 'owner', id: OWNER_ID, type: 'User' },
    created_at: '2026-09-20T11:00:00Z',
    performed_via_github_app: null,
    ...over,
  });

  const events = (name: string, body: unknown): string => {
    const path = join(eventsDir, name);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  };

  const withRecord = (
    labelEventsPath: string,
    trustRef = attestedTrust,
  ): Partial<PolicyDiffInput> => ({
    trustRef,
    pr: PR,
    repository: 'o/r',
    ownerId: OWNER_ID,
    labelEventsPath,
    settleRef: 'cq-state',
  });

  beforeAll(() => {
    subject = importCommits(repo, { override: { files: { 'lint/x.txt': 'rule3\n' } } })[
      'override'
    ]!;
    const ledger = {
      version: 1,
      repo: 'o/r',
      prs: {
        [String(PR)]: {
          tuple: { head: subject, base: trust, forcePushEpoch: 0 },
          observations: [{ observedAt: EPOCH, by: 'test' }],
        },
      },
    };
    importCommits(repo, {
      'cq-state': { files: { '.cq/settle-state.json': JSON.stringify(ledger) } },
    });
  }, HOOK_MS);

  test('attested trust + a valid owner label after the epoch is honoured: pass', async () => {
    const out = await run(subject, 'human', withRecord(events('valid.json', [labelEvent()])));
    expect(out.override.status).toBe('honoured');
    expect(out.verdict).toBe('pass');
    expect(out.report.at(-1)).toBe(
      'verdict: pass (needs-human authorized by the D11 override record)',
    );
  });

  test('a placeholder attestation file does not arm records (F5): dormant, noted', async () => {
    const out = await run(
      subject,
      'human',
      withRecord(events('valid.json', [labelEvent()]), placeholderTrust),
    );
    expect(out.override.status).toBe('dormant');
    expect(out.verdict).toBe('needs-human');
    expect(
      out.report.some((line) =>
        line.startsWith('attestation: policy/attestations/c3.json present but invalid ('),
      ),
    ).toBe(true);
  });

  test('without the attestation the record is dormant and logged: needs-human', async () => {
    const out = await run(
      subject,
      'human',
      withRecord(events('valid.json', [labelEvent()]), trust),
    );
    expect(out.override.status).toBe('dormant');
    expect(out.verdict).toBe('needs-human');
    expect(out.report).toContain('  verdict: dormant');
    expect(out.report.some((l) => l.startsWith('  dormant: ADR-0004 D-G.4'))).toBe(true);
  });

  test('a label applied through a GitHub App is invalid and logged', async () => {
    const path = events('bot.json', [labelEvent({ performed_via_github_app: { slug: 'bot' } })]);
    const out = await run(subject, 'human', withRecord(path));
    expect(out.override.status).toBe('invalid');
    expect(out.verdict).toBe('needs-human');
    expect(out.report).toContain(
      "  reason: label applied via GitHub App 'bot', not directly by the owner",
    );
  });

  test('a label before the head observation epoch, or with no ledger, is invalid', async () => {
    const early = events('early.json', [labelEvent({ created_at: '2026-09-20T09:00:00Z' })]);
    expect((await run(subject, 'human', withRecord(early))).override.status).toBe('invalid');
    const noLedger = withRecord(events('valid.json', [labelEvent()]));
    delete noLedger.settleRef;
    const out = await run(subject, 'human', noLedger);
    expect(out.override.status).toBe('invalid');
    expect(out.report).toContain('settle ledger: no settle ref (cq-state absent)');
  });

  test('an unreadable events file is an invalid record, never `failed`', async () => {
    const link = join(eventsDir, 'link.json');
    symlinkSync(events('target.json', [labelEvent()]), link);
    const cases: string[] = [
      link,
      events('not-array.json', { event: 'labeled' }),
      events('not-json.json', '{'),
      events('huge.json', ' '.repeat(LABEL_EVENTS_MAX_BYTES + 1)),
      join(eventsDir, 'missing.json'),
    ];
    for (const path of cases) {
      const out = await run(subject, 'human', withRecord(path));
      expect(out.override.status).toBe('invalid');
      expect(out.override.reasons[0]).toMatch(/^label events unreadable: /);
      expect(out.verdict).toBe('needs-human');
    }
  });

  test('a push subject is never evaluated for an override', async () => {
    const out = await run(subject, 'human', {
      ...withRecord(events('valid.json', [labelEvent()])),
      subjectKind: 'push',
      base: 'main',
    });
    expect(out.override).toEqual({
      status: 'absent',
      reasons: ['not evaluated: a push subject carries no PR label record'],
    });
    expect(out.verdict).toBe('needs-human');
    expect(out.report).toContain('  not evaluated: a push subject carries no PR label record');
  });
});

describe('policyDiff: faults are failed, never a pass', SLOW, () => {
  let c: Record<string, string>;
  beforeAll(() => {
    c = importCommits(repo, {
      'bad-trust-policy': {
        files: { [POLICY_LIST_PATH]: JSON.stringify({ ...POLICY, protectedPaths: ['^('] }) },
      },
      'unanchored-trust-policy': {
        files: { [POLICY_LIST_PATH]: JSON.stringify({ ...POLICY, protectedPaths: ['src/'] }) },
      },
      'no-policy-list': { files: { [POLICY_LIST_PATH]: null } },
      'no-manifest': { files: { [MANIFEST_PATH]: null } },
    });
  }, HOOK_MS);

  const call = (over: Partial<PolicyDiffInput>) =>
    createPolicyDiff({ posture: 'human', layer: 'default' })({
      repo,
      trustRef: trust,
      subject: trust,
      subjectKind: 'pr',
      base: 'merge-queue',
      ...over,
    });

  test('an invalid base, or a push over a PR base, is failed', async () => {
    expect(await call({ base: 'feature' })).toMatchObject({ status: 'failed' });
    expect(await call({ subjectKind: 'push', base: 'merge-queue' })).toMatchObject({
      status: 'failed',
      error: "policy diff: push subject has invalid base 'merge-queue'",
    });
  });

  test('an unresolvable or option-shaped subject is failed', async () => {
    expect(await call({ subject: 'no-such-ref' })).toMatchObject({ status: 'failed' });
    expect(await call({ subject: '--output=/tmp/x' })).toMatchObject({ status: 'failed' });
  });

  test('an invalid policy list at the trust ref is failed (the check cannot judge)', async () => {
    const result = await call({ trustRef: c['bad-trust-policy']! });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.error).toMatch(/protectedPaths entry must compile/);
  });

  test('an unanchored policy-list entry at the trust ref is failed', async () => {
    const result = await call({ trustRef: c['unanchored-trust-policy']! });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.error).toMatch(
      /protectedPaths entry must be anchored/,
    );
  });

  test('a trust ref without the policy list judges, and says the project lists are inactive', async () => {
    const at = c['no-policy-list']!;
    const result = await call({ trustRef: at, subject: at });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.value.report).toContain(
      `policy list: ${POLICY_LIST_PATH} absent at the trust ref — project protectedPaths and requiredChecks are inactive`,
    );
  });

  test('a trust ref without the manifest is failed', async () => {
    expect(await call({ trustRef: c['no-manifest']! })).toMatchObject({ status: 'failed' });
  });
});

describe('gates.policyDiff registry entry: the posture comes from config only', SLOW, () => {
  const entry = registry.find((e) => e.name === 'gates.policyDiff');
  const input = (): Record<string, unknown> => ({
    repo,
    trustRef: trust,
    subject: trust,
    subjectKind: 'pr',
    base: 'merge-queue',
  });

  test('the input schema is strict and has no posture field', () => {
    expect(entry).toBeDefined();
    expect(entry!.inputSchema.safeParse(input()).success).toBe(true);
    expect(entry!.inputSchema.safeParse({ ...input(), posture: 'diff-check' }).success).toBe(false);
    expect(entry!.inputSchema.safeParse({ ...input(), protectedPaths: 'diff-check' }).success).toBe(
      false,
    );
    expect(entry!.inputSchema.safeParse({ ...input(), pr: 0 }).success).toBe(false);
  });

  async function dispatch(env: string | undefined, subject: string) {
    const saved = process.env['CQ_MERGE_PROTECTED_PATHS'];
    if (env === undefined) delete process.env['CQ_MERGE_PROTECTED_PATHS'];
    else process.env['CQ_MERGE_PROTECTED_PATHS'] = env;
    try {
      const op = await entry!.importer();
      return await op(entry!.inputSchema.parse({ ...input(), subject }));
    } finally {
      if (saved === undefined) delete process.env['CQ_MERGE_PROTECTED_PATHS'];
      else process.env['CQ_MERGE_PROTECTED_PATHS'] = saved;
    }
  }

  test('the resolved env posture decides, and is reported with its layer', async () => {
    const subject = importCommits(repo, {
      'registry-lint': { files: { 'lint/x.txt': 'rule4\n' } },
    })['registry-lint']!;
    const diffCheck = await dispatch('diff-check', subject);
    expect(diffCheck).toMatchObject({
      status: 'ok',
      value: { verdict: 'pass', posture: 'diff-check', postureLayer: 'env' },
    });
    const unset = await dispatch(undefined, subject);
    expect(unset).toMatchObject({
      status: 'ok',
      value: { verdict: 'needs-human', posture: 'human', postureLayer: 'default' },
    });
  });

  test('a bogus env posture fails the dispatch', async () => {
    expect(await dispatch('bogus', trust)).toEqual({
      status: 'failed',
      error: "policy: CQ_MERGE_PROTECTED_PATHS must be 'human' or 'diff-check', got 'bogus'",
    });
  });
});

describe("the toolkit's own policy list", () => {
  const REPO_ROOT = join(__dirname, '..', '..', '..');
  const list = JSON.parse(readFileSync(join(REPO_ROOT, POLICY_LIST_PATH), 'utf8')) as {
    schemaVersion: number;
    protectedPaths: string[];
    requiredChecks: string[];
  };

  test('requiredChecks equals the merge-queue gate wait list', () => {
    const gate = readFileSync(join(REPO_ROOT, '.github/workflows/merge-queue-gate.yml'), 'utf8');
    const waitList = /checks="\$\(echo '([^']*)'/.exec(gate)?.[1];
    expect(waitList).toBeDefined();
    expect(list.requiredChecks).toEqual(waitList!.split(','));
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
        source,
      ).toBe(true);
    }
  });
});
