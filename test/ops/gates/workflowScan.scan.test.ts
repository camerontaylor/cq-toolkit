// W1.9 (D11) — the conservative workflow scanner. These tests pin the
// fail-closed direction: every construct outside the recognised subset is
// `ok: false` (needs-human at the caller), every privilege signal fires on
// its own, and change detection ignores only comments and blank lines. The
// repo's own workflows must all scan, so the scanner never makes a routine
// workflow edit unreviewable by accident.
//
// Split provenance: test/ops/gates/workflowScan.test.ts was split by subject.
// Siblings: workflowScan.{reject,differential,privilege,producers,lint,headCheckout,diff,repo}.test.ts
// and the shared fixtures in workflowScan.helpers.ts. This file covers the
// recognised subset itself.
import { describe, expect, test } from 'vitest';
import { isWorkflowPath } from '../../../src/ops/gates/workflowScan.js';
import { job, ok, READ_ONLY, wf } from './workflowScan.helpers.js';

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
