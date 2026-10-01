// §7 A14 — a PR that edits the privileged gate/promotion workflow, the
// ratchet workflow, or the merge classifier.
//
// The prior A14 row was a path-regex membership check, which proves only
// that a regex matches a string. This file judges the ATTACK over real git
// objects: a scratch repository whose trust ref carries real token-bearing
// workflows, hostile PR commits written with real `git fast-import`, and the
// real D11 check (src/ops/gates/policyDiff.ts) run over `merge-base..head`
// — offline, no network, no scratch-repository mutation.
//
// What is pinned:
//   1. A PR-edited promotion workflow whose new step reads
//      `secrets.PROMOTE_TOKEN` is needs-human under BOTH protected-path
//      postures, on the PR side and on the promotion side: the
//      privileged-workflow findings are never posture-relaxed, so no posture
//      widens the door for an edited privileged definition. And the same edit
//      that also wires `pull_request_target` into that workflow is a `lint`
//      finding — `fail`, which beats needs-human, in both postures.
//   2. A benign edit to an already-privileged token-bearing workflow, and an
//      edit to the privileged ratchet workflow, are needs-human in both.
//   3. A classifier-only edit is pinned in BOTH postures on BOTH sides: under
//      the conservative `human` posture it is needs-human for the PR subject
//      and for the promotion-side push recompute over `main..tip`, and that
//      push subject's override record is `absent` (a push subject is never
//      evaluated for a D11 label) — so it promotes on nothing. Under the
//      owner-selected `diff-check` relaxation a plain protected-path edit
//      passes, which is that posture's documented meaning and is pinned here
//      rather than left implicit. What no posture relaxes is (1) and (2): an
//      edited privileged workflow never promotes, under either posture.
//   4. Positive control: the same hostile head, judged as a PR subject
//      against a C3-attested trust ref with a valid owner label after the
//      head's observation epoch, is `honoured` and passes. The refusals in
//      (1)–(3) are the guard, not a check that fails everything.
//   5. Static token isolation over the toolkit's REAL workflows (templates
//      and instantiations): no job that reads a repository secret, and in
//      particular no job that reads a promotion or automation credential, is
//      reachable from an untrusted trigger — so an edited copy of a
//      token-bearing workflow cannot be made to execute with the promote
//      token by trigger injection.
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { baselineRelPath, renderBaseline } from '../../src/ops/ratchet/format.js';
import { createPolicyDiff, POLICY_LIST_PATH } from '../../src/ops/gates/policyDiff.js';
import type { PolicyDiffInput, PolicyDiffOutcome } from '../../src/ops/gates/policyDiff.js';
import { isWorkflowPath, scanWorkflow } from '../../src/ops/gates/workflowScan.js';
import type { ProtectedPathsPosture } from '../../src/ops/gates/policyConfig.js';
import { resolve } from 'node:path';

const SLOW = { timeout: 60_000 };
const HOOK_MS = 60_000;
const ROOT = resolve(import.meta.dirname, '../..');

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function gitIn(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    ...(input === undefined ? {} : { input }),
  }).trim();
}

const wf = (...lines: string[]): string => `${lines.join('\n')}\n`;

const CI_PATH = '.github/workflows/ci.yml';
const GATE_PATH = '.github/workflows/gate.yml';
const RATCHET_PATH = '.github/workflows/ratchet.yml';
const CLASSIFIER_PATH = 'src/ops/merge/classifyPrs.ts';
const MANIFEST_PATH = 'baselines/ratchets.json';
const COVERAGE_PATH = baselineRelPath('coverage', 'coverage');

/** Non-privileged; its `static` job is the producer of the required check. */
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
  '      - run: npm run lint',
);

/** The promotion gate, shaped like policy/templates/gate.yml: it holds PROMOTE_TOKEN. */
const GATE = wf(
  'name: gate',
  'on:',
  '  workflow_run:',
  '    workflows: [ci]',
  '    types: [completed]',
  '  workflow_dispatch:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  decide:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: write',
  '    env:',
  '      CQ_PROMOTE_TOKEN: ${{ secrets.PROMOTE_TOKEN }}',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '        with:',
  '          ref: ${{ github.sha }}',
  '      - run: echo gate',
);

/** The ratchet family: privileged, and it gates the queue. */
const RATCHET = wf(
  'name: ratchet',
  'on:',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  verify:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: write',
  '    steps:',
  '      - run: echo ratchet',
);

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
    '(?:^|/)package\\.json$',
    '(?:^|/)tsconfig[^/]*\\.json$',
    '^baselines/',
    '^\\.github/workflows/',
    '^policy/protected-paths\\.json$',
  ],
};

const POLICY = {
  schemaVersion: 1,
  protectedPaths: ['^src/ops/merge/classifyPrs\\.ts$'],
  requiredChecks: ['static'],
};

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

const TRUST_FILES: Readonly<Record<string, string>> = {
  [MANIFEST_PATH]: `${JSON.stringify(MANIFEST, null, 2)}\n`,
  [COVERAGE_PATH]: baselineText(90),
  [POLICY_LIST_PATH]: `${JSON.stringify(POLICY, null, 2)}\n`,
  'tsconfig.json': '{ "include": ["src"] }\n',
  'package.json': '{ "name": "fixture" }\n',
  [CI_PATH]: CI,
  [GATE_PATH]: GATE,
  [RATCHET_PATH]: RATCHET,
  [CLASSIFIER_PATH]: 'export const classify = () => "awaiting";\n',
};

/** A commit of file writes (`null` deletes) on top of the trust commit. */
interface Spec {
  files: Readonly<Record<string, string | null>>;
  from?: string;
}

let root: string;
let repo: string;
let eventsDir: string;
let trust: string;
let attestedTrust: string;
let savedPath: string | undefined;

/** Write every spec as one commit per branch with ONE `git fast-import`. */
function importCommits(
  specs: Readonly<Record<string, Spec>>,
  parent: string | null,
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
    const base = spec.from ?? parent;
    if (base !== null) text(`from ${base}\n`);
    for (const [path, content] of Object.entries(spec.files)) {
      if (content === null) text(`D ${path}\n`);
      else {
        text(`M 100644 inline ${path}\n`);
        data(content);
      }
    }
    text('\n');
  });
  const marks = join(root, `marks-${String(names[0] ?? 'none')}`);
  execFileSync('git', ['fast-import', '--quiet', `--export-marks=${marks}`], {
    cwd: repo,
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

/** Node's spawn walks PATH; the op spawns `git` by name, so O(1) the lookup. */
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

async function judge(input: PolicyDiffInput, posture: ProtectedPathsPosture) {
  const result = await createPolicyDiff({ posture, layer: 'env' })(input);
  if (result.status !== 'ok') throw new Error(`policy ${result.status}: ${JSON.stringify(result)}`);
  return result.value as PolicyDiffOutcome;
}

const kinds = (out: PolicyDiffOutcome): string[] =>
  [...new Set(out.findings.map((f) => f.kind))].sort();

async function bothPostures(
  input: PolicyDiffInput,
): Promise<Record<ProtectedPathsPosture, string>> {
  const human = await judge(input, 'human');
  const diffCheck = await judge(input, 'diff-check');
  return { human: human.verdict, 'diff-check': diffCheck.verdict };
}

const prSubject = (subject: string, over: Partial<PolicyDiffInput> = {}): PolicyDiffInput => ({
  repo,
  trustRef: trust,
  subject,
  subjectKind: 'pr',
  base: 'merge-queue',
  ...over,
});

/** What the promotion gate runs: the same range as a PUSH subject (main..tip). */
const pushSubject = (subject: string, over: Partial<PolicyDiffInput> = {}): PolicyDiffInput => ({
  repo,
  trustRef: trust,
  subject,
  subjectKind: 'push',
  base: 'refs/remotes/origin/main',
  ...over,
});

/** The hostile head SHAs, keyed by fixture branch. */
let heads: Record<string, string>;

/** A PR-edited gate that reads PROMOTE_TOKEN in a NEW step of its token job. */
function hostileGate(): string {
  return GATE.replace(
    '      - run: echo gate\n',
    '      - name: exfiltrate\n        env:\n          T: ${{ secrets.PROMOTE_TOKEN }}\n        run: echo "$T" > leak.txt\n      - run: echo gate\n',
  );
}

/** The same edit plus an untrusted trigger, so the edited copy would execute on a PR. */
function triggerInjectedGate(): string {
  return hostileGate().replace(
    '  workflow_dispatch:\n',
    '  workflow_dispatch:\n  pull_request_target:\n    types: [opened, synchronize]\n',
  );
}

const PR = 7;
const OWNER_ID = 1001;
const EPOCH = '2026-09-20T10:00:00.000Z';
const C3 = `${JSON.stringify({
  schemaVersion: 1,
  attests: 'C3',
  attestedAt: '2026-09-26T00:00:00Z',
})}\n`;

const events = (name: string, body: unknown): string => {
  const path = join(eventsDir, name);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
};

const labelEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: 'labeled',
  label: { name: 'cq-override' },
  actor: { login: 'owner', id: OWNER_ID, type: 'User' },
  created_at: '2026-09-20T11:00:00Z',
  performed_via_github_app: null,
  ...over,
});

/** The settle-ledger entry the override evaluation compares the label against. */
function ledgerFor(head: string): string {
  return JSON.stringify({
    version: 1,
    repo: 'o/r',
    prs: {
      [String(PR)]: {
        tuple: { head, base: trust, forcePushEpoch: 0 },
        observations: [{ observedAt: EPOCH, by: 'test' }],
      },
    },
  });
}

beforeAll(() => {
  savedPath = process.env['PATH'];
  const dir = gitDir();
  if (dir !== undefined) process.env['PATH'] = `${dir}${delimiter}${savedPath ?? ''}`;
  GIT_ENV['PATH'] = process.env['PATH'];
  root = mkdtempSync(join(tmpdir(), 'cq-a14-privileged-'));
  repo = join(root, 'repo');
  eventsDir = join(root, 'events');
  mkdirSync(eventsDir);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: GIT_ENV });

  // The trust ref: real token-bearing workflows, a real policy list, a real
  // ratchet manifest. `merge-queue` and `origin/main` both point at it.
  trust = importCommits({ main: { files: TRUST_FILES } }, null)['main']!;
  gitIn(repo, ['update-ref', 'refs/heads/merge-queue', trust]);
  gitIn(repo, ['update-ref', 'refs/remotes/origin/main', trust]);
  attestedTrust = importCommits(
    { attested: { files: { 'policy/attestations/c3.json': C3 } } },
    trust,
  )['attested']!;

  // The hostile PRs, each one real commit on the trust ref.
  heads = importCommits(
    {
      'exfil-gate': { files: { [GATE_PATH]: hostileGate() } },
      'prt-gate': { files: { [GATE_PATH]: triggerInjectedGate() } },
      'gate-edit': {
        files: {
          [GATE_PATH]: GATE.replace('      - run: echo gate\n', '      - run: echo gate v2\n'),
        },
      },
      'ratchet-edit': {
        files: {
          [RATCHET_PATH]: RATCHET.replace(
            '      - run: echo ratchet\n',
            '      - run: echo ratchet v2\n',
          ),
        },
      },
      classifier: {
        files: { [CLASSIFIER_PATH]: 'export const classify = () => "eligible";\n' },
      },
    },
    trust,
  );
  importCommits(
    { 'cq-state': { files: { '.cq/settle-state.json': ledgerFor(heads['exfil-gate']!) } } },
    trust,
  );
}, HOOK_MS);

afterAll(() => {
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('§7 A14 a PR-edited privileged workflow', SLOW, () => {
  test('a gate whose new step reads PROMOTE_TOKEN is needs-human in both postures', async () => {
    const subject = heads['exfil-gate']!;
    const out = await judge(prSubject(subject), 'human');
    expect(kinds(out)).toContain('privileged-job');
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'privileged-job', path: GATE_PATH }),
    );
    // The edited copy is judged as the privileged definition it still is: no
    // posture widens the door for it.
    expect(await bothPostures(prSubject(subject))).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
    // The promotion-side recompute judges the same hostile copy, and refuses.
    const promoted = await judge(pushSubject(subject), 'diff-check');
    expect(kinds(promoted)).toContain('privileged-job');
    expect(promoted.verdict).toBe('needs-human');
  });

  test('wiring an untrusted trigger into the token-bearing gate fails closed, in both postures', async () => {
    const subject = heads['prt-gate']!;
    const out = await judge(prSubject(subject), 'diff-check');
    expect(kinds(out)).toContain('lint');
    expect(kinds(out)).toContain('privileged-job');
    expect(kinds(out)).toContain('trigger-changed');
    expect(
      out.findings.some(
        (f) => f.kind === 'lint' && /^pull_request_target job decide has secret /.test(f.reason),
      ),
      JSON.stringify(out.findings),
    ).toBe(true);
    // `fail` beats needs-human in both postures: the edited copy never
    // reaches a state where promotion is merely "needs a human".
    expect(await bothPostures(prSubject(subject))).toEqual({
      human: 'fail',
      'diff-check': 'fail',
    });
    expect((await judge(pushSubject(subject), 'diff-check')).verdict).toBe('fail');
  });

  test('a benign edit to a token-bearing workflow is still needs-human in both postures', async () => {
    const subject = heads['gate-edit']!;
    expect(kinds(await judge(prSubject(subject), 'diff-check'))).toContain('privileged-job');
    expect(await bothPostures(prSubject(subject))).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
  });

  test('an edit to the privileged ratchet workflow is needs-human in both postures', async () => {
    const subject = heads['ratchet-edit']!;
    expect(kinds(await judge(prSubject(subject), 'diff-check'))).toContain('privileged-job');
    expect(await bothPostures(prSubject(subject))).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
  });
});

describe('§7 A14 promotion needs the D11 authorization (both postures, both sides)', SLOW, () => {
  test('a classifier edit: needs a human under `human` in BOTH checks, and the promotion side never evaluates a D11 record', async () => {
    const subject = heads['classifier']!;
    // The documented relaxation of the `diff-check` posture: a plain
    // protected-path edit passes. It is the relaxation the owner selects
    // explicitly (`CQ_MERGE_PROTECTED_PATHS` / the per-call opt-in), so both
    // sides and both postures are pinned here rather than one.
    const relaxed = await judge(prSubject(subject), 'diff-check');
    expect(kinds(relaxed)).toEqual(['protected-path']);
    expect(relaxed.verdict).toBe('pass');
    expect(relaxed.posture).toBe('diff-check');
    expect((await judge(prSubject(subject), 'human')).verdict).toBe('needs-human');

    // The promotion gate recomputes the SAME range as a push subject, and a
    // push subject is never evaluated for a D11 label — so under the
    // conservative posture the promoted range needs a human whatever the PR
    // side decided, and no label record is read to wave it through.
    const promoted = await judge(pushSubject(subject), 'human');
    expect(promoted.verdict).toBe('needs-human');
    expect(kinds(promoted)).toEqual(['protected-path']);
    expect(promoted.override).toEqual({
      status: 'absent',
      reasons: ['not evaluated: a push subject carries no PR label record'],
    });
    expect(promoted.report).toContain('  not evaluated: a push subject carries no PR label record');
  });

  test('positive control: an explicit D11 record promotes the same hostile head', async () => {
    const subject = heads['exfil-gate']!;
    const out = await judge(
      prSubject(subject, {
        trustRef: attestedTrust,
        pr: PR,
        repository: 'o/r',
        ownerId: OWNER_ID,
        labelEventsPath: events('valid.json', [labelEvent()]),
        settleRef: 'cq-state',
      }),
      'human',
    );
    expect(out.override.status).toBe('honoured');
    expect(out.verdict).toBe('pass');
    expect(out.report.at(-1)).toBe(
      'verdict: pass (needs-human authorized by the D11 override record)',
    );
  });

  test('without the attestation the same record is dormant, and the head still needs a human', async () => {
    const subject = heads['exfil-gate']!;
    const out = await judge(
      prSubject(subject, {
        pr: PR,
        repository: 'o/r',
        ownerId: OWNER_ID,
        labelEventsPath: events('dormant.json', [labelEvent()]),
        settleRef: 'cq-state',
      }),
      'human',
    );
    expect(out.override.status).toBe('dormant');
    expect(out.verdict).toBe('needs-human');
  });
});

describe('§7 A14 static token isolation over the toolkit’s real workflows', () => {
  /** Triggers GitHub runs against untrusted, author-controlled code. */
  const UNTRUSTED_TRIGGERS = [
    'pull_request',
    'pull_request_target',
    'pull_request_review',
    'pull_request_review_comment',
    'issue_comment',
    'issues',
    'fork',
  ];

  const files = [
    ...readdirSync(join(ROOT, '.github/workflows')).map((name) => `.github/workflows/${name}`),
    ...readdirSync(join(ROOT, 'policy/templates')).map((name) => `policy/templates/${name}`),
  ].filter((path) => isWorkflowPath(path.replace('policy/templates/', '.github/workflows/')));

  test('every generated workflow is scanned, with the trigger and job facts this row needs', () => {
    const generated = files.filter((path) => path.startsWith('.github/workflows/'));
    expect(generated.length).toBeGreaterThan(5);
    expect(files.length).toBeGreaterThan(generated.length);
    for (const path of generated) {
      const scan = scanWorkflow(readFileSync(join(ROOT, path), 'utf8'));
      expect(scan.ok, path).toBe(true);
      if (!scan.ok) continue;
      expect(Array.isArray(scan.triggers), path).toBe(true);
      expect(scan.jobs.size, path).toBeGreaterThan(0);
    }
  });

  test('no job that reads a repository secret is reachable from an untrusted trigger', () => {
    const carriers: string[] = [];
    for (const path of files) {
      const scan = scanWorkflow(readFileSync(join(ROOT, path), 'utf8'));
      if (!scan.ok) continue;
      const untrusted = scan.triggers.filter((t) => UNTRUSTED_TRIGGERS.includes(t));
      if (untrusted.length === 0) continue;
      for (const [id, job] of scan.jobs) {
        // `text` is normalised node text: comment lines (which name the
        // credentials they must not leak) are already dropped.
        if (/\bsecrets\.[A-Za-z_]/.test(job.text)) {
          carriers.push(`${path}:${id} (${untrusted.join(', ')})`);
        }
      }
    }
    expect(carriers).toEqual([]);
  });

  test('no promotion credential is reachable from an untrusted trigger', () => {
    /** The credentials that can promote, push as automation, or read settings. */
    const PROMOTION_CREDENTIALS =
      /\bsecrets\.(PROMOTE_TOKEN|GH_TOKEN|CQ_AUTOMATION_TOKEN|CQ_DRILL_MERGE_TOKEN|CQ_SETTINGS_TOKEN|CQ_AUTOMATION_SECOND_TOKEN)\b/;
    const carriers: string[] = [];
    const exposed: string[] = [];
    for (const path of files) {
      const scan = scanWorkflow(readFileSync(join(ROOT, path), 'utf8'));
      if (!scan.ok) continue;
      const untrusted = scan.triggers.filter((t) => UNTRUSTED_TRIGGERS.includes(t));
      for (const [id, job] of scan.jobs) {
        if (!PROMOTION_CREDENTIALS.test(job.text)) continue;
        carriers.push(`${path}:${id}`);
        if (untrusted.length > 0) exposed.push(`${path}:${id} (${untrusted.join(', ')})`);
      }
    }
    expect(exposed).toEqual([]);
    // Non-vacuous: the promotion and automation workflows really are scanned,
    // and really do carry a promotion credential.
    expect(carriers).toContain('.github/workflows/gate.yml:decide');
    expect(carriers).toContain('policy/templates/gate.yml:decide');
    expect(carriers.length).toBeGreaterThan(4);
  });
});
