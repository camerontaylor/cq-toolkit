// W1.9 (D11) — the conservative workflow scanner. These tests pin the
// fail-closed direction: every construct outside the recognised subset is
// `ok: false` (needs-human at the caller), every privilege signal fires on
// its own, and change detection ignores only comments and blank lines. The
// repo's own workflows must all scan, so the scanner never makes a routine
// workflow edit unreviewable by accident.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  diffWorkflow,
  isWorkflowPath,
  lintWorkflow,
  producersOf,
  scanWorkflow,
  type WorkflowFinding,
  type WorkflowScan,
} from '../../../src/ops/gates/workflowScan.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const PATH = '.github/workflows/x.yml';

/** Build a workflow from lines (keeps fixtures readable and indentation exact). */
const wf = (...lines: string[]): string => `${lines.join('\n')}\n`;

function ok(text: string): WorkflowScan & { ok: true } {
  const scan = scanWorkflow(text);
  if (!scan.ok) throw new Error(`expected ok scan, got: ${scan.reason}`);
  return scan;
}

const job = (text: string, id: string) => {
  const found = ok(text).jobs.get(id);
  if (!found) throw new Error(`no job ${id}`);
  return found;
};

const kinds = (findings: readonly WorkflowFinding[]): string[] => findings.map((f) => f.kind);

/** A read-only single-job workflow, the baseline most cases perturb. */
const READ_ONLY = wf(
  'name: ci',
  'on:',
  '  push:',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '        with:',
  '          persist-credentials: false',
  '      - run: npm test',
);

describe('isWorkflowPath', () => {
  test.each([
    ['.github/workflows/ci.yml', true],
    ['.github/workflows/ci.yaml', true],
    ['.github/workflows/sub/ci.yml', false],
    ['.github/workflows/ci.json', false],
    ['.github/ci.yml', false],
    ['x/.github/workflows/ci.yml', false],
  ])('%s -> %s', (path, expected) => {
    expect(isWorkflowPath(path)).toBe(expected);
  });
});

describe('scanWorkflow: recognised subset', () => {
  test('reads triggers, jobs, name and context', () => {
    const scan = ok(READ_ONLY);
    expect(scan.triggers).toEqual(['push', 'pull_request']);
    expect(scan.on).toBe('on:\n  push:\n  pull_request:');
    expect(scan.context).toBe('permissions:\n  contents: read');
    expect([...scan.jobs.keys()]).toEqual(['build']);
    const build = scan.jobs.get('build')!;
    expect(build.privileged).toBe(false);
    expect(build.hasRunSteps).toBe(true);
    expect(build.name).toBeUndefined();
    expect(build.dynamicName).toBe(false);
  });

  test.each([
    ['on: push', ['push']],
    ['on: [push, "pull_request"]', ['push', 'pull_request']],
    ["'on': push", ['push']],
    ['"on": push', ['push']],
    ['true: push', ['push']],
    ['on: push # comment', ['push']],
  ])('trigger spelling %s', (onLine, triggers) => {
    expect(
      ok(wf(onLine, 'permissions: read-all', 'jobs:', '  a:', '    runs-on: x')).triggers,
    ).toEqual(triggers);
  });

  test('on as a block sequence and a leading document marker', () => {
    const scan = ok(
      wf(
        '# c',
        '---',
        'on:',
        '  - push',
        "  - 'workflow_dispatch'",
        'jobs:',
        '  a:',
        '    runs-on: x',
      ),
    );
    expect(scan.triggers).toEqual(['push', 'workflow_dispatch']);
  });

  test('block scalars are opaque: key-like lines inside them are not keys', () => {
    const scan = ok(
      wf(
        'on: push',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - run: |',
        '          environment: prod',
        '          permissions: write-all',
        '          ---',
        '          uses: ./evil',
        '',
        '          echo done',
        '      - name: folded',
        '        run: >-',
        '          echo',
        '          b: c',
        '  b:',
        '    runs-on: x',
      ),
    );
    expect([...scan.jobs.keys()]).toEqual(['a', 'b']);
    const a = scan.jobs.get('a')!;
    expect(a.privileged).toBe(false);
    expect(a.localUses).toEqual([]);
    expect(a.text).toContain('          environment: prod');
  });

  test('a secret named inside a run: block makes the job privileged (it is the job text)', () => {
    const a = job(
      wf(
        'on: push',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - run: |',
        '          token: ${{ secrets.DEPLOY_KEY }}',
      ),
      'a',
    );
    expect(a.privileged).toBe(true);
    expect(a.privilegeReasons).toEqual(['secret DEPLOY_KEY']);
  });

  test('multi-line plain scalars (e.g. if: ... && ...) are continuation text', () => {
    const a = job(
      wf(
        'on: push',
        'permissions: {}',
        'jobs:',
        '  a:',
        "    if: github.event_name == 'push'",
        "      && github.ref == 'refs/heads/main'",
        '    runs-on: x',
      ),
      'a',
    );
    expect(a.privileged).toBe(false);
  });

  test('CRLF and a BOM are tolerated', () => {
    expect(ok(`﻿${READ_ONLY.replaceAll('\n', '\r\n')}`).triggers).toEqual(['push', 'pull_request']);
  });
});

/** Why each out-of-subset fixture is rejected (pins the rule that fired, not just `ok: false`). */
const REJECT_REASONS = new Map<string, string>([
  ['tab in indentation', 'tab in indentation is outside the subset'],
  ['tab inside a block scalar', 'tab in indentation is outside the subset'],
  ['second document marker', 'multi-document file is outside the subset'],
  ['document marker after content', 'multi-document file is outside the subset'],
  ['document end marker', 'document end marker is outside the subset'],
  ['YAML directive', 'YAML directive is outside the subset'],
  ['anchor value', 'anchor is outside the subset'],
  ['alias value', 'alias is outside the subset'],
  ['alias sequence item', 'alias is outside the subset'],
  ['anchored sequence item', 'anchor is outside the subset'],
  ['merge key', 'merge key is outside the subset'],
  ['nested merge key', 'merge key is outside the subset'],
  ['tag', 'tag is outside the subset'],
  ['complex key', 'complex key is outside the subset'],
  ['duplicate top-level key', 'duplicate top-level key "name"'],
  ['on spelled twice', 'duplicate top-level key "on"'],
  ['quoted "true" key', 'ambiguous top-level key "true"'],
  ['ambiguous On key', 'ambiguous top-level key "On"'],
  ['duplicate job id', 'duplicate job id "a"'],
  ['duplicate quoted job id', 'duplicate job id "a"'],
  ['duplicate job-child key', 'duplicate key "runs-on" in job "a"'],
  ['flow-mapping jobs', '`jobs:` with an inline value is outside the subset'],
  ['flow-mapping on', 'flow-mapping `on:` is outside the subset'],
  ['flow-mapping job', 'job "a" has an inline value'],
  ['multi-line flow on', 'multi-line flow collection is outside the subset'],
  ['multi-line quoted scalar', 'multi-line quoted scalar is outside the subset'],
  ['inconsistent job indentation', 'inconsistent job indentation'],
  ['inconsistent job-child indentation', 'inconsistent indentation in job "a"'],
  ['sequence under jobs', 'job entry is not a `key:` line'],
  ['explicit block indentation', 'explicit block-scalar indentation is outside the subset'],
  ['top-level sequence', 'top-level line is not a `key:` line'],
  ['indented root', 'indented content before the first top-level key'],
  ['no jobs key', 'no top-level `jobs:` key'],
  ['no on key', 'no top-level `on:` key'],
]);

describe('scanWorkflow: fails closed outside the subset', () => {
  const body = ['permissions: {}', 'jobs:', '  a:', '    runs-on: x'];
  test.each([
    ['tab in indentation', wf('on: push', ...body, '\tsteps: []')],
    [
      'tab inside a block scalar',
      wf('on: push', ...body, '    steps:', '      - run: |', '\t\techo'),
    ],
    ['second document marker', wf('on: push', ...body, '---', 'on: push')],
    ['document marker after content', wf('name: x', '---', 'on: push', ...body)],
    ['document end marker', wf('on: push', ...body, '...')],
    ['YAML directive', wf('%YAML 1.2', 'on: push', ...body)],
    ['anchor value', wf('on: push', 'env: &e', '  A: b', ...body)],
    ['alias value', wf('on: push', ...body, '    env: *e')],
    ['alias sequence item', wf('on: push', ...body, '    steps:', '      - *step')],
    [
      'anchored sequence item',
      wf('on: push', ...body, '    steps:', '      - &s', '        run: x'),
    ],
    ['merge key', wf('on: push', ...body, '    <<: {}')],
    ['nested merge key', wf('on: push', ...body, '    env:', '      <<: {A: b}')],
    ['tag', wf('on: push', ...body, '    timeout-minutes: !!int 5')],
    ['complex key', wf('on: push', ...body, '    ? x', '    : y')],
    ['duplicate top-level key', wf('on: push', 'name: a', 'name: b', ...body)],
    ['on spelled twice', wf('on: push', 'true: pull_request', ...body)],
    ['quoted "true" key', wf('"true": push', ...body)],
    ['ambiguous On key', wf('On: push', ...body)],
    ['duplicate job id', wf('on: push', ...body, '  a:', '    runs-on: y')],
    ['duplicate quoted job id', wf('on: push', ...body, "  'a':", '    runs-on: y')],
    ['duplicate job-child key', wf('on: push', ...body, '    runs-on: y')],
    ['flow-mapping jobs', wf('on: push', 'jobs: {a: {runs-on: x}}')],
    ['flow-mapping on', wf('on: {push: {}}', ...body)],
    ['flow-mapping job', wf('on: push', 'jobs:', '  a: {runs-on: x}')],
    ['multi-line flow on', wf('on: [push,', '  pull_request]', ...body)],
    ['multi-line quoted scalar', wf('on: push', ...body, '    if: "a', '      b"')],
    ['inconsistent job indentation', wf('on: push', ...body, ' b:', '    runs-on: x')],
    ['inconsistent job-child indentation', wf('on: push', ...body, '      steps: []', '   foo: x')],
    ['sequence under jobs', wf('on: push', 'jobs:', '  - a')],
    [
      'explicit block indentation',
      wf('on: push', ...body, '    steps:', '      - run: |2', '          x'),
    ],
    ['top-level sequence', wf('- on: push')],
    ['indented root', wf('  on: push', '  jobs:')],
    ['no jobs key', wf('on: push')],
    ['no on key', wf(...body)],
  ])('%s', (label, text) => {
    const scan = scanWorkflow(text);
    expect(scan.ok).toBe(false);
    expect(scan.ok ? '' : scan.reason).toContain(REJECT_REASONS.get(label));
  });
});

describe('scanWorkflow: privilege', () => {
  const withJob = (top: string[], jobLines: string[]) =>
    job(wf('on: push', ...top, 'jobs:', '  a:', '    runs-on: x', ...jobLines), 'a');

  test.each<[string, string[], string[], boolean, string[]]>([
    ['read-only top, no job perms', ['permissions:', '  contents: read'], [], false, []],
    ['no permissions anywhere', [], [], true, ['no permissions declared (default token)']],
    [
      'top write inherited',
      ['permissions:', '  contents: write'],
      [],
      true,
      ['permission contents: write (inherited)'],
    ],
    [
      'top write-all inherited',
      ['permissions: write-all'],
      [],
      true,
      ['permissions write-all (inherited)'],
    ],
    ['top read-all', ['permissions: read-all'], [], false, []],
    [
      'top {} and job write',
      ['permissions: {}'],
      ['    permissions:', '      contents: write'],
      true,
      ['permission contents: write'],
    ],
    [
      'job read overrides top write',
      ['permissions: write-all'],
      ['    permissions:', '      contents: read', '      checks: none'],
      false,
      [],
    ],
    [
      'job flow map',
      ['permissions: {}'],
      ['    permissions: { contents: read, issues: write }'],
      true,
      ['permission issues: write'],
    ],
    ['job empty flow map', [], ['    permissions: {}'], false, []],
    [
      'job write-all',
      ['permissions: {}'],
      ['    permissions: write-all'],
      true,
      ['permissions write-all'],
    ],
    ['job read-all', [], ['    permissions: read-all'], false, []],
    [
      'job quoted level',
      ['permissions: {}'],
      ['    permissions:', "      contents: 'write'"],
      true,
      ['permission contents: write'],
    ],
    [
      'job unknown inline value',
      ['permissions: {}'],
      ['    permissions: ${{ x }}'],
      true,
      ['permissions ${{ x }}'],
    ],
    ['environment', ['permissions: {}'], ['    environment: prod'], true, ['environment:']],
    [
      'environment mapping',
      ['permissions: {}'],
      ['    environment:', '      name: prod'],
      true,
      ['environment:'],
    ],
    [
      'reusable workflow',
      ['permissions: {}'],
      ['    uses: org/repo/.github/workflows/w.yml@v1'],
      true,
      ['reusable workflow call'],
    ],
    ['secrets: inherit', ['permissions: {}'], ['    secrets: inherit'], true, ['secrets: inherit']],
    [
      'secret in step env',
      ['permissions: {}'],
      ['    steps:', '      - env:', '          K: ${{ secrets.DEPLOY_KEY }}', '        run: x'],
      true,
      ['secret DEPLOY_KEY'],
    ],
    [
      'secret index form',
      ['permissions: {}'],
      ['    steps:', "      - run: echo ${{ secrets['K'] }}"],
      true,
      ['secrets[...] index'],
    ],
    [
      'whole secrets context',
      ['permissions: {}'],
      ['    steps:', '      - run: echo ${{ toJSON(secrets) }}'],
      true,
      ['secrets context'],
    ],
    [
      'upper-case context',
      ['permissions: {}'],
      ['    steps:', '      - run: echo ${{ SECRETS.K }}'],
      true,
      ['secret K'],
    ],
    [
      'GITHUB_TOKEN only',
      ['permissions: {}'],
      ['    steps:', '      - run: echo ${{ secrets.GITHUB_TOKEN }}'],
      false,
      [],
    ],
    [
      'secret in a comment is ignored',
      ['permissions: {}'],
      ['    # uses ${{ secrets.K }}', '    steps: []'],
      false,
      [],
    ],
    [
      'workflow env secret',
      ['permissions: {}', 'env:', '  K: ${{ secrets.K }}'],
      [],
      true,
      ['secret K (workflow env)'],
    ],
    [
      'workflow defaults secret',
      ['permissions: {}', 'defaults:', '  run:', '    working-directory: ${{ secrets.D }}'],
      [],
      true,
      ['secret D (workflow defaults)'],
    ],
  ])('%s', (_label, top, jobLines, privileged, reasons) => {
    const a = withJob(top, jobLines);
    expect(a.privileged).toBe(privileged);
    expect(a.privilegeReasons).toEqual(reasons);
  });

  test('local uses are collected and normalised', () => {
    const a = withJob(
      ['permissions: {}'],
      [
        '    steps:',
        '      - uses: ./.github/actions/setup/',
        "      - uses: './tools/x'",
        '      - { uses: ./flow }',
        '      - uses: actions/checkout@v5',
      ],
    );
    expect(a.localUses).toEqual(['.github/actions/setup', 'tools/x', 'flow']);
    expect(a.hasRunSteps).toBe(false);
    const reusable = withJob(['permissions: {}'], ['    uses: ./.github/workflows/w.yml']);
    expect(reusable.localUses).toEqual(['.github/workflows/w.yml']);
  });

  test('defaults.run is not a run step', () => {
    expect(withJob([], ['    defaults:', '      run:', '        shell: bash']).hasRunSteps).toBe(
      false,
    );
  });
});

describe('producersOf', () => {
  const scan = ok(
    wf(
      'on: push',
      'permissions: {}',
      'jobs:',
      '  static:',
      '    runs-on: x',
      '  named:',
      "    name: 'lint'",
      '    runs-on: x',
      '  dyn:',
      '    name: build ${{ matrix.os }}',
      '    runs-on: x',
      '  matrix:',
      '    strategy:',
      '      matrix:',
      '        os: [a, b]',
      '    runs-on: x',
      '  call:',
      '    uses: ./.github/workflows/w.yml',
      '  lint2:',
      '    name: >-',
      '      lint2',
      '    runs-on: x',
    ),
  );
  test.each([
    ['static', ['static']],
    ['lint', ['named']],
    ['named', []],
    ['dyn', []],
    ['matrix', []],
    ['call', []],
    ['lint2', []],
  ])('%s -> %j', (check, producers) => {
    expect(producersOf(scan, check)).toEqual(producers);
  });
  test('dynamic and block-scalar names are flagged dynamic', () => {
    expect(scan.jobs.get('dyn')!.dynamicName).toBe(true);
    expect(scan.jobs.get('lint2')!.dynamicName).toBe(true);
    expect(scan.jobs.get('named')!.name).toBe('lint');
  });
});

describe('lintWorkflow (ADR-0004 D-G.3)', () => {
  const lint = (text: string) => lintWorkflow(PATH, ok(text)).map((f) => f.reason);

  test.each<[string, string, number]>([
    [
      '1: pull_request_target with environment',
      wf(
        'on: pull_request_target',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    environment: prod',
        '    runs-on: x',
      ),
      1,
    ],
    [
      '1: pull_request_target with a secret',
      wf(
        'on: [pull_request_target]',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - run: echo ${{ secrets.K }}',
      ),
      1,
    ],
    [
      '1: not for pull_request',
      wf(
        'on: pull_request',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    environment: prod',
        '    runs-on: x',
      ),
      0,
    ],
    [
      '1: GITHUB_TOKEN is fine',
      wf(
        'on: pull_request_target',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - run: echo ${{ secrets.GITHUB_TOKEN }}',
      ),
      0,
    ],
    ...[
      'head_sha',
      'github.head_ref',
      'pull_request.head.sha',
      'refs/pull/1/merge',
      'merge_commit_sha',
      'workflow_run.head_branch',
    ].map((ref): [string, string, number] => [
      `2: workflow_run checkout of ${ref}`,
      wf(
        'on:',
        '  workflow_run:',
        '    workflows: [ci]',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - name: co',
        '        uses: actions/checkout@v5',
        '        with:',
        `          ref: \${{ github.event.${ref} }}`,
      ),
      1,
    ]),
    [
      '2: pull_request_target flow-map checkout',
      wf(
        'on: pull_request_target',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        "      - uses: 'actions/checkout@v5'",
        '        with: { ref: "${{ github.event.pull_request.head.ref }}" }',
      ),
      1,
    ],
    [
      '2: trust-ref checkout is fine',
      wf(
        'on: workflow_run',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - uses: actions/checkout@v5',
        '        with:',
        '          ref: ${{ github.sha }}',
      ),
      0,
    ],
    [
      '2: head ref on another action is fine',
      wf(
        'on: workflow_run',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - uses: some/action@v1',
        '        with:',
        '          ref: ${{ github.head_ref }}',
      ),
      0,
    ],
    [
      '2: not for pull_request',
      wf(
        'on: pull_request',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - uses: actions/checkout@v5',
        '        with:',
        '          ref: ${{ github.head_ref }}',
      ),
      0,
    ],
    [
      '3: persist-credentials true with run steps',
      wf(
        'on: push',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - uses: actions/checkout@v5',
        '        with:',
        '          persist-credentials: true',
        '      - run: make',
      ),
      1,
    ],
    [
      '3: quoted true',
      wf(
        'on: push',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - uses: actions/checkout@v5',
        '        with:',
        "          persist-credentials: 'true'",
        '      - run: make',
      ),
      1,
    ],
    [
      '3: no run steps',
      wf(
        'on: push',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - uses: actions/checkout@v5',
        '        with:',
        '          persist-credentials: true',
      ),
      0,
    ],
    [
      '3: false is fine',
      wf(
        'on: push',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        '      - uses: actions/checkout@v5',
        '        with:',
        '          persist-credentials: false',
        '      - run: make',
      ),
      0,
    ],
  ])('%s', (_label, text, count) => {
    expect(lint(text)).toHaveLength(count);
  });
});

describe('diffWorkflow', () => {
  const PRIV = wf(
    'on: push',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  build:',
    '    runs-on: x',
    '    steps:',
    '      - run: npm test',
    '  deploy:',
    '    runs-on: x',
    '    steps:',
    '      - run: ./deploy',
    '        env:',
    '          KEY: ${{ secrets.DEPLOY_KEY }}',
  );

  test('identical text yields nothing, not even lint', () => {
    const linting = wf(
      'on: pull_request_target',
      'jobs:',
      '  a:',
      '    environment: prod',
      '    runs-on: x',
    );
    expect(diffWorkflow(PATH, linting, linting)).toEqual([]);
    expect(diffWorkflow(PATH, null, null)).toEqual([]);
  });

  test('new workflow: workflow-new plus lint of the subject', () => {
    expect(kinds(diffWorkflow(PATH, null, READ_ONLY))).toEqual(['workflow-new']);
    const linting = wf(
      'on: pull_request_target',
      'jobs:',
      '  a:',
      '    environment: prod',
      '    runs-on: x',
    );
    expect(kinds(diffWorkflow(PATH, null, linting))).toEqual(['workflow-new', 'lint']);
    expect(kinds(diffWorkflow(PATH, null, 'on: push\n\tjobs:'))).toEqual([
      'workflow-new',
      'workflow-unparseable',
    ]);
  });

  test('removed workflow', () => {
    const findings = diffWorkflow(PATH, READ_ONLY, null);
    expect(kinds(findings)).toEqual(['workflow-removed']);
    expect(findings[0]!.reason).toContain('push, pull_request');
  });

  test('unparseable side is named; the subject is still linted', () => {
    const bad = 'on: push\njobs: {a: {}}\n';
    const base = diffWorkflow(PATH, bad, READ_ONLY);
    expect(kinds(base)).toEqual(['workflow-unparseable']);
    expect(base[0]!.reason).toMatch(/^range base /);
    const subject = diffWorkflow(PATH, READ_ONLY, bad);
    expect(subject[0]!.reason).toMatch(/^subject /);
    const linting = wf(
      'on: pull_request_target',
      'jobs:',
      '  a:',
      '    environment: prod',
      '    runs-on: x',
    );
    expect(kinds(diffWorkflow(PATH, bad, linting))).toEqual(['workflow-unparseable', 'lint']);
  });

  test('comment-only and blank-line changes to any job yield nothing', () => {
    const edited = PRIV.replace('  build:\n', '  build:\n    # a comment\n\n').replace(
      '      - run: ./deploy\n',
      '      - run: ./deploy # why\n',
    );
    expect(diffWorkflow(PATH, PRIV, edited)).toEqual([]);
  });

  test('a changed non-privileged job yields nothing', () => {
    expect(diffWorkflow(PATH, PRIV, PRIV.replace('npm test', 'npm run test:unit'))).toEqual([]);
  });

  test('a changed privileged job', () => {
    const findings = diffWorkflow(PATH, PRIV, PRIV.replace('./deploy', './deploy --force'));
    expect(kinds(findings)).toEqual(['privileged-job']);
    expect(findings[0]!.reason).toContain('deploy changed');
    expect(findings[0]!.reason).toContain('secret DEPLOY_KEY');
  });

  test('a job that becomes privileged is flagged by its subject end', () => {
    const findings = diffWorkflow(
      PATH,
      PRIV,
      PRIV.replace(
        '    steps:\n      - run: npm test',
        '    environment: prod\n    steps:\n      - run: npm test',
      ),
    );
    expect(findings.map((f) => f.reason)).toEqual(['privileged job build changed (environment:)']);
  });

  test('a new job with environment: prod', () => {
    const findings = diffWorkflow(
      PATH,
      PRIV,
      `${PRIV}  release:\n    environment: prod\n    runs-on: x\n`,
    );
    expect(findings.map((f) => f.reason)).toEqual(['privileged job release added (environment:)']);
  });

  test('a removed privileged job', () => {
    const without = PRIV.slice(0, PRIV.indexOf('  deploy:'));
    expect(diffWorkflow(PATH, PRIV, without).map((f) => f.reason)).toEqual([
      'privileged job deploy removed (secret DEPLOY_KEY)',
    ]);
  });

  test('a new job with secrets: inherit', () => {
    const findings = diffWorkflow(
      PATH,
      PRIV,
      `${PRIV}  call:\n    uses: org/r/.github/workflows/w.yml@v1\n    secrets: inherit\n`,
    );
    expect(findings.map((f) => f.reason)).toEqual([
      'privileged job call added (secrets: inherit; reusable workflow call)',
    ]);
  });

  test('trigger change', () => {
    const findings = diffWorkflow(
      PATH,
      READ_ONLY,
      READ_ONLY.replace('  pull_request:\n', '  pull_request_target:\n'),
    );
    expect(kinds(findings)).toEqual(['trigger-changed']);
    expect(findings[0]!.reason).toContain('push, pull_request -> push, pull_request_target');
  });

  test('context change flags once only when a job is privileged', () => {
    const concurrency = (t: string) => t.replace('jobs:', 'concurrency: g\njobs:');
    expect(diffWorkflow(PATH, READ_ONLY, concurrency(READ_ONLY))).toEqual([]);
    expect(kinds(diffWorkflow(PATH, PRIV, concurrency(PRIV)))).toEqual(['privileged-job']);
  });

  test('widening top-level permissions flags every job it makes privileged', () => {
    const findings = diffWorkflow(
      PATH,
      READ_ONLY,
      READ_ONLY.replace('contents: read', 'contents: write'),
    );
    expect(findings.map((f) => f.reason)).toEqual([
      'workflow-level context (permissions/env/defaults/concurrency) changed with privileged job(s) build',
    ]);
  });

  test('lint is regression-only: a pre-existing violation is base-owned', () => {
    const violating = READ_ONLY.replace('persist-credentials: false', 'persist-credentials: true');
    // Editing the violating job (same rule, same job) raises no lint.
    expect(
      diffWorkflow(PATH, violating, violating.replace('npm test', 'npm run test:unit')),
    ).toEqual([]);
    // The same rule newly broken by ANOTHER job is a regression.
    const second = `${violating}  other:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          persist-credentials: true\n      - run: make\n`;
    expect(diffWorkflow(PATH, violating, second).map((f) => f.reason)).toEqual([
      'job other sets persist-credentials: true and has run: steps',
    ]);
    // An unparseable base cannot own anything: every subject violation counts.
    expect(kinds(diffWorkflow(PATH, 'on: push\njobs: {}\n', violating))).toEqual([
      'workflow-unparseable',
      'lint',
    ]);
  });

  test('the real cq-verify.yml violation is base-owned for an unrelated edit', () => {
    const text = readFileSync(join(WORKFLOW_DIR, 'cq-verify.yml'), 'utf8');
    expect(diffWorkflow(PATH, text, `${text}# trailing comment\n`)).toEqual([]);
    expect(
      kinds(diffWorkflow(PATH, text, text.replace('timeout-minutes: 5', 'timeout-minutes: 6'))),
    ).not.toContain('lint');
  });

  test('adding a lint violation to an existing workflow is linted', () => {
    const findings = diffWorkflow(
      PATH,
      READ_ONLY,
      READ_ONLY.replace('persist-credentials: false', 'persist-credentials: true'),
    );
    expect(kinds(findings)).toEqual(['lint']);
  });
});

describe('the repository workflows', () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  const read = (f: string) => readFileSync(join(WORKFLOW_DIR, f), 'utf8');

  test.each(files)('%s scans ok', (f) => {
    const scan = scanWorkflow(read(f));
    expect(scan.ok ? 'ok' : scan.reason).toBe('ok');
  });

  test.each([
    ['ci.yml', 'static', ['static']],
    ['denylist.yml', 'denylist', ['denylist']],
    ['ratchet.yml', 'ratchet', ['ratchet']],
  ])('%s produces %s', (f, check, producers) => {
    expect(producersOf(ok(read(f)), check)).toEqual(producers);
  });

  test('merge-queue-gate.yml gate job is privileged by secrets.PROMOTE_TOKEN', () => {
    const gate = ok(read('merge-queue-gate.yml')).jobs.get('gate')!;
    expect(gate.privileged).toBe(true);
    expect(gate.privilegeReasons).toContain('secret PROMOTE_TOKEN');
  });

  test('cq-measure.yml jobs are not privileged under permissions: {}', () => {
    const scan = ok(read('cq-measure.yml'));
    expect(scan.jobs.size).toBeGreaterThan(0);
    for (const j of scan.jobs.values()) expect(j.privileged).toBe(false);
  });

  test('ci.yml is lint-clean; cq-verify.yml trips rule 3 in its fetch job (reported, not changed)', () => {
    expect(lintWorkflow('.github/workflows/ci.yml', ok(read('ci.yml')))).toEqual([]);
    expect(
      lintWorkflow('.github/workflows/cq-verify.yml', ok(read('cq-verify.yml'))).map(
        (f) => f.reason,
      ),
    ).toEqual(['job fetch sets persist-credentials: true and has run: steps']);
  });
});
