// Split provenance: test/ops/gates/workflowScan.test.ts was split by subject
// into workflowScan.{scan,reject,differential,privilege,producers,lint,headCheckout,diff,repo}.test.ts.
// This file covers the H1 head-checkout and credential lint rules.
import { describe, expect, test } from 'vitest';
import { diffWorkflow } from '../../../src/ops/gates/workflowScan.js';
import { lintReasons, PATH, wf } from './workflowScan.helpers.js';

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
      'head_commit.id in run (F2)',
      ['      - run: git checkout ${{ github.event.workflow_run.head_commit.id }}'],
      1,
    ],
    [
      'a literal | block of independent lines stays clean (F1)',
      [
        '      - env:',
        '          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}',
        '        run: |',
        '          git fetch --no-tags origin "$HEAD_SHA"',
        '          # objects only: we never checkout the head',
      ],
      0,
    ],
    [
      'an env head value the moving git row never reads (F2 precision)',
      [
        '      - env:',
        '          BASE: ${{ needs.resolve.outputs.base }}',
        '          TRUST: ${{ github.sha }}',
        '        run: |',
        '          git -C trust update-ref "refs/remotes/origin/${BASE}" refs/x',
        '          git -C trust checkout --detach "$TRUST"',
      ],
      0,
    ],
    [
      'a non-base env value the moving git row reads (F2)',
      ['      - env:', '          REF: ${{ inputs.ref }}', '        run: git checkout "$REF"'],
      1,
    ],
    [
      'plain scalar starting on the next line folds (R2-1)',
      [
        '      - run:',
        '          git',
        '          checkout ${{ github.event.workflow_run.head_sha }}',
      ],
      1,
    ],
    [
      'plain scalar on the next line hides no FETCH_HEAD checkout (R2-1)',
      ['      - run:', '          git', '          checkout FETCH_HEAD'],
      1,
    ],
    [
      'env head value through a one-line reassignment (R2-2)',
      [
        '      - env:',
        '          HEAD_REF: ${{ github.event.workflow_run.head_sha }}',
        '        run: |',
        '          R="$HEAD_REF"',
        '          git checkout "$R"',
      ],
      1,
    ],
    [
      'env head value through two exported hops (R2-2)',
      [
        '      - env:',
        '          HEAD_REF: ${{ github.event.workflow_run.head_sha }}',
        '        run: |',
        '          export A=${HEAD_REF}; B="pre-$A"',
        '          git switch --detach "$B"',
      ],
      1,
    ],
    [
      'a reassigned base value stays clean (R2-2 precision)',
      [
        '      - env:',
        '          TRUST: ${{ github.sha }}',
        '        run: |',
        '          R="$TRUST"',
        '          git checkout "$R"',
      ],
      0,
    ],
    ...(['>', '|', ''] as const).map((style): [string, string[], number] => [
      `env head value spelled as a ${style || 'next-line plain'} scalar (N1)`,
      [
        '      - env:',
        `          HEAD_REF:${style === '' ? '' : ` ${style}`}`,
        '            ${{ github.event.workflow_run.head_sha }}',
        '        run: git checkout "$HEAD_REF"',
      ],
      1,
    ]),
    [
      'a multi-line env base value stays clean (N1 precision)',
      [
        '      - env:',
        '          TRUST: |',
        '            ${{ github.sha }}',
        '        run: git checkout "$TRUST"',
      ],
      0,
    ],
    [
      'an env given as one expression defines unknowable names (N1)',
      ['      - env: ${{ fromJSON(inputs.env) }}', '        run: git checkout "$REF"'],
      1,
    ],
    [
      'env head value through a declare -n nameref (r4 F2)',
      [
        '      - env:',
        '          HEAD_REF: ${{ github.event.workflow_run.head_sha }}',
        '        run: |',
        '          declare -n r=HEAD_REF',
        '          git checkout "$r"',
      ],
      1,
    ],
    [
      'env head value through a += append (N2)',
      [
        '      - env:',
        '          HEAD_REF: ${{ github.event.workflow_run.head_sha }}',
        '        run: |',
        '          R="v1-"; R+="$HEAD_REF"; git checkout "$R"',
      ],
      1,
    ],
    [
      'env head value through a command substitution with nested quotes (N3)',
      [
        '      - env:',
        '          HEAD_REF: ${{ github.event.workflow_run.head_sha }}',
        '        run: |',
        '          R="$(printf \'%s\' "$HEAD_REF")"',
        '          git checkout "$R"',
      ],
      1,
    ],
    [
      'env head value through ${!x} indirection (N3)',
      [
        '      - env:',
        '          HEAD_REF: ${{ github.event.workflow_run.head_sha }}',
        '        run: |',
        '          x=HEAD_REF',
        '          git checkout "${!x}"',
      ],
      1,
    ],
    [
      'head checkout folded by a > scalar',
      [
        '      - run: >',
        '          git',
        '          checkout ${{ github.event.workflow_run.head_sha }}',
      ],
      1,
    ],
    [
      'head checkout folded by a multi-line plain scalar',
      ['      - run: git', '          checkout ${{ github.event.workflow_run.head_sha }}'],
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
    expect(lintReasons(flow('workflow_run', ...steps))).toHaveLength(count);
  });

  test.each([
    ['github.event.after', '${{ github.event.after }}'],
    ["bracketed pull_request['head']['sha']", "${{ github.event.pull_request['head']['sha'] }}"],
  ])('pull_request_target: git checkout of %s is linted (F2)', (_label, expr) => {
    expect(
      lintReasons(flow('pull_request_target', `      - run: git checkout ${expr}`)),
    ).toHaveLength(1);
  });

  test.each<[string, string[], number]>([
    [
      'a workflow-level env head value (r4 F1)',
      ['  HEAD_REF: ${{ github.event.workflow_run.head_sha }}'],
      1,
    ],
    [
      'a workflow-level folded env head value (r4 F1)',
      ['  HEAD_REF: >', '    ${{ github.event.workflow_run.head_sha }}'],
      1,
    ],
    ['a workflow-level env base value (r4 F1 precision)', ['  TRUST: ${{ github.sha }}'], 0],
  ])('%s read by a moving git row', (_label, envLines, count) => {
    const text = wf(
      'on: workflow_run',
      'permissions: {}',
      'env:',
      ...envLines,
      'jobs:',
      '  a:',
      '    runs-on: x',
      '    steps:',
      `      - run: git checkout "$${envLines[0]!.trim().split(':')[0]}"`,
    );
    expect(lintReasons(text)).toHaveLength(count);
  });

  test('a workflow-level env given as one expression taints any reference (r4 F1)', () => {
    const text = wf(
      'on: workflow_run',
      'permissions: {}',
      'env: ${{ fromJSON(inputs.env) }}',
      'jobs:',
      '  a:',
      '    runs-on: x',
      '    steps:',
      '      - run: git checkout "$REF"',
    );
    expect(lintReasons(text)).toHaveLength(1);
  });

  test('a > block edit elsewhere does not re-lint a base-owned folded violation (F1/F4)', () => {
    const block = (extra: string) =>
      flow(
        'workflow_run',
        '      - run: >',
        '          git',
        '          checkout ${{ github.event.workflow_run.head_sha }}',
        '',
        `          echo ${extra}`,
      );
    const before = block('one');
    expect(lintReasons(before)).toHaveLength(1);
    expect(diffWorkflow(PATH, before, block('two'))).toEqual([]);
  });

  test('the same head checkout is not linted under pull_request', () => {
    expect(
      lintReasons(
        flow('pull_request', ...checkout('ref: ${{ github.event.pull_request.head.sha }}')),
      ),
    ).toEqual([]);
    expect(lintReasons(flow('pull_request', '      - run: git checkout FETCH_HEAD'))).toEqual([]);
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
    expect(lintReasons(text)).toHaveLength(1);
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
    expect(lintReasons(flow('pull_request_target', ...steps))).toHaveLength(count);
  });

  test('missing persist-credentials: false is not linted for push', () => {
    expect(
      lintReasons(flow('push', '      - uses: actions/checkout@v5', '      - run: make')),
    ).toEqual([]);
  });
});
