// Split provenance: test/ops/gates/workflowScan.test.ts was split by subject
// into workflowScan.{scan,reject,differential,privilege,producers,lint,headCheckout,diff,repo}.test.ts.
// This file covers producersOf job-name resolution.
import { describe, expect, test } from 'vitest';
import { producersOf } from '../../../src/ops/gates/workflowScan.js';
import { ok, wf } from './workflowScan.helpers.js';

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
