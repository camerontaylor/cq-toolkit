import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPaths, selectChecks } from '../../scripts/ci-select-checks.mjs';

const full = { typescript: true, python: true };
describe('coarse CI selection', () => {
  it.each([
    [['README.md', 'docs/design.md'], { typescript: false, python: false }],
    [['apps/crq-python/status.py'], { typescript: false, python: true }],
    [['docs/design.md', 'apps/crq-python/test_status.py'], { typescript: false, python: true }],
    [['src/index.ts'], { typescript: true, python: false }],
    [['src/policy/crq/pythonJson.ts'], full],
    [['test/policy/crq/vectors.test.ts'], full],
    [['src/ops/crq/runner.ts'], full],
    [['src/ops/dev/coderabbit.ts'], full],
    [['test/ops/dev/coderabbit.test.ts'], full],
    [['src/policy/other.ts'], { typescript: true, python: false }],
    [['test/unit.ts', 'apps/crq-python/status.py'], full],
    [['docs/ops/example.md'], full],
    [['docs/config.md'], full],
    [['.cq/config.md'], full],
    [['pnpm-lock.yaml'], full],
    [['.github/workflows/ci.yml'], full],
    [['policy/templates/required-check.md'], full],
    [['unknown.md'], full],
    [[], full],
  ])('classifies %j', (paths, expected) => {
    expect(classifyPaths(paths)).toEqual(expected);
  });

  it('runs full on main, schedule, dispatch, invalid SHAs, and unavailable git objects', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'pull_request']) {
      expect(selectChecks({ event, base: '', head: '' })).toEqual(full);
    }
    expect(
      selectChecks({ event: 'pull_request', base: 'a'.repeat(40), head: 'b'.repeat(40) }),
    ).toEqual(full);
  });

  it('uses the PR merge base and treats moved source as deleted source plus new prose', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cq-ci-selection-'));
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    writeFileSync(join(cwd, 'README.md'), 'base');
    git('add', '.');
    git('commit', '-qm', 'base');
    const ancestor = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'pr');
    mkdirSync(join(cwd, 'docs'));
    writeFileSync(join(cwd, 'docs/prose.md'), 'PR prose');
    git('add', '.');
    git('commit', '-qm', 'prose');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'base-advanced', ancestor);
    writeFileSync(join(cwd, 'unknown'), 'base only');
    git('add', '.');
    git('commit', '-qm', 'base advanced');
    const base = git('rev-parse', 'HEAD');
    expect(selectChecks({ event: 'pull_request', base, head, cwd })).toEqual({
      typescript: false,
      python: false,
    });
    git('checkout', '-q', 'pr');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/index.ts'), 'export {};');
    git('add', '.');
    git('commit', '-qm', 'source');
    const sourceBase = git('rev-parse', 'HEAD');
    git('mv', 'src/index.ts', 'docs/moved.md');
    git('commit', '-qm', 'move');
    expect(
      selectChecks({
        event: 'pull_request',
        base: sourceBase,
        head: git('rev-parse', 'HEAD'),
        cwd,
      }),
    ).toEqual({ typescript: true, python: false });
  });
});
