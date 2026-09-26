// W1.7 — the ratchet's execution provenance (ADR-0004 D-A/D-B/D-C/D-D),
// pinned over BOTH the generated workflows (.github/workflows/) and their
// source of truth (policy/templates/): the files must stay in lockstep, and
// every structural property below is asserted on both.
//
// Pinned here:
//   1. Lockstep: each generated file is the provenance header plus its
//      template, byte for byte.
//   2. The head-defined legs (cq-measure, ratchet-propose-measure) fetch with
//      read-only access without executing head code, then run head code in
//      separate credential-free jobs.
//   3. The deciding legs (cq-verify, ratchet-propose) run from the default
//      branch (`workflow_run`), check out only the trust ref, install with
//      `--ignore-scripts`, restore no cache, and never run the test suite;
//      cq-verify's compute job (tsc over head content) holds nothing.
//   4. ratchet-propose targets merge-queue through the script, consumes the
//      measure leg's artifact, and holds its token behind `environment:`.
//   5. The legacy ratchet.yml's target/metric pairs are exactly the trust
//      manifest's (baselines/ratchets.json), and its guard runs in ref mode.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('head code runs only in credential-free measurement jobs (ADR-0004 D-D.5)', () => {
  it.each(['cq-measure.yml', 'ratchet-propose-measure.yml'].flatMap(bothCopies))(
    '%s: read-only source fetch is separate from credential-free measurement',
    (_label, text) => {
      const body = code(text);
      expect(body).toMatch(/^permissions: \{\}$/m);
      expect(body).not.toMatch(/secrets\./);
      expect(body).not.toMatch(/^\s*environment:/m);
      const jobs = jobBlocks(body);
      expect([...jobs.keys()]).toEqual(['fetch', 'measure']);
      const fetch = jobs.get('fetch') ?? '';
      expect(fetch).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
      expect(fetch).toMatch(/fetch-depth: 0/);
      expect(fetch).toMatch(/persist-credentials: false/);
      expect(fetch).toContain('git bundle create');
      expect(fetch).toContain('actions/upload-artifact@');
      expect(fetch).not.toMatch(/npm ci|npm run|vitest|ratchet\.recomputeTypecheck/);
      const measure = jobs.get('measure') ?? '';
      expect(measure).toMatch(/^ {4}needs: fetch$/m);
      expect(measure).not.toMatch(/^ {4}permissions:/m);
      expect(measure).toContain('actions/download-artifact@');
      expect(measure).toContain('git checkout --detach "$SUBJECT"');
      expect(measure).not.toMatch(/actions\/checkout@|github\.token|GH_TOKEN/);
      expect(measure).toMatch(/npm ci/);
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
    (label, text) => {
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
      if (label.includes('cq-verify')) {
        // Fetch and judge retain a read-only token only while running trust
        // code or handling git objects; neither checks out the head.
        expect(body).toMatch(/persist-credentials: true/);
      } else {
        expect(body).toMatch(/persist-credentials: false/);
      }
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
      // Dispatch is honoured only on the default ref (D-A.1). Whitespace is
      // tolerant: no line in the workflow exceeds 80 columns, so this
      // expression is folded across continuation lines.
      expect(resolveJob).toMatch(
        /github\.ref ==\s*format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
      );
      // A head with open PRs into both branches must be judged against the
      // merge-queue target, regardless of API array order.
      expect(resolveJob).toMatch(
        /if index\(\\"merge-queue\\"\) then \\"merge-queue\\"\s*elif index\(\\"main\\"\) then \\"main\\"\s*else empty end/,
      );
      const fetch = jobs.get('fetch') ?? '';
      expect(fetch).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
      expect(fetch).toContain('git fetch --no-tags origin "$SUBJECT"');
      expect(fetch).toContain('git bundle create');
      expect(fetch).not.toMatch(
        /npm ci|npm run|ratchet\.recomputeTypecheck|ratchet\.verifyRatchet/,
      );
      const compute = jobs.get('compute') ?? '';
      expect(compute).toMatch(/^\s{4}permissions: \{\}$/m);
      expect(compute).toContain('ratchet.recomputeTypecheck');
      expect(compute).toContain('actions/download-artifact@');
      expect(compute).not.toMatch(/actions\/checkout@|git fetch --no-tags origin/);
      expect(compute).not.toMatch(/github\.token|GH_TOKEN|secrets\./);
      // Failed recompute output is reported and its count stays empty.
      expect(compute).toMatch(/--scratch="\$\{RUNNER_TEMP\}\/cq-recompute"\)" \|\| true/);
      expect(compute).toContain("count=''");
      expect(compute).toContain('recompute emitted malformed JSON');
      const judge = jobs.get('judge') ?? '';
      expect(judge).toContain('ratchet.verifyRatchet');
      expect(judge).toContain('name: "cq/ratchet"');
      expect(judge).toContain('external_id: $ext');
      // A verifier crash or malformed output still produces a failing check.
      expect(judge).toContain('verifier emitted no valid JSON result');
      expect(judge).toMatch(/if ! jq -e -s[\s\S]*verdict\.json/);
      expect(judge).not.toMatch(/ratchet\.recomputeTypecheck|tsc/);
      // F5: judge holds `checks: write` and nothing else, never checks out
      // with a persisted credential, and never unpacks a HEAD-AUTHORED
      // artifact — the measurement arrives as validated numbers.
      expect(judge).toMatch(/^ {4}permissions:\n {6}checks: write$/m);
      expect(judge).not.toMatch(/actions\/checkout@|persist-credentials/);
      // No cross-run download of the head-authored measurement in judge…
      expect(judge).not.toMatch(/run-id:|name: cq-measure/);
      // …it consumes the bundle, and the numbers the measurement job vetted.
      expect(judge).toContain('name: cq-verify-source');
      expect(judge).toContain('${{ needs.measurement.outputs.json }}');
      // Its one token use is posting the verdict itself.
      expect(judge).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
      // …and the job that DOES unpack the artifact has no write scope.
      const measurement = jobs.get('measurement') ?? '';
      expect(measurement).toMatch(/^ {4}permissions:\n {6}actions: read$/m);
      expect(measurement).toContain('actions/download-artifact@');
      expect(measurement).toContain('name: cq-measure');
      expect(measurement).toMatch(/run-id: \$\{\{ needs\.resolve\.outputs\.run_id \}\}/);
      expect(measurement).not.toMatch(/checks: write|contents: write|secrets\./);
      expect(body).not.toMatch(/secrets\./);
    },
  );

  it.each(bothCopies('cq-verify.yml'))(
    '%s: actual jq resolver prefers merge-queue for dual-target PRs in either API order',
    { timeout: 30_000 },
    (_label, text) => {
      const resolveJob = jobBlocks(code(text)).get('resolve') ?? '';
      // The jq filter is reflowed across shell continuation lines (no line
      // in the workflow exceeds 80 columns). It runs from the `--jq "`
      // opening quote to the `")"` that closes the argument, the `$(` and
      // the outer quote; the continuation lines are rejoined into the
      // one-line program the shell actually passes to jq.
      const at = resolveJob.indexOf('--jq "');
      const close = resolveJob.indexOf('")"', at);
      const filter =
        at === -1 || close === -1
          ? undefined
          : resolveJob
              .slice(at + '--jq "'.length, close)
              .split('\n')
              .map((line) => line.trim())
              .join(' ')
              .replaceAll('\\"', '"')
              .replaceAll('${subject}', '0123456789abcdef0123456789abcdef01234567')
              .replaceAll('${REPO_ID}', '42');
      expect(filter).toBeDefined();
      const pull = (base: string) => ({
        state: 'open',
        head: {
          sha: '0123456789abcdef0123456789abcdef01234567',
          repo: { id: 42 },
        },
        base: { ref: base },
      });
      for (const pulls of [
        [pull('main'), pull('merge-queue')],
        [pull('merge-queue'), pull('main')],
      ]) {
        const result = spawnSync('jq', ['-r', filter ?? ''], {
          input: JSON.stringify(pulls),
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('merge-queue');
      }
    },
  );

  it.each(bothCopies('cq-verify.yml'))(
    '%s: the actual jq verdict guard rejects empty, malformed, and malformed-shape output',
    { timeout: 30_000 },
    (_label, text) => {
      const judge = jobBlocks(code(text)).get('judge') ?? '';
      const guard =
        /if ! jq -e -s \\\n\s+'([\s\S]*?)' \\\n\s+"\$\{RUNNER_TEMP\}\/verdict\.json"/.exec(
          judge,
        )?.[1];
      expect(guard).toBeDefined();
      const accepted = (result: string): boolean => {
        const jq = spawnSync('jq', ['-e', '-s', guard ?? ''], {
          input: result,
          encoding: 'utf8',
        });
        return jq.status === 0;
      };
      expect(accepted('')).toBe(false);
      expect(accepted('{"status":')).toBe(false);
      expect(accepted('{"status":"ok","value":42}')).toBe(false);
      expect(accepted('{"status":"failed","value":42}')).toBe(false);
      expect(accepted('{"status":"ok","value":{"verdict":"pass","reasons":[42]}}')).toBe(false);
      expect(accepted('{"status":"failed","error":"CLI failed"}')).toBe(true);
      expect(accepted('{"status":"ok","value":{"verdict":"pass","reasons":[]}}')).toBe(true);
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
      expect(body).toContain('RUN_ID: ${{ github.event.workflow_run.id }}');
      expect(body).toContain('gh api "repos/${REPO}/actions/runs/${RUN_ID}"');
      expect(body).toContain('measured_sha="$(jq -r \'.head_sha\' <<<"$run")"');
      expect(body).toContain('[ "$measured_sha" = "$TRUST" ]');
      expect(body).toContain('run-id: ${{ steps.run.outputs.run_id }}');
      expect(body).toContain('RATCHET_MEASURED_SHA: ${{ steps.run.outputs.measured_sha }}');
      expect(body).toMatch(/node scripts\/ratchet-propose\.mjs --measurement=/);
      expect(body).toMatch(/CQ_AUTOMATION_TOKEN: \$\{\{ secrets\.CQ_AUTOMATION_TOKEN \}\}/);
      expect(body).not.toMatch(/GITHUB_TOKEN:/);
    },
  );

  it(
    'ratchet-propose rejects forged and stale API run data before accepting its measured SHA',
    { timeout: 30_000 },
    () => {
      const job = jobBlocks(code(template('ratchet-propose.yml'))).get('propose') ?? '';
      const lines = job.split('\n');
      const stepStart = lines.findIndex(
        (line) => line.trim() === '- name: Verify the triggering measure run',
      );
      const runStart = lines.findIndex(
        (line, index) => index > stepStart && line === '        run: |',
      );
      expect(stepStart).toBeGreaterThanOrEqual(0);
      expect(runStart).toBeGreaterThan(stepStart);
      const shellLines: string[] = [];
      for (const line of lines.slice(runStart + 1)) {
        if (line.trim() !== '' && !line.startsWith('          ')) break;
        shellLines.push(line.startsWith('          ') ? line.slice(10) : '');
      }
      const shell = `gh() {
  [ "$1" = api ] && [ "$2" = "repos/owner/repo/actions/runs/$RUN_ID" ] || return 9
  printf '%s\\n' "$RUN_DATA"
}
${shellLines.join('\n')}`;
      const sha = '0123456789abcdef0123456789abcdef01234567';
      const valid = {
        path: '.github/workflows/ratchet-propose-measure.yml',
        event: 'push',
        head_branch: 'main',
        head_repository: { id: 42 },
        conclusion: 'success',
        head_sha: sha,
      };
      const outputDir = mkdtempSync(join(tmpdir(), 'ratchet-propose-run-'));
      const outputPath = join(outputDir, 'github-output');
      const check = (data: Record<string, unknown>, runId = '123') => {
        rmSync(outputPath, { force: true });
        const result = spawnSync('bash', ['-c', shell], {
          encoding: 'utf8',
          env: {
            ...process.env,
            RUN_ID: runId,
            RUN_DATA: JSON.stringify(data),
            REPO: 'owner/repo',
            REPO_ID: '42',
            TRUST: sha,
            GITHUB_OUTPUT: outputPath,
          },
        });
        return {
          ...result,
          outputs: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
        };
      };
      try {
        const accepted = check(valid);
        expect(accepted.status, accepted.stderr).toBe(0);
        expect(accepted.outputs).toContain('run_id=123');
        expect(accepted.outputs).toContain(`measured_sha=${sha}`);
        for (const [label, data] of [
          ['path', { ...valid, path: '.github/workflows/other.yml' }],
          ['event', { ...valid, event: 'pull_request' }],
          ['branch', { ...valid, head_branch: 'other' }],
          ['repo', { ...valid, head_repository: { id: 43 } }],
          ['conclusion', { ...valid, conclusion: 'failure' }],
          ['head SHA shape', { ...valid, head_sha: 'not-a-sha' }],
          ['stale SHA', { ...valid, head_sha: 'f'.repeat(40) }],
        ] as const) {
          const rejected = check(data);
          expect(rejected.status, `${label}: ${rejected.stderr}`).toBe(1);
          expect(rejected.outputs, label).not.toContain('measured_sha=');
        }
        const invalidId = check(valid, '123;echo bad');
        expect(invalidId.status).toBe(1);
        expect(invalidId.stdout).toContain('not numeric');
        expect(invalidId.outputs).not.toContain('measured_sha=');
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
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
