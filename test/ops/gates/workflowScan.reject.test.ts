// Split provenance: test/ops/gates/workflowScan.test.ts was split by subject
// into workflowScan.{scan,reject,differential,privilege,producers,lint,headCheckout,diff,repo}.test.ts.
// This file covers the fail-closed rejects outside the recognised subset.
import { describe, expect, test } from 'vitest';
import { scanWorkflow } from '../../../src/ops/gates/workflowScan.js';
import { wf } from './workflowScan.helpers.js';

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
