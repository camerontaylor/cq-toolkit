import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { POLICY_LIST_PATH, createPolicyDiff } from '../../../src/ops/gates/policyDiff.js';
import { bindD11Authorization } from '../../../src/ops/gates/d11Authorization.js';
import {
  HOOK_MS,
  SLOW,
  CI,
  CI_PATH,
  DEPLOY_PATH,
  MATRIX_PATH,
  POLICY,
  trust,
  edit,
  importCommits,
  kinds,
  repo,
  run,
  setupFixtures,
  teardownFixtures,
  verdicts,
  type Spec,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('policyDiff: workflows', SLOW, () => {
  const PRIVILEGE: readonly (readonly [string, string])[] = [
    ['permissions write', '    permissions:\n      contents: write\n'],
    ['a secret', '    env:\n      KEY: ${{ secrets.DEPLOY_KEY }}\n'],
    ['an environment', '    environment: prod\n'],
  ];
  const RUNS_ON = '    runs-on: ubuntu-latest\n';
  let c: Record<string, string>;
  beforeAll(() => {
    const specs: Record<string, Spec> = {
      'missing-job-trust': {
        files: {
          [POLICY_LIST_PATH]: JSON.stringify({
            ...POLICY,
            requiredJobs: { 'ci.yml': ['static', 'smoke'] },
          }),
        },
      },
      'subject-required-jobs': {
        files: {
          [POLICY_LIST_PATH]: JSON.stringify({
            ...POLICY,
            requiredJobs: { 'ci.yml': ['static', 'smoke'] },
          }),
          [CI_PATH]: edit(CI_PATH, '# lint the tree', '# lint the whole tree'),
        },
      },
      'new-wf': { files: { '.github/workflows/new.yml': CI } },
      trigger: {
        files: { [CI_PATH]: edit(CI_PATH, '  pull_request:\n', '  pull_request:\n  push:\n') },
      },
      'priv-edit': {
        files: { [DEPLOY_PATH]: edit(DEPLOY_PATH, 'echo deploy', 'echo deploy now') },
      },
      comment: { files: { [CI_PATH]: edit(CI_PATH, '# lint the tree', '# lint the whole tree') } },
      'producer-if': {
        files: { [CI_PATH]: edit(CI_PATH, RUNS_ON, `${RUNS_ON}    if: false\n`) },
      },
      'producer-step': {
        files: { [CI_PATH]: edit(CI_PATH, 'npm run lint', 'npm run lint -- --quiet') },
      },
      'producer-context': {
        files: { [CI_PATH]: edit(CI_PATH, 'permissions:\n', 'env:\n  CI: "1"\npermissions:\n') },
      },
      rename: { files: { [CI_PATH]: edit(CI_PATH, '  static:\n', '  lint:\n') } },
      'phantom-job': {
        files: {
          [CI_PATH]: `${CI}  shadow:\n    name: static\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n`,
        },
      },
      'matrix-edit': {
        files: { [MATRIX_PATH]: edit(MATRIX_PATH, 'npm run build', 'npm run build -- --fast') },
      },
      'dynamic-name': {
        files: {
          [CI_PATH]: `${CI}  dyn:\n    name: \${{ github.event_name }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n`,
        },
      },
      lint: {
        files: {
          [CI_PATH]: edit(
            CI_PATH,
            '      - run: npm run lint\n',
            '      - uses: actions/checkout@v5\n        with:\n          persist-credentials: true\n      - run: npm run lint\n',
          ),
        },
      },
      unparseable: { files: { [CI_PATH]: edit(CI_PATH, 'jobs:\n', 'x: &anchor 1\njobs:\n') } },
      symlink: { files: {}, symlinks: { '.github/workflows/link.yml': 'ci.yml' } },
      'local-action': {
        files: { 'actions/setup/action.yml': 'runs:\n  using: composite\n  steps: [] # x\n' },
      },
    };
    for (const [why, block] of PRIVILEGE) {
      specs[`priv-${why.replace(/ /g, '-')}`] = {
        files: { [CI_PATH]: edit(CI_PATH, RUNS_ON, `${RUNS_ON}${block}`) },
      };
    }
    c = importCommits(repo, specs);
  }, HOOK_MS);

  test('a new workflow needs a human; a copied producer is a phantom producer', async () => {
    const out = await run(c['new-wf']!, 'diff-check');
    expect(kinds(out)).toEqual(['protected-path', 'required-check', 'workflow-new']);
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: '.github/workflows/new.yml',
      reason: 'adds a producer of required check static (.github/workflows/new.yml:static)',
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a new same-name job in an existing workflow is a phantom producer', async () => {
    const out = await run(c['phantom-job']!, 'diff-check');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: CI_PATH, reason: 'changes a protected path' },
      {
        kind: 'required-check',
        path: CI_PATH,
        reason: `adds a producer of required check static (${CI_PATH}:shadow)`,
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test('a required check with no resolvable producer fails closed when a matrix producer changes', async () => {
    const out = await run(c['matrix-edit']!, 'diff-check');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: MATRIX_PATH, reason: 'changes a protected path' },
      {
        kind: 'required-check',
        path: MATRIX_PATH,
        reason: `producer of required check build unresolvable; ${MATRIX_PATH} changed`,
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test('...or when a changed workflow gains a dynamically named job', async () => {
    const out = await run(c['dynamic-name']!, 'diff-check');
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: CI_PATH,
      reason: `producer of required check build unresolvable; ${CI_PATH} changed`,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a trigger change needs a human (and is not also a producer change)', async () => {
    const out = await run(c['trigger']!, 'diff-check');
    expect(kinds(out)).toEqual(['protected-path', 'trigger-changed']);
    expect(out.verdict).toBe('needs-human');
  });

  test.each(PRIVILEGE)('a job made privileged by %s needs a human', async (why) => {
    const out = await run(c[`priv-${why.replace(/ /g, '-')}`]!, 'diff-check');
    expect(kinds(out)).toContain('privileged-job');
    expect(out.verdict).toBe('needs-human');
  });

  test('an edit to an already-privileged job needs a human', async () => {
    const out = await run(c['priv-edit']!, 'diff-check');
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'privileged-job', path: DEPLOY_PATH }),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('a comment-only edit to the producer workflow passes under diff-check', async () => {
    expect(kinds(await run(c['comment']!))).toEqual(['protected-path']);
    expect(await verdicts(c['comment']!)).toEqual({ human: 'needs-human', 'diff-check': 'pass' });
  });

  test.each([
    ['producer-if', 'job static changed'],
    ['producer-step', 'job static changed'],
    ['producer-context', 'workflow-level context changed'],
  ])('a changed producer (%s) needs a human', async (name, detail) => {
    const out = await run(c[name]!, 'diff-check');
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: CI_PATH,
      reason: `changes the producer of required check static (${detail})`,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('renaming the job that produces a required check needs a human', async () => {
    const out = await run(c['rename']!, 'diff-check');
    expect(out.findings).toEqual(
      expect.arrayContaining([
        { kind: 'required-check', path: CI_PATH, reason: 'removed required check static' },
        {
          kind: 'required-check',
          path: CI_PATH,
          reason: 'changes the producer of required check static (job static removed)',
        },
      ]),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('a lint violation fails, even under `human` (fail beats needs-human)', async () => {
    const out = await run(c['lint']!, 'human');
    expect(kinds(out)).toContain('lint');
    expect(await verdicts(c['lint']!)).toEqual({ human: 'fail', 'diff-check': 'fail' });
    expect(out.report.at(-1)).toBe('verdict: fail');
  });

  test('advisory: a lint violation still fails, and its line is never an annotation', async () => {
    const out = await run(c['lint']!, 'advisory');
    expect(out.verdict).toBe('fail');
    expect(out.report.some((line) => line.startsWith('lint: '))).toBe(true);
    expect(out.report.some((line) => line.startsWith('advisory: lint'))).toBe(false);
    expect(out.report.at(-1)).toBe('verdict: fail');
  });

  test('advisory: workflow, privileged-job and required-check findings are annotations', async () => {
    const trigger = await run(c['trigger']!, 'advisory');
    expect(trigger.verdict).toBe('pass');
    expect(trigger.report.some((line) => line.startsWith('advisory: trigger-changed: '))).toBe(
      true,
    );
    const priv = await run(c['priv-edit']!, 'advisory');
    expect(priv.verdict).toBe('pass');
    expect(priv.report.some((line) => line.startsWith('advisory: privileged-job: '))).toBe(true);
    const renamed = await run(c['rename']!, 'advisory');
    expect(renamed.verdict).toBe('pass');
    expect(renamed.report).toContain(
      `advisory: required-check: ${CI_PATH} — removed required check static`,
    );
  });

  test('a D11 authorization covering every path never turns a lint fail into a pass', async () => {
    const plain = await run(c['lint']!, 'human');
    const auth = bindD11Authorization({
      ownerId: 1,
      attestation: {
        state: 'present',
        text: JSON.stringify({
          schemaVersion: 1,
          attests: 'C3',
          attestedAt: '2026-09-20T00:00:00Z',
        }),
      },
      prs: [
        {
          pr: 1,
          merge: 'c'.repeat(40),
          head: c['lint']!,
          paths: plain.findings.map((f) => f.path),
          events: [
            {
              event: 'labeled',
              label: { name: 'cq-override' },
              actor: { login: 'owner', id: 1, type: 'User' },
              created_at: '2026-09-20T11:00:00Z',
              performed_via_github_app: null,
            },
          ],
          headObservedAt: '2026-09-20T10:00:00.000Z',
        },
      ],
    });
    expect(auth.contributions[0]?.record.status).toBe('honoured');
    const out = await run(c['lint']!, 'human', {
      subjectKind: 'push',
      base: 'main',
      authorization: auth,
    });
    expect(out.verdict).toBe('fail');
    expect(out.d11).toBeUndefined();
  });

  test('an unparseable workflow fails closed to needs-human', async () => {
    const out = await run(c['unparseable']!, 'diff-check');
    expect(kinds(out)).toContain('workflow-unparseable');
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: CI_PATH,
      reason: 'changes the producer of required check static (workflow unparseable at the subject)',
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a changed workflow path that is a regular file at neither end fails closed', async () => {
    const out = await run(c['symlink']!, 'diff-check');
    expect(out.findings).toContainEqual({
      kind: 'workflow-unparseable',
      path: '.github/workflows/link.yml',
      reason: 'changed workflow path is not a regular file at either end',
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a changed local action used by a privileged job needs a human', async () => {
    const out = await run(c['local-action']!, 'diff-check');
    expect(out.findings).toEqual([
      {
        kind: 'privileged-job',
        path: 'actions/setup/action.yml',
        reason: `changes actions/setup/action.yml used by privileged job ${DEPLOY_PATH}:deploy`,
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test('missing required jobs are findings and requiredJobs come from the trust ref', async () => {
    const judge = async (trustRef: string, subject: string) => {
      const result = await createPolicyDiff({ posture: 'diff-check', layer: 'env' })({
        repo,
        trustRef,
        subject,
        subjectKind: 'pr',
        base: 'merge-queue',
      });
      if (result.status !== 'ok') throw new Error(JSON.stringify(result));
      return result.value;
    };
    const control = await judge(trust, c['comment']!);
    expect(control.verdict).toBe('pass');
    const out = await judge(c['missing-job-trust']!, c['comment']!);
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: CI_PATH,
      reason: 'no statically named required job smoke',
    });
    expect(out.verdict).toBe('needs-human');
    expect(out.requiredJobs).toEqual({ 'ci.yml': ['static', 'smoke'] });

    const subjectOnly = await judge(trust, c['subject-required-jobs']!);
    expect(subjectOnly.requiredJobs).toEqual({ 'ci.yml': ['static'] });
    expect(subjectOnly.findings).not.toContainEqual({
      kind: 'required-check',
      path: CI_PATH,
      reason: 'no statically named required job smoke',
    });
  });
});
