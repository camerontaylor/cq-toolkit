// Split provenance: test/ops/gates/workflowScan.test.ts was split by subject
// into workflowScan.{scan,reject,differential,privilege,producers,lint,headCheckout,diff,repo}.test.ts.
// This file covers the parser differentials (C1/C2) that must fail closed.
import { describe, expect, test } from 'vitest';
import { lintWorkflow, scanWorkflow } from '../../../src/ops/gates/workflowScan.js';
import { job, ok, PATH, wf } from './workflowScan.helpers.js';

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
