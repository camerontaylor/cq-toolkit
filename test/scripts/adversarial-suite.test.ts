import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const runner = resolve('scripts/adversarial-suite.mjs');
const directories: string[] = [];
const firstToken = 'adversarial-primary-secret-marker';
const secondToken = 'adversarial-second-secret-marker';

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function run(repo: string, rows: string, tokens: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cq-adversarial-test-'));
  directories.push(directory);
  const result = spawnSync(
    process.execPath,
    [runner, `--repo=${repo}`, '--profile=blank', `--rows=${rows}`],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: '', CQ_ADVERSARIAL_SECOND_TOKEN: '', ...tokens },
    },
  );
  const artifact = join(directory, 'artifacts/adversarial-suite/evidence-blank.json');
  return { result, artifact };
}

it('rejects a production target before writing evidence or making an API request', () => {
  const { result, artifact } = run('camerontaylor/cq-toolkit', 'A1', {
    GH_TOKEN: firstToken,
    CQ_ADVERSARIAL_SECOND_TOKEN: secondToken,
  });
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Refusing target other than');
  expect(() => readFileSync(artifact)).toThrow();
});

it('records missing credentials and dependency rows as BLOCKED without leaking tokens', () => {
  const { result, artifact } = run(
    'camerontaylor/cq-scratch-v11-adversarial',
    'A1,A12,A13,A18,A19',
  );
  expect(result.status).toBe(3);
  const raw = readFileSync(artifact, 'utf8');
  const evidence = JSON.parse(raw) as {
    rows: { id: string; status: string; attackExecuted: boolean; reason: string }[];
  };
  expect(evidence.rows).toHaveLength(5);
  const summary = JSON.parse(result.stdout) as { evidence: string; rows: unknown[] };
  expect(summary.evidence).toMatch(/evidence-blank\.json$/);
  expect(summary.rows).toEqual(evidence.rows.map(({ id }) => ({ id, status: 'BLOCKED' })));
  expect(evidence.rows.every((row) => row.status === 'BLOCKED' && !row.attackExecuted)).toBe(true);
  expect(evidence.rows.find((row) => row.id === 'A1')?.reason).toContain('Missing GH_TOKEN');
  for (const id of ['A12', 'A13', 'A18', 'A19']) {
    expect(evidence.rows.find((row) => row.id === id)?.reason).toContain('Prerequisite incomplete');
  }
  expect(raw).not.toContain(firstToken);
  expect(raw).not.toContain(secondToken);
});

it('rejects one token reused for both identities without writing the token to evidence', () => {
  const { result, artifact } = run('camerontaylor/cq-scratch-v11-adversarial', 'A1', {
    GH_TOKEN: firstToken,
    CQ_ADVERSARIAL_SECOND_TOKEN: firstToken,
  });
  expect(result.status).toBe(3);
  const raw = readFileSync(artifact, 'utf8');
  expect(raw).toContain('tokens are identical');
  expect(raw).not.toContain(firstToken);
  expect(raw).not.toContain(secondToken);
});

it('rejects an unsupported option such as --row instead of defaulting to every row', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cq-adversarial-test-'));
  directories.push(directory);
  const result = spawnSync(
    process.execPath,
    [runner, '--repo=camerontaylor/cq-scratch-v11-adversarial', '--profile=blank', '--row=A15'],
    { cwd: directory, encoding: 'utf8', env: { ...process.env, GH_TOKEN: '' } },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Unsupported option: --row');
  expect(result.stdout).toBe('');
});
