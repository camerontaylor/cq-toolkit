// Split provenance: test/ops/gates/workflowScan.test.ts was split by subject
// into workflowScan.{scan,reject,differential,privilege,producers,lint,headCheckout,diff,repo}.test.ts.
// This file covers diffWorkflow change detection.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { diffWorkflow } from '../../../src/ops/gates/workflowScan.js';
import { kinds, PATH, READ_ONLY, wf, WORKFLOW_DIR } from './workflowScan.helpers.js';

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
