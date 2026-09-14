// Slice C — the merge-queue gate's fail-closed mechanics, tested over BOTH
// the generated workflow (.github/workflows/merge-queue-gate.yml) and its
// source of truth (policy/templates/merge-queue-gate.yml): the files must
// stay in lockstep, so every extracted program and every textual assertion
// runs against both.
//
// Pinned here:
//   1. The awk verdict program (extracted verbatim from each file and run as
//      a real `awk -f` program): exact verdict strings for the whole matrix —
//      pass requires EVERY matching row completed+success; a terminal
//      failure outranks waiting; a terminal `skipped` is neither pass nor
//      fail (I4: a skipped required check is missing, and missing = failing)
//      and outranks waiting but never failure; no rows at all -> missing.
//   2. The fail-closed empty-checks guard (extracted verbatim): an empty
//      check list must exit 1 with the refusing message BEFORE the wait loop
//      can spin zero times and promote; a populated list passes the guard
//      (positive control, exit 0) in both files.
//   3. The promotion text: the merge-queue-tip guard, the skipped case
//      branch, and a checkout pinned to exactly 40 lowercase hex chars.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const GATE_FILES = [
  { label: 'generated', path: join(ROOT, '.github/workflows/merge-queue-gate.yml') },
  { label: 'template', path: join(ROOT, 'policy/templates/merge-queue-gate.yml') },
];

// The awk verdict program: everything after the line assigning it via
// `awk -F'\t'`, up to (not including) the closing `')"` line, joined with \n.
function extractAwkProgram(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("awk -F'\\t'"));
  if (start === -1) throw new Error('no awk verdict program found');
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && lines[i].trim() !== '\')"'; i++) {
    body.push(lines[i]);
  }
  if (body.length === 0) throw new Error('empty awk verdict program');
  return body.join('\n');
}

// The fail-closed guard: the `checks="$(echo ...)"` line plus the six lines
// after it (two comment lines, if, echo, exit, fi).
function extractFailClosedSnippet(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('checks="$(echo'));
  if (start === -1) throw new Error('no checks= line found');
  return lines.slice(start, start + 7).join('\n');
}

// One gate's check list is quoted differently per file ('static,denylist'
// generated, '{{GATE_CHECKS}}' template); normalize it so one snippet runner
// serves both. Plain string surgery (no regex: a literal `$(` inside a
// RegExp literal is an end-of-input anchor, and escaping it trips
// no-useless-escape), then wrap with set -euo pipefail like the real step.
function scriptFor(text: string, list: string): string {
  const snippet = extractFailClosedSnippet(text);
  const marker = `checks="$(echo '`;
  const start = snippet.indexOf(marker);
  if (start === -1) throw new Error('checks= echo list not found');
  const close = snippet.indexOf(`'`, start + marker.length);
  if (close === -1) throw new Error('checks= echo list is unterminated');
  const substituted = `${snippet.slice(0, start + marker.length)}${list}${snippet.slice(close)}`;
  return `set -euo pipefail\n${substituted}\n`;
}

// The verdict matrix: @tsv rows ([name, status, conclusion]) in, exact
// verdict string out (the string the workflow's case statement receives).
const VERDICT_CASES: ReadonlyArray<{ name: string; rows: string; expected: string }> = [
  { name: 'two suites, both green -> pass', rows: 'static\tcompleted\tsuccess\nstatic\tcompleted\tsuccess', expected: 'pass' },
  { name: 'no rows -> missing', rows: '', expected: 'missing' },
  { name: 'incomplete row -> waiting in_progress', rows: 'static\tin_progress\t', expected: 'waiting in_progress' },
  { name: 'terminal failure -> failing failure', rows: 'static\tcompleted\tfailure', expected: 'failing failure' },
  { name: 'skipped is neither pass nor fail -> skipped skipped (I4)', rows: 'static\tcompleted\tskipped', expected: 'skipped skipped' },
  { name: 'terminal failure outranks skipped', rows: 'static\tcompleted\tfailure\nstatic\tcompleted\tskipped', expected: 'failing failure' },
  { name: 'terminal skipped outranks waiting', rows: 'static\tin_progress\t\nstatic\tcompleted\tskipped', expected: 'skipped skipped' },
  { name: 'pass requires EVERY row success', rows: 'static\tcompleted\tsuccess\nstatic\tin_progress\t', expected: 'waiting in_progress' },
  { name: 'success beside skipped -> skipped skipped', rows: 'static\tcompleted\tsuccess\nstatic\tcompleted\tskipped', expected: 'skipped skipped' },
];

describe('merge-queue-gate: fail-closed mechanics (generated file and template in lockstep)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gate-mechanics-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const gates = GATE_FILES.map(({ label, path }) => {
    const text = readFileSync(path, 'utf8');
    const progFile = join(tmp, `verdict-${label}.awk`);
    writeFileSync(progFile, extractAwkProgram(text)); // written once per file
    return { label, text, progFile };
  });

  // Identity lockstep: the behavioral matrix below can only catch drift the
  // cases exercise — these string-identity checks catch ALL drift.
  it('extracted program and guard snippet are byte-identical across the files', () => {
    const [generated, template] = gates;
    expect(
      extractAwkProgram(generated.text),
      'the files drifted outside the behavioral cases: the awk verdict program',
    ).toBe(extractAwkProgram(template.text));
    // Each file quotes its check list differently ('static,denylist'
    // generated, '{{GATE_CHECKS}}' template) and names the subject of the
    // guard comment differently ('an empty {{GATE_CHECKS}}' template,
    // 'an empty gate wait list' generated) — the two sanctioned
    // token-level divergences of the instantiation. Normalize both to
    // placeholders before comparing; ANY other drift still fails.
    const normalize = (text: string): string =>
      extractFailClosedSnippet(text)
        .replace(`'static,denylist'`, `'<LIST>'`)
        .replace(`'{{GATE_CHECKS}}'`, `'<LIST>'`)
        .replace(`an empty {{GATE_CHECKS}}:`, `an empty <SUBJECT>:`)
        .replace(`an empty gate wait list:`, `an empty <SUBJECT>:`);
    expect(
      normalize(generated.text),
      'the files drifted outside the behavioral cases: the fail-closed guard snippet',
    ).toBe(normalize(template.text));
  });

  // 18 real awk spawns (2 programs x 9 cases); a macOS awk cold start costs
  // ~0.5-1s each, so this needs a generous timeout like the ratchet sandbox
  // tests that spawn tsc.
  it('runs the exact verdict matrix through both files\u2019 awk programs', { timeout: 120_000 }, () => {
    for (const { label, progFile } of gates) {
      for (const testCase of VERDICT_CASES) {
        const verdict = execFileSync('awk', ['-F', '\t', '-v', 'c=static', '-f', progFile], {
          input: testCase.rows,
          encoding: 'utf8',
        }).trim();
        expect(verdict, `${label}: ${testCase.name}`).toBe(testCase.expected);
      }
    }
  });

  describe('fail-closed empty-checks guard', () => {
    for (const { label, text } of gates) {
      it(`refuses an empty check list with exit 1 before any waiting (${label})`, () => {
        const script = join(tmp, `empty-${label}.sh`);
        writeFileSync(script, scriptFor(text, ''));
        const res = spawnSync('bash', [script], { encoding: 'utf8' });
        const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
        expect(res.status, output).toBe(1);
        expect(output).toContain('refusing: GATE_CHECKS is empty');
      });

      it(`positive control: a populated check list passes the guard with exit 0 (${label})`, () => {
        const script = join(tmp, `populated-${label}.sh`);
        writeFileSync(script, scriptFor(text, 'static,denylist'));
        const res = spawnSync('bash', [script], { encoding: 'utf8' });
        expect(res.status, `${res.stdout ?? ''}${res.stderr ?? ''}`).toBe(0);
      });
    }
  });

  describe('promotion guard, skipped refusal, and the immutable checkout pin', () => {
    for (const { label, text } of gates) {
      it(`carries the tip guard, the skipped case branch, and a 40-hex checkout pin (${label})`, () => {
        expect(text, `${label}: the merge-queue-tip guard`).toContain('is not the current merge-queue tip');
        expect(text, `${label}: the skipped case branch`).toContain('concluded skipped');
        const checkoutLines = text.split(/\r?\n/).filter((line) => line.includes('uses: actions/checkout@'));
        expect(checkoutLines.length, `${label}: at least one checkout step`).toBeGreaterThanOrEqual(1);
        for (const line of checkoutLines) {
          const ref = /uses: actions\/checkout@([^@\s]+)/.exec(line)?.[1] ?? '';
          expect(ref, `${label}: checkout pin must be exactly 40 lowercase hex chars: ${line.trim()}`).toMatch(/^[0-9a-f]{40}$/);
        }
      });
    }
  });
});
