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
  ['quoted "true" key', 'quoted key is outside the subset'],
  ['ambiguous On key', 'ambiguous top-level key "On"'],
  ['duplicate job id', 'duplicate job id "a"'],
  ['quoted job id', 'quoted key is outside the subset'],
  ['duplicate job-child key', 'duplicate key "runs-on" in job "a"'],
  ['flow-mapping jobs', 'flow mapping is outside the subset'],
  ['flow-mapping on', 'flow mapping is outside the subset'],
  ['flow-mapping job', 'flow mapping is outside the subset'],
  ['jobs with a scalar value', '`jobs:` with an inline value is outside the subset'],
  ['job with a scalar value', 'job "a" has an inline value'],
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
    ['quoted job id', wf('on: push', ...body, "  'a':", '    runs-on: y')],
    ['duplicate job-child key', wf('on: push', ...body, '    runs-on: y')],
    ['flow-mapping jobs', wf('on: push', 'jobs: {a: {runs-on: x}}')],
    ['flow-mapping on', wf('on: {push: {}}', ...body)],
    ['flow-mapping job', wf('on: push', 'jobs:', '  a: {runs-on: x}')],
    ['jobs with a scalar value', wf('on: push', 'jobs: x')],
    ['job with a scalar value', wf('on: push', 'jobs:', '  a: x')],
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

describe('scanWorkflow: parser differentials fail closed (C1/C2)', () => {
  const head = ['on: push', 'permissions: {}', 'jobs:', '  a:', '    runs-on: x'];
  const step = (...lines: string[]) => wf(...head, '    steps:', ...lines);
  test.each<[string, string, string]>([
    // C1(a): any backslash escape in a double-quoted scalar, key or value.
    ['escaped double-quoted value', wf(...head, '    name: "a\\u0041"'), 'backslash escape'],
    [
      'escaped double-quoted key',
      wf(...head, '    "permi\\x73sions": write-all'),
      'backslash escape',
    ],
    ['escaped step value', step('      - uses: "actions/checkout\\x40v5"'), 'backslash escape'],
    // C1(b): quoted keys anywhere except the top-level on.
    ['quoted top-level name key', wf('"name": x', ...head), 'quoted key'],
    ['quoted job key', wf(...head, "    'permissions': write-all"), 'quoted key'],
    ['quoted step key', step('      - "uses": ./x'), 'quoted key'],
    [
      'quoted with key',
      step('      - uses: actions/checkout@v5', '        with:', "          'ref': x"),
      'quoted key',
    ],
    [
      'quoted on child key',
      wf('on:', '  "push":', 'jobs:', '  a:', '    runs-on: x'),
      'quoted key',
    ],
    // C1(c): keys outside the allow-lists; keys are case-sensitive.
    ['unknown top-level key', wf('foo: x', ...head), 'unknown top-level key "foo"'],
    ['Permissions top-level', wf('Permissions: write-all', ...head), 'unknown top-level key'],
    [
      'Permissions job key',
      wf(...head, '    Permissions: write-all'),
      'unknown key "Permissions" in job',
    ],
    [
      'Environment job key',
      wf(...head, '    Environment: prod'),
      'unknown key "Environment" in job',
    ],
    ['unknown step key', step('      - Uses: ./x'), 'unknown key "Uses" in step 1'],
    ['step that is not a mapping', step('      - echo'), 'is not a mapping'],
    [
      'duplicate step key',
      step('      - run: a', '        run: b'),
      'duplicate key "run" in step 1',
    ],
    [
      'duplicate with key',
      step('      - uses: x', '        with:', '          ref: a', '          ref: b'),
      'duplicate key "ref"',
    ],
    ['flow-mapping step', step('      - { uses: ./flow }'), 'flow mapping'],
    [
      'flow-mapping with',
      step('      - uses: actions/checkout@v5', '        with: { ref: x }'),
      'flow mapping',
    ],
    ['flow map inside a flow sequence', wf(...head, '    needs: [{a: b}]'), 'flow mapping'],
    ['nested inline sequence', step('      - - run: x'), 'nested inline sequence'],
    // C2: line breaks and controls.
    ['bare CR', `on: push\rjobs:\n  a:\n    runs-on: x\n`, 'bare carriage return'],
    ['NEL', wf(...head, '    name: a\u0085b'), 'Unicode line break'],
    ['LINE SEPARATOR', wf(...head, '    name: a\u2028b'), 'Unicode line break'],
    ['PARAGRAPH SEPARATOR', wf(...head, '    name: a\u2029b'), 'Unicode line break'],
    ['NUL', wf(...head, '    name: a\u0000b'), 'control character'],
    ['vertical tab', wf(...head, '    name: a\u000Bb'), 'control character'],
    ['DEL', wf(...head, '    name: a\u007Fb'), 'control character'],
    ['C1 control', wf(...head, '    name: a\u009Bb'), 'control character'],
    ['NUL inside a run block', step('      - run: |', '          a\u0000b'), 'control character'],
    ['BOM after offset 0', `on: push\n\uFEFF${wf(...head.slice(1))}`, 'byte-order mark'],
    [
      'tab after a colon',
      wf(...head, '    environment:\tprod'),
      'tab outside block-scalar content',
    ],
    ['NBSP separator', wf(...head, '    environment:\u00A0prod'), 'non-ASCII space'],
  ])('%s', (_label, text, reason) => {
    const scan = scanWorkflow(text);
    expect(scan.ok ? 'ok' : scan.reason).toContain(reason);
  });

  test('tabs inside block-scalar content and comment lines are allowed', () => {
    expect(
      scanWorkflow(step('      - run: |', '          printf "a\\tb"\techo', '    #\tnote')).ok,
    ).toBe(true);
  });

  test('the top-level on may be quoted; snapshot is a documented job key', () => {
    expect(
      scanWorkflow(
        wf("'on': push", 'permissions: {}', 'jobs:', '  a:', '    snapshot: img', '    runs-on: x'),
      ).ok,
    ).toBe(true);
  });

  test('single-quoted values are fine and read as literals', () => {
    const a = job(step("      - uses: './tools/x'", "      - run: 'echo it''s'"), 'a');
    expect(a.localUses).toEqual(['tools/x']);
    expect(a.hasRunSteps).toBe(true);
  });

  test('uses/run/ref are key-based: text inside a run block is not a step key', () => {
    const a = job(step('      - run: |', '          uses: ./evil', '          run: x'), 'a');
    expect(a.localUses).toEqual([]);
    expect(
      lintWorkflow(
        PATH,
        ok(
          wf(
            'on: workflow_run',
            'permissions: {}',
            'jobs:',
            '  a:',
            '    runs-on: x',
            '    steps:',
            '      - run: |',
            '          uses: actions/checkout@v5',
            '          ref: ${{ inputs.x }}',
          ),
        ),
      ),
    ).toEqual([]);
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
        '      - uses: actions/checkout@v5',
      ],
    );
    expect(a.localUses).toEqual(['.github/actions/setup', 'tools/x']);
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
      '2: pull_request_target quoted-uses checkout',
      wf(
        'on: pull_request_target',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: x',
        '    steps:',
        "      - uses: 'actions/checkout@v5'",
        '        with:',
        '          ref: "${{ github.event.pull_request.head.ref }}"',
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

describe('lintWorkflow: head checkout and credentials (H1)', () => {
  /** A one-job workflow on `trigger` whose steps are `steps`. */
  const flow = (trigger: string, ...steps: string[]) =>
    wf(
      `on: ${trigger}`,
      'permissions: {}',
      'jobs:',
      '  a:',
      '    runs-on: x',
      '    steps:',
      ...steps,
    );
  const checkout = (...withLines: string[]) => [
    '      - uses: actions/checkout@v5',
    '        with:',
    '          persist-credentials: false',
    ...withLines.map((l) => `          ${l}`),
  ];
  const lint = (text: string) => lintWorkflow(PATH, ok(text)).map((f) => f.reason);

  test.each<[string, string[], number]>([
    ['base sha', checkout('ref: ${{ github.sha }}'), 0],
    ['base default branch', checkout('ref: ${{ github.event.repository.default_branch }}'), 0],
    ['base ref, spaced and cased', checkout('ref: ${{GitHub.Event.Pull_Request.Base.Ref}}'), 0],
    ['base repository', checkout('repository: ${{ github.repository }}'), 0],
    ['literal branch', checkout('ref: main'), 0],
    ['head sha', checkout('ref: ${{ github.event.workflow_run.head_sha }}'), 1],
    ['unlisted expression', checkout('ref: ${{ inputs.ref }}'), 1],
    [
      'base OR head',
      checkout('ref: ${{ github.event.pull_request.base.sha || github.head_ref }}'),
      1,
    ],
    [
      'head repository',
      checkout('repository: ${{ github.event.pull_request.head.repo.full_name }}'),
      1,
    ],
    ['literal PR ref', checkout('ref: refs/pull/1/merge'), 1],
    ['block-scalar ref', checkout('ref: >-', '  ${{ github.event.workflow_run.head_sha }}'), 1],
    [
      'fetch objects only',
      [
        '      - env:',
        '          SHA: ${{ github.event.workflow_run.head_sha }}',
        '        run: git fetch origin "$SHA"',
      ],
      0,
    ],
    [
      'checkout FETCH_HEAD',
      ['      - run: |', '          git fetch origin "$SHA"', '          git checkout FETCH_HEAD'],
      1,
    ],
    [
      'head expression inline',
      ['      - run: git checkout ${{ github.event.workflow_run.head_sha }}'],
      1,
    ],
    [
      'head expression via step env',
      [
        '      - env:',
        '          SHA: ${{ github.event.workflow_run.head_sha }}',
        '        run: git -c x=y switch --detach "$SHA"',
      ],
      1,
    ],
    ['refs/pull/ in run', ['      - run: git fetch origin refs/pull/1/head'], 1],
    ['pull/${{ in run', ['      - run: curl https://x/pull/${{ github.event.number }}'], 1],
    ['base checkout in run', ['      - run: git checkout "$GITHUB_SHA"'], 0],
    [
      'head checkout across a line continuation',
      [
        '      - run: |',
        '          git \\',
        '            checkout ${{ github.event.workflow_run.head_sha }}',
      ],
      1,
    ],
    [
      'FETCH_HEAD across a line continuation',
      [
        '      - run: |',
        '          git fetch origin "$SHA"',
        '          git \\',
        '            checkout FETCH_HEAD',
      ],
      1,
    ],
    [
      "a fork's checkout with a head ref",
      [
        '      - uses: evil/checkout@main',
        '        with:',
        '          persist-credentials: false',
        '          ref: ${{ github.event.workflow_run.head_sha }}',
      ],
      1,
    ],
    [
      'a checkout subaction with a head ref',
      [
        '      - uses: actions/checkout/sub@v4',
        '        with:',
        '          persist-credentials: false',
        '          ref: ${{ github.event.workflow_run.head_sha }}',
      ],
      1,
    ],
    [
      "a fork's checkout without persist-credentials: false",
      ['      - uses: evil/checkout@main', '      - run: make'],
      1,
    ],
  ])('workflow_run: %s', (_label, steps, count) => {
    expect(lint(flow('workflow_run', ...steps))).toHaveLength(count);
  });

  test('the same head checkout is not linted under pull_request', () => {
    expect(
      lint(flow('pull_request', ...checkout('ref: ${{ github.event.pull_request.head.sha }}'))),
    ).toEqual([]);
    expect(lint(flow('pull_request', '      - run: git checkout FETCH_HEAD'))).toEqual([]);
  });

  test('a head expression in job env reaches a run step', () => {
    const text = wf(
      'on: pull_request_target',
      'permissions: {}',
      'jobs:',
      '  a:',
      '    runs-on: x',
      '    env:',
      '      SHA: ${{ github.event.pull_request.head.sha }}',
      '    steps:',
      '      - run: git worktree add w "$SHA"',
    );
    expect(lint(text)).toHaveLength(1);
  });

  test.each<[string, string[], number]>([
    [
      'checkout without persist-credentials, with run steps',
      ['      - uses: actions/checkout@v5', '      - run: make'],
      1,
    ],
    [
      'persist-credentials: False literal',
      [
        '      - uses: actions/checkout@v5',
        '        with:',
        '          persist-credentials: False',
        '      - run: make',
      ],
      0,
    ],
    [
      'expression value is not a false literal',
      [
        '      - uses: actions/checkout@v5',
        '        with:',
        '          persist-credentials: ${{ false }}',
        '      - run: make',
      ],
      2,
    ],
    ['no run steps', ['      - uses: actions/checkout@v5'], 0],
  ])('pull_request_target: %s', (_label, steps, count) => {
    expect(lint(flow('pull_request_target', ...steps))).toHaveLength(count);
  });

  test('missing persist-credentials: false is not linted for push', () => {
    expect(lint(flow('push', '      - uses: actions/checkout@v5', '      - run: make'))).toEqual(
      [],
    );
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
    const edited = text.replace('timeout-minutes: 5', 'timeout-minutes: 6');
    expect(edited).not.toBe(text);
    expect(kinds(diffWorkflow(PATH, text, edited))).not.toContain('lint');
  });

  test('a new signal in an already-violating job is not suppressed', () => {
    const prt = wf(
      'on: pull_request_target',
      'permissions: {}',
      'jobs:',
      '  a:',
      '    environment: prod',
      '    runs-on: x',
      '    steps:',
      '      - run: make',
    );
    const withSecret = prt.replace('run: make', 'run: make ${{ secrets.K }}');
    expect(
      diffWorkflow(PATH, prt, withSecret)
        .filter((f) => f.kind === 'lint')
        .map((f) => f.reason),
    ).toEqual(['pull_request_target job a has secret K']);
    const oneCheckout = wf(
      'on: workflow_run',
      'permissions: {}',
      'jobs:',
      '  a:',
      '    runs-on: x',
      '    steps:',
      '      - uses: actions/checkout@v5',
      '      - run: make',
    );
    const twoCheckouts = oneCheckout.replace(
      '      - run: make',
      '      - uses: actions/checkout@v5\n      - run: make',
    );
    expect(kinds(diffWorkflow(PATH, oneCheckout, oneCheckout.replace('make', 'make all')))).toEqual(
      [],
    );
    expect(diffWorkflow(PATH, oneCheckout, twoCheckouts).map((f) => f.reason)).toEqual([
      'workflow_run job a checkout #2 lacks persist-credentials: false and the job has run: steps',
    ]);
    const headRef = (ref: string) =>
      oneCheckout.replace(
        'actions/checkout@v5',
        `actions/checkout@v5\n        with:\n          ref: \${{ ${ref} }}`,
      );
    expect(
      kinds(
        diffWorkflow(
          PATH,
          headRef('github.head_ref'),
          headRef('github.event.workflow_run.head_sha'),
        ),
      ),
    ).toEqual(['lint']);
  });

  test('a workflow rename is a trigger change (workflow_run watchers match on name)', () => {
    const findings = diffWorkflow(
      PATH,
      READ_ONLY,
      READ_ONLY.replace('name: ci', 'name: cq-signal'),
    );
    expect(kinds(findings)).toEqual(['trigger-changed']);
    expect(findings[0]!.reason).toContain('ci -> name: cq-signal');
    expect(kinds(diffWorkflow(PATH, READ_ONLY, READ_ONLY.replace('name: ci\n', '')))).toEqual([
      'trigger-changed',
    ]);
    expect(
      diffWorkflow(PATH, READ_ONLY, READ_ONLY.replace('name: ci', 'name: ci # comment')),
    ).toEqual([]);
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

  test('only cq-verify.yml trips the lint (base-owned fetch job; reported, not changed)', () => {
    for (const f of files.filter((name) => name !== 'cq-verify.yml')) {
      expect([f, lintWorkflow(`.github/workflows/${f}`, ok(read(f)))]).toEqual([f, []]);
    }
    expect(
      lintWorkflow('.github/workflows/cq-verify.yml', ok(read('cq-verify.yml'))).map(
        (f) => f.reason,
      ),
    ).toEqual([
      'job fetch sets persist-credentials: true and has run: steps',
      'workflow_run job fetch checkout #1 lacks persist-credentials: false and the job has run: steps',
    ]);
  });
});
