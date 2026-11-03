// Split provenance: test/ops/gates/workflowScan.test.ts was split by subject
// into workflowScan.{scan,reject,differential,privilege,producers,lint,headCheckout,diff,repo}.test.ts.
// This file covers privilege detection on a scanned job.
import { describe, expect, test } from 'vitest';
import { job, wf } from './workflowScan.helpers.js';

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

  test('self-repository uses are normalised like dot-relative uses', () => {
    const a = withJob(
      ['permissions: {}'],
      [
        '    steps:',
        '      - uses: $/.github/actions/setup/',
        "      - uses: '$/tools/x'",
        '      - uses: ./tools/x',
        '      - uses: actions/checkout@v5',
      ],
    );
    expect(a.localUses).toEqual(['.github/actions/setup', 'tools/x']);
    expect(withJob(['permissions: {}'], ['    uses: $/.github/workflows/w.yml']).localUses).toEqual(
      ['.github/workflows/w.yml'],
    );
  });
});
