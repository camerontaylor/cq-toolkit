// The `cq-state` settle-ledger skip guards (review-debt #226).
//
// Pushes to the machine-written `cq-state` branch used to fire the
// unfiltered push workflows (ci, denylist, ratchet) — wasted runner time on
// a branch that carries no reviewable change. The I4-sanctioned fix is a
// JOB-LEVEL `if:` (never a trigger filter: the `on:` block of a required
// workflow stays unfiltered — that is the denylist-scan's I4 leg, unchanged
// here), pinned per file in this test so a regeneration cannot drop it.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STATE_BRANCH } from '../../src/selfhost/state-branch.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Built from the owned constant (PR #234 r1), not a 'cq-state' literal:
// the YAML files spell the branch out, so a STATE_BRANCH rename must fail
// HERE — a hardcoded literal would let a rename silently disable every
// guard with no failing test.
const SKIP = `if: \${{ github.ref != 'refs/heads/${STATE_BRANCH}' }}`;

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** The job blocks under `jobs:`, keyed by job id (two-space `<id>:` lines). */
function jobIds(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  if (start === -1) throw new Error('no jobs: block');
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A non-indented, non-empty line is the next TOP-LEVEL key — the jobs
    // block is over, and nothing below it can be read as a job id
    // (PR #234 r1).
    if (/^\S/.test(line)) break;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m !== null && m[1] !== undefined) ids.push(m[1]);
  }
  return ids;
}

/** Every job id in `text` carries the job-level cq-state skip guard. */
function expectEveryJobGuarded(text: string, file: string): void {
  const jobs = jobIds(text);
  expect(jobs.length, `${file} declares jobs`).toBeGreaterThan(0);
  // The guard must sit at the JOB-KEY indent (four spaces — a direct key of
  // `  <id>:`), so a STEP-level `if:` deeper in the block cannot satisfy it
  // (CodeRabbit cycle 2). Exact-element match on the block's lines.
  const jobLevelGuard = `    ${SKIP}`;
  for (const id of jobs) {
    // The job's block runs from its id line to the next job (or EOF).
    const lines = text.split('\n');
    const start = lines.indexOf('jobs:') + 1;
    const idLine = lines.findIndex((line, i) => i >= start && line === `  ${id}:`);
    const next = lines.findIndex((line, i) => i > idLine && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
    const blockLines = lines.slice(idLine, next === -1 ? lines.length : next);
    expect(
      blockLines,
      `${file} job ${id} carries the cq-state skip at JOB-KEY indentation`,
    ).toContain(jobLevelGuard);
  }
}

describe('the cq-state skip guards (review-debt #226)', () => {
  it.each([
    '.github/workflows/ci.yml',
    '.github/workflows/denylist.yml',
    '.github/workflows/ratchet.yml',
  ])('every job in %s skips the cq-state ledger branch at the JOB level', (file) => {
    expectEveryJobGuarded(read(file), file);
  });

  it('the required-check pattern carries the guard in its worked example', () => {
    const doc = read('policy/templates/required-check.md');
    // The worked example's fenced YAML block, pinned exactly like ci.yml
    // (PR #234 r1): a step-level guard in the template doc must fail this,
    // not pass a bare substring check.
    const open = doc.indexOf('```yaml');
    const yaml = doc.slice(open, doc.indexOf('```', open + 7));
    expectEveryJobGuarded(yaml, 'policy/templates/required-check.md worked example');
    // The template teaches the rule the guard obeys: the `on:` block of the
    // worked example stays filter-free.
    expect(yaml).toMatch(/on:\n {2}push:\n {2}pull_request:\n/);
  });

  it('the ratchet TEMPLATE carries the guard too (the instance is generated from it)', () => {
    expectEveryJobGuarded(read('policy/templates/ratchet.yml'), 'policy/templates/ratchet.yml');
  });
});
