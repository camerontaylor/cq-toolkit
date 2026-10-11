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

it('leaves credential checks to the runner so a missing credential still yields BLOCKED evidence', () => {
  // A credential guard before the runner would exit with no evidence file;
  // the runner's preflight records the same failure per row (Codex P2, #247).
  // The one allowed credential reference before the runner step is the
  // scratch App mint (ADR-0004 note N19): it is variable-gated, so a missing
  // App skips it and the runner still runs and records BLOCKED evidence.
  for (const path of [
    'policy/templates/adversarial-suite.yml',
    '.github/workflows/adversarial-suite.yml',
  ]) {
    const text = readFileSync(resolve(path), 'utf8');
    expect(text, path).toContain('node scripts/adversarial-suite.mjs');
    const runnerStep = text.indexOf('      - name: Apply and verify scratch profile');
    expect(runnerStep, path).toBeGreaterThan(0);
    const beforeRunner = text.slice(text.indexOf('    steps:'), runnerStep);
    const mintStart = beforeRunner.indexOf('      - name: Mint the scratch App token');
    expect(mintStart, path).toBeGreaterThan(0);
    const nextStep = beforeRunner.indexOf('      - name:', mintStart + 1);
    const mint =
      nextStep === -1 ? beforeRunner.slice(mintStart) : beforeRunner.slice(mintStart, nextStep);
    expect(mint, path).toContain('uses: actions/create-github-app-token@');
    expect(mint, path).toContain("if: vars.CQ_ADVERSARIAL_APP_CLIENT_ID != ''");
    expect(mint, path).toContain('private-key: ${{ secrets.CQ_ADVERSARIAL_APP_KEY }}');
    expect(mint, path).toContain('continue-on-error: true');
    // No permission-* inputs at all: `variables` is not in the GitHub
    // app-permissions API schema, so the token must INHERIT the
    // cq-adversarial-scratch App installation's own grants (registered
    // with exactly Variables rw + Environments read) instead of naming
    // them here.
    expect(mint, path).not.toMatch(/^\s+permission-[\w-]+:/m);
    expect(mint, path).not.toMatch(/GH_TOKEN|gh api/);
    const rest =
      nextStep === -1
        ? beforeRunner.slice(0, mintStart)
        : beforeRunner.slice(0, mintStart) + beforeRunner.slice(nextStep);
    expect(rest, path).not.toMatch(/GH_TOKEN|secrets\.|gh api/);
    // The runner consumes the minted token with the interim PAT as fallback
    // only while the App is unregistered; an armed-but-failed mint yields an
    // empty token whose preflight records BLOCKED evidence (Codex P2).
    expect(text, path).toContain(
      "CQ_ADVERSARIAL_PROFILE_TOKEN: ${{ steps.adversarial-app.outputs.token || (vars.CQ_ADVERSARIAL_APP_CLIENT_ID == '' && secrets.CQ_ADVERSARIAL_PROFILE_TOKEN) || '' }}",
    );
  }
});
