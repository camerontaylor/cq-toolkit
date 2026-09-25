// W1.7 — the ratchet's execution provenance (ADR-0004 D-A/D-B/D-C/D-D),
// pinned over BOTH the generated workflows (.github/workflows/) and their
// source of truth (policy/templates/): the files must stay in lockstep, and
// every structural property below is asserted on both.
//
// Pinned here:
//   1. Lockstep: each generated file is the provenance header plus its
//      template, byte for byte.
//   2. The head-defined legs (cq-measure, ratchet-propose-measure) hold no
//      credential: top-level `permissions: {}`, no `secrets.*`, no
//      `environment:`.
//   3. The deciding legs (cq-verify, ratchet-propose) run from the default
//      branch (`workflow_run`), check out only the trust ref, install with
//      `--ignore-scripts`, restore no cache, and never run the test suite;
//      cq-verify's compute job (tsc over head content) holds nothing.
//   4. ratchet-propose targets merge-queue through the script, consumes the
//      measure leg's artifact, and holds its token behind `environment:`.
//   5. The legacy ratchet.yml's target/metric pairs are exactly the trust
//      manifest's (baselines/ratchets.json), and its guard runs in ref mode.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const FILES = [
  'cq-measure.yml',
  'cq-verify.yml',
  'ratchet-propose-measure.yml',
  'ratchet-propose.yml',
  'ratchet.yml',
] as const;

const template = (name: string): string =>
  readFileSync(join(ROOT, 'policy/templates', name), 'utf8');
const generated = (name: string): string =>
  readFileSync(join(ROOT, '.github/workflows', name), 'utf8');

/** Both copies of one workflow, labelled. */
const bothCopies = (name: string): Array<[string, string]> => [
  [`template ${name}`, template(name)],
  [`generated ${name}`, generated(name)],
];

/** Non-comment lines only: rationale comments may name what the code must not do. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * The job blocks under `jobs:`, keyed by job id: a job starts at a two-space
 * `<id>:` line and runs until the next one (or EOF).
 */
function jobBlocks(text: string): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'jobs:');
  if (start === -1) throw new Error('no jobs: block');
  const jobs = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m !== null) {
      if (current !== null) jobs.set(current, body.join('\n'));
      current = m[1] ?? null;
      body = [];
      continue;
    }
    body.push(line);
  }
  if (current !== null) jobs.set(current, body.join('\n'));
  return jobs;
}

/** The `on:` block (top-level, up to the next top-level key). */
function onBlock(text: string): string {
  const m = /^on:\n((?: .*\n|\n)*)/m.exec(text);
  if (m === null || m[1] === undefined) throw new Error('no on: block');
  return m[1];
}

describe('ratchet workflows: template ↔ generated lockstep', () => {
  it.each(FILES)('%s is its template plus the provenance header', (name) => {
    expect(generated(name)).toBe(
      `# instantiated from policy/templates/${name} — edit the template, not this file\n${template(name)}`,
    );
  });
});

describe('head-defined legs hold no credential (ADR-0004 D-D.5)', () => {
  it.each(['cq-measure.yml', 'ratchet-propose-measure.yml'].flatMap(bothCopies))(
    '%s: permissions {}, no secrets, no environment',
    (_label, text) => {
      const body = code(text);
      expect(body).toMatch(/^permissions: \{\}$/m);
      expect(body).not.toMatch(/secrets\./);
      expect(body).not.toMatch(/^\s*environment:/m);
      // No job re-grants a permission the top level withheld.
      for (const [id, job] of jobBlocks(body)) {
        expect(job, `${id}: job-level permissions`).not.toMatch(/^\s{4}permissions:/m);
      }
      expect(body).toMatch(/persist-credentials: false/);
    },
  );

  it.each(bothCopies('cq-measure.yml'))(
    '%s measures the PR head SHA (the verdict subject), on PRs and merge-queue pushes',
    (_label, text) => {
      const body = code(text);
      expect(body).toMatch(
        /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
      );
      const on = onBlock(body);
      expect(on).toMatch(/^ {2}pull_request:\s*$/m);
      expect(on).toMatch(/^ {2}push:\n {4}branches:\n {6}- merge-queue$/m);
      expect(on).not.toMatch(/pull_request_target|workflow_run/);
    },
  );
});

describe('deciding legs run trusted code over head data (ADR-0004 D-B, D-C, D-E)', () => {
  it.each(['cq-verify.yml', 'ratchet-propose.yml'].flatMap(bothCopies))(
    '%s: workflow_run carrier, trust-ref checkout only, --ignore-scripts, no cache, no tests',
    (_label, text) => {
      const body = code(text);
      expect(onBlock(body)).toMatch(/^ {2}workflow_run:$/m);
      expect(onBlock(body)).not.toMatch(/pull_request/);
      expect(body).toMatch(/^permissions: \{\}$/m);
      // Every checkout is the trust ref; the head is never checked out.
      const refs = [...body.matchAll(/^\s+ref: (.*)$/gm)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ref).toBe('${{ github.sha }}');
      // Installs run no lifecycle scripts; nothing restores a cache.
      for (const install of body.matchAll(/npm ci[^\n]*/g)) {
        expect(install[0]).toContain('--ignore-scripts');
      }
      expect(body).toMatch(/cache: ''/);
      expect(body).not.toMatch(/cache: npm|actions\/cache/);
      expect(body).not.toMatch(/vitest|npm test|npm run test/);
      expect(body).toMatch(/persist-credentials: false/);
    },
  );

  it.each(bothCopies('cq-verify.yml'))(
    '%s: resolve verifies the triggering run; compute holds nothing; judge posts cq/ratchet',
    (_label, text) => {
      const body = code(text);
      expect(onBlock(body)).toMatch(/workflows:\n {6}- cq-measure$/m);
      const jobs = jobBlocks(body);
      const resolveJob = jobs.get('resolve') ?? '';
      expect(resolveJob).toContain('.github/workflows/cq-measure.yml');
      expect(resolveJob).toContain('head_repository.id');
      expect(resolveJob).toContain('/commits/${subject}/pulls');
      // Dispatch is honoured only on the default ref (D-A.1).
      expect(resolveJob).toMatch(
        /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
      );
      const compute = jobs.get('compute') ?? '';
      expect(compute).toMatch(/^\s{4}permissions: \{\}$/m);
      expect(compute).toContain('ratchet.recomputeTypecheck');
      expect(compute).not.toMatch(/github\.token|GH_TOKEN|secrets\./);
      const judge = jobs.get('judge') ?? '';
      expect(judge).toContain('ratchet.verifyRatchet');
      expect(judge).toContain('name: "cq/ratchet"');
      expect(judge).toContain('external_id: $ext');
      expect(judge).not.toMatch(/ratchet\.recomputeTypecheck|tsc/);
      expect(body).not.toMatch(/secrets\./);
    },
  );

  it.each(bothCopies('ratchet-propose.yml'))(
    '%s: consumes the measure artifact, token behind environment, verifies the run',
    (_label, text) => {
      const body = code(text);
      expect(onBlock(body)).toMatch(/workflows:\n {6}- ratchet-propose-measure$/m);
      expect(onBlock(body)).toMatch(/branches:\n {6}- main$/m);
      expect(body).toMatch(/^\s{4}environment: automation$/m);
      expect(body).toContain('.github/workflows/ratchet-propose-measure.yml');
      expect(body).toMatch(/node scripts\/ratchet-propose\.mjs --measurement=/);
      expect(body).toMatch(/CQ_AUTOMATION_TOKEN: \$\{\{ secrets\.CQ_AUTOMATION_TOKEN \}\}/);
      expect(body).not.toMatch(/GITHUB_TOKEN:/);
    },
  );
});

describe('legacy ratchet.yml agrees with the trust manifest', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'baselines/ratchets.json'), 'utf8')) as {
    ratchets: Array<{ target: string; metric: string }>;
  };

  it.each(bothCopies('ratchet.yml'))(
    '%s checks exactly the manifest ratchets and guards in ref mode',
    (_label, text) => {
      const body = code(text);
      const pairs = [...body.matchAll(/--target=(\S+) \\\n\s+--metric=(\S+) \\/g)]
        .map((m) => `${m[1]}/${m[2]}`)
        .sort();
      expect(pairs).toEqual(manifest.ratchets.map((r) => `${r.target}/${r.metric}`).sort());
      expect(body).toMatch(
        /ratchet\.monotonicGuard --repo=\. --base="origin\/\$\{PR_BASE\}" --head=HEAD/,
      );
      expect(body).not.toMatch(/git diff/);
    },
  );
});
