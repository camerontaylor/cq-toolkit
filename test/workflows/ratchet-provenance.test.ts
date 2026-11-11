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
//      cq-verify's compute job (tsc over head content) holds nothing, and
//      only its signing job (judge) runs in environment `cq-verdict`.
//   4. ratchet-propose targets main through the script, consumes the
//      measure leg's artifact, and holds its token behind `environment:`.
//   5. ratchet.yml runs no test suite and no ratchet check (cq-measure and
//      cq-verify measure and judge the manifest ratchets); it keeps only the
//      baseline monotonicity guard, in ref mode, on pull requests.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      expect(fetch).not.toMatch(
        /pnpm install|pnpm run|vitest|ratchet\.recomputeTypecheck|recompute-typecheck/,
      );
      const measure = jobs.get('measure') ?? '';
      expect(measure).toMatch(/^ {4}needs: fetch$/m);
      expect(measure).not.toMatch(/^ {4}permissions:/m);
      expect(measure).toContain('actions/download-artifact@');
      expect(measure).toContain('git checkout --detach "$SUBJECT"');
      expect(measure).not.toMatch(/actions\/checkout@|github\.token|GH_TOKEN/);
      expect(measure).toMatch(/pnpm install --frozen-lockfile/);
    },
  );

  it.each(bothCopies('cq-measure.yml'))(
    '%s measures the PR head SHA (the verdict subject), on PRs and main pushes',
    (_label, text) => {
      const body = code(text);
      expect(body).toMatch(
        /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
      );
      const on = onBlock(body);
      expect(on).toMatch(/^ {2}pull_request:\s*$/m);
      expect(on).not.toMatch(/^ {2}push:/m);
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
      expect(onBlock(body)).not.toMatch(/pull_request_target/);
      if (onBlock(body).includes('pull_request:')) {
        expect(onBlock(body)).not.toMatch(/branches:/);
        expect(jobBlocks(body).get('main-advisory')).toContain('permissions: {}');
        expect(jobBlocks(body).get('resolve')).toContain("github.event_name != 'pull_request'");
      }
      expect(body).toMatch(/^permissions: \{\}$/m);
      // Every checkout is the trust ref; the head is never checked out.
      const refs = [...body.matchAll(/^\s+ref: (.*)$/gm)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ref).toBe('${{ github.sha }}');
      // Installs run no lifecycle scripts; nothing restores a cache.
      for (const install of body.matchAll(/pnpm install[^\n]*/g)) {
        expect(install[0]).toContain('--ignore-scripts');
      }
      expect(body).toMatch(/cache: ''/);
      expect(body).not.toMatch(/cache: p?npm|actions\/cache/);
      expect(body).not.toMatch(/vitest|pnpm test|pnpm run test/);
      // No checkout persists its credential: fetches scope a read-only
      // credential to their own step (a GIT_CONFIG_* extra-header).
      expect(body).toMatch(/persist-credentials: false/);
      expect(body).not.toMatch(/persist-credentials: true/);
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
      // Resolve only the main target, regardless of API array order.
      expect(resolveJob).toMatch(/if index\("main"\) then "main"\s*else empty end/);
      const fetch = jobs.get('fetch') ?? '';
      expect(fetch).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
      expect(fetch).toContain('git fetch --no-tags origin "$SUBJECT"');
      expect(fetch).toContain('GIT_CONFIG_KEY_0="http.${GITHUB_SERVER_URL}/.extraheader"');
      expect(fetch).toContain('git bundle create');
      expect(fetch).not.toMatch(
        /pnpm install|pnpm run|recompute-typecheck|verify-ratchet|ratchet\.recomputeTypecheck|ratchet\.verifyRatchet/,
      );
      const compute = jobs.get('compute') ?? '';
      expect(compute).toMatch(/^\s{4}permissions: \{\}$/m);
      // The in-process recompute (R1): the CLI registry no longer produces
      // the count that feeds cq/ratchet.
      expect(compute).toContain('node trust/dist/selfhost/recompute-typecheck.js \\');
      expect(compute).not.toContain('cli.js');
      expect(compute).toContain('actions/download-artifact@');
      expect(compute).not.toMatch(/actions\/checkout@|git fetch --no-tags origin/);
      expect(compute).not.toMatch(/github\.token|GH_TOKEN|secrets\./);
      // Failed recompute output is reported and its count stays empty.
      expect(compute).toMatch(/--scratch="\$\{RUNNER_TEMP\}\/cq-recompute"\)" \|\| true/);
      expect(compute).toContain("count=''");
      expect(compute).toContain('recompute emitted malformed JSON');
      const judge = jobs.get('judge') ?? '';
      // The in-process verifier (readiness T2): it binds the gate's D11
      // authorization; the CLI registry is no longer loaded to sign.
      expect(judge).toContain('node trust/dist/selfhost/verify-ratchet.js "${args[@]}"');
      expect(judge).not.toContain('cli.js ratchet.verifyRatchet');
      expect(judge).toContain('name: "cq/ratchet"');
      expect(judge).toContain('external_id: $ext');
      // A verifier crash or malformed output still produces a failing check.
      expect(judge).toContain('verifier emitted no valid JSON result');
      expect(judge).toMatch(/if ! jq -e -s[\s\S]*verdict\.json/);
      expect(judge).not.toMatch(/ratchet\.recomputeTypecheck|recompute-typecheck|tsc/);
      // F5: judge writes only `checks` (its read scopes serve the D11
      // evidence API reads), never checks out with a persisted credential,
      // and never unpacks a HEAD-AUTHORED artifact — the measurement
      // arrives as validated numbers.
      expect(judge).toMatch(
        /^ {4}permissions:\n {6}checks: write\n {6}contents: read\n {6}issues: read\n {6}pull-requests: read$/m,
      );
      expect(judge).not.toMatch(/^ {6}(?!checks)[a-z-]+: write$/m);
      expect(judge).toContain('GH_TOKEN: ${{ github.token }}');
      expect(judge).not.toMatch(/actions\/checkout@|persist-credentials/);
      // No cross-run download of the head-authored measurement in judge…
      expect(judge).not.toMatch(/run-id:|name: cq-measure/);
      // …it consumes the bundle, and the numbers the measurement job vetted.
      expect(judge).toContain('name: cq-verify-source');
      expect(judge).toContain('${{ needs.measurement.outputs.json }}');
      // Its one token use is posting the verdict itself: the verdict-App
      // token when minted, else GITHUB_TOKEN (Decision 6). Only judge signs.
      expect(judge).toContain('GH_TOKEN: ${{ steps.verdict-app.outputs.token || github.token }}');
      expect(judge).toMatch(/^ {4}environment: cq-verdict$/m);
      expect([...body.matchAll(/^\s*environment: (.*)$/gm)].map((m) => m[1])).toEqual([
        'cq-verdict',
      ]);
      // …and the job that DOES unpack the artifact has no write scope.
      const measurement = jobs.get('measurement') ?? '';
      expect(measurement).toMatch(/^ {4}permissions:\n {6}actions: read$/m);
      expect(measurement).toContain('actions/download-artifact@');
      expect(measurement).toContain('name: cq-measure');
      expect(measurement).toMatch(/run-id: \$\{\{ needs\.resolve\.outputs\.run_id \}\}/);
      expect(measurement).not.toMatch(/checks: write|contents: write|secrets\./);
      // The only secret is the verdict App key, in judge's mint step.
      for (const m of body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
        expect(m[1]).toBe('CQ_VERDICT_APP_KEY');
      }
      for (const [id, job] of jobs) {
        if (id !== 'judge') expect(job, id).not.toMatch(/secrets\.|create-github-app-token/);
      }
    },
  );

  it.each(bothCopies('cq-verify.yml'))(
    '%s: actual jq resolver prefers main for dual-target PRs in either API order',
    { timeout: 30_000 },
    (_label, text) => {
      const resolveJob = jobBlocks(code(text)).get('resolve') ?? '';
      // The jq program is the single-quoted argument of `base_of`'s jq
      // call; it reads $sha and $repo as jq arguments, passed here as the
      // shell passes them.
      const filter =
        /jq -r --arg sha "\$subject" --argjson repo "\$REPO_ID" \\\n\s+'([^']*)' <<<"\$pulls"/.exec(
          resolveJob,
        )?.[1];
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
        const result = spawnSync(
          'jq',
          [
            '-r',
            '--arg',
            'sha',
            '0123456789abcdef0123456789abcdef01234567',
            '--argjson',
            'repo',
            '42',
            filter ?? '',
          ],
          {
            input: JSON.stringify(pulls),
            encoding: 'utf8',
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('main');
      }
      // A non-main-only association must produce empty output (nothing to judge).
      {
        const result = spawnSync(
          'jq',
          [
            '-r',
            '--arg',
            'sha',
            '0123456789abcdef0123456789abcdef01234567',
            '--argjson',
            'repo',
            '42',
            filter ?? '',
          ],
          {
            input: JSON.stringify([pull('merge-queue')]),
            encoding: 'utf8',
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('');
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
      // Per-run App mint (no stored token): the script's env var carries the
      // minted installation token, never `secrets.CQ_AUTOMATION_TOKEN`.
      expect(body).toMatch(/CQ_AUTOMATION_TOKEN: \$\{\{ steps\.propose-app\.outputs\.token \}\}/);
      expect(body).toContain('client-id: ${{ vars.CQ_AUTOMATION_APP_CLIENT_ID }}');
      expect(body).toContain('private-key: ${{ secrets.CQ_AUTOMATION_APP_KEY }}');
      expect(body).not.toMatch(/secrets\.CQ_AUTOMATION_TOKEN\b/);
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
        event: 'schedule',
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
          ['event-push', { ...valid, event: 'push' }],
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

describe('ratchet.yml is the baseline guard only', () => {
  it.each(bothCopies('ratchet.yml'))(
    '%s runs no suite or ratchet check and guards in ref mode on PRs',
    (_label, text) => {
      const body = code(text);
      expect(onBlock(text)).toBe('  pull_request:\n\n');
      expect(body).not.toMatch(/vitest|--coverage|ratchet\.checkRatchet/);
      expect(body).toMatch(
        /ratchet\.monotonicGuard --repo=\. --base="origin\/\$\{PR_BASE\}" --head=HEAD/,
      );
      expect(body).not.toMatch(/git diff/);
    },
  );
});

/**
 * The guard run-block (the `run: |` body of the monotonic step), extracted
 * from a ratchet.yml copy and dedented by its 10-space indent — the exact
 * shell the CI step executes, exercised below against OpResult shapes.
 */
function guardRunBlock(text: string): string {
  // The verdict/outputs lines only: start after the op invocation (which
  // runs the real CLI in tests) and stop before the final jq pass/fail
  // check (which the test asserts separately from the recorded verdict).
  const start = text.indexOf('          verdict=error');
  expect(start, 'verdict block present').toBeGreaterThanOrEqual(0);
  const end = text.indexOf("          printf 'verdict=", start);
  expect(end, 'verdict write present').toBeGreaterThanOrEqual(0);
  const lines: string[] = [];
  for (const line of text.slice(start).split('\n')) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    lines.push(line.startsWith('          ') ? line.slice(10) : '');
    if (line.startsWith("          printf 'verdict=")) break;
  }
  return lines.join('\n');
}

/** Run one guard snippet under the step's `set` discipline; capture outputs. */
function runGuard(
  snippet: string,
  opJson: string,
): { status: number | null; outputs: string; jqGateStatus: number | null } {
  const output = join(tmpdir(), `ratchet-guard-${Math.random().toString(36).slice(2)}`);
  writeFileSync(output, '');
  // The snippet goes through a temp script file: a shell-embedded literal
  // would mangle the JSON's double quotes and braces, and env-var capture
  // via `printf '%s' "$opJson"` would double-expand inside the -c string.
  const script = [
    `opJson=${JSON.stringify(opJson)}`,
    'out=$(printf \'%s\' "$opJson")',
    snippet,
    'true',
  ].join('\n');
  const scriptPath = join(tmpdir(), `ratchet-guard-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(scriptPath, script);
  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  // The final jq pass/fail check, exactly as the step ends with: a
  // non-passing op result must exit nonzero there.
  const jqGate = spawnSync(
    'bash',
    [
      '-c',
      'printf \'%s\' "$1" | jq -e \'.status == "ok" and .value.ok == true\' >/dev/null',
      'jq',
      opJson,
    ],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    outputs: existsSync(output) ? readFileSync(output, 'utf8') : '',
    jqGateStatus: jqGate.status,
  };
}

describe('ratchet.yml guard verdict mapping (PR #1535 review F1/F2)', () => {
  const OK_TRUE = JSON.stringify({
    status: 'ok',
    value: { ok: true, violations: [], filesChecked: 1 },
  });
  const cases = [
    [
      'loosened value',
      JSON.stringify({
        status: 'ok',
        value: {
          ok: false,
          violations: [{ path: 'baselines/x.json', why: 'loosened' }],
          filesChecked: 1,
        },
      }),
    ],
    [
      'direction changed',
      JSON.stringify({
        status: 'ok',
        value: {
          ok: false,
          violations: [{ path: 'baselines/x.json', why: 'direction changed' }],
          filesChecked: 1,
        },
      }),
    ],
    [
      'unit changed',
      JSON.stringify({
        status: 'ok',
        value: {
          ok: false,
          violations: [{ path: 'baselines/x.json', why: 'unit changed' }],
          filesChecked: 1,
        },
      }),
    ],
    [
      'deleted without replacement',
      JSON.stringify({
        status: 'ok',
        value: {
          ok: false,
          violations: [{ path: 'baselines/x.json', why: 'deleted without replacement' }],
          filesChecked: 1,
        },
      }),
    ],
    [
      'unparsable baseline diff',
      JSON.stringify({
        status: 'ok',
        value: {
          ok: false,
          violations: [{ path: 'baselines/x.json', why: 'unparsable baseline diff' }],
          filesChecked: 1,
        },
      }),
    ],
    ['op failed', JSON.stringify({ status: 'failed', error: 'crash' })],
    ['needs-human', JSON.stringify({ status: 'needs-human', reason: 'x' })],
    ['indeterminate', JSON.stringify({ status: 'indeterminate', detail: 'x' })],
    ['budget-exhausted', JSON.stringify({ status: 'budget-exhausted' })],
    ['not JSON', 'garbage'],
  ] as const;

  it.each(bothCopies('ratchet.yml'))(
    '%s: clean op passes and records verdict=passed',
    (_label, text) => {
      const run = runGuard(guardRunBlock(text), OK_TRUE);
      expect(run.status, run.outputs).toBe(0);
      expect(run.outputs).toBe('verdict=passed\n');
    },
  );

  it.each(
    cases.flatMap(([name, json]) =>
      bothCopies('ratchet.yml').map(([l, t]) => [`${l}: ${name}`, t, json] as const),
    ),
  )('%s records the honest verdict (jq verdict + step gate)', (_label, text, json) => {
    // The 'not JSON' case cannot be parsed; classify by the shape check
    // itself (the same jq program the step runs for its verdict).
    const rejected =
      spawnSync('jq', ['-e', '.status == "ok" and .value.ok == false'], {
        input: json,
        encoding: 'utf8',
      }).status === 0;
    const run = runGuard(guardRunBlock(text), json);
    // The verdict line mirrors the op's own verdict even on a failing
    // step; the trailing jq gate reproduces the step's pass/fail.
    expect(run.outputs).toBe(rejected ? 'verdict=loosened\n' : 'verdict=error\n');
    expect(run.jqGateStatus, 'jq gate fails on every non-passing op').not.toBe(0);
  });

  it.each(bothCopies('ratchet.yml'))(
    '%s: propose-drop fires only on the loosened verdict (never drop)',
    (_label, text) => {
      const jobs = jobBlocks(code(text));
      const guard = jobs.get('ratchet');
      const propose = jobs.get('propose-drop');
      expect(guard, 'ratchet job').toBeDefined();
      expect(propose, 'propose-drop job').toBeDefined();
      expect(guard).toMatch(/verdict: \$\{\{ steps\.monotonic\.outputs\.verdict \}\}/);
      expect(guard).toMatch(/drop: \$\{\{ steps\.monotonic\.outcome == 'failure' \}\}/);
      expect(propose).toMatch(
        /if: github\.base_ref == 'main' && needs\.ratchet\.outputs\.verdict == 'loosened'/,
      );
      expect(propose).not.toMatch(/outputs\.drop/);
      // The issue body claims only a REJECTED diff: every ok:false verdict
      // (loosened, direction/unit changed, unreplaced delete, unparsable)
      // reaches it, so it must not name a cause the op did not report.
      expect(propose).toContain(
        'Ratchet baseline monotonicity guard rejected the baseline diff on PR #${PR_NUMBER}.',
      );
      expect(propose).not.toMatch(/guard failed[^\n]*loosened/);
    },
  );

  it.each(bothCopies('ratchet.yml'))(
    '%s: issue lookup walks the issues connection to exhaustion',
    (_label, text) => {
      const jobs = jobBlocks(code(text));
      const propose = jobs.get('propose-drop');
      expect(propose).toBeDefined();
      // The exact-title scan must use the paginated issues connection
      // (gh api --paginate), not gh issue list (no --paginate flag; the
      // search API caps at 1,000 results).
      expect(propose).toMatch(
        /gh api 'repos\/\$\{GH_REPO\}\/issues\?state=open&per_page=100' --paginate --jq '\[\.\[\] \| select\(\.pull_request == null and \.title == "ratchet"\)\]\[0\]\.number \/\/ empty'/,
      );
      expect(propose).not.toMatch(/gh issue list/);
    },
  );
});

describe('trusted recompute lockfile guard', () => {
  it.each([false, true])('skips only when the PR changes the lockfile (%s)', (changed) => {
    const root = mkdtempSync(join(tmpdir(), 'recompute-lockfile-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', join(root, 'trust'), ...args], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      spawnSync('git', ['init', join(root, 'trust')]);
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'Test');
      writeFileSync(join(root, 'trust/pnpm-lock.yaml'), 'base');
      git('add', '.');
      git('commit', '-m', 'base');
      git('update-ref', 'refs/cq-transfer/base', 'HEAD');
      writeFileSync(join(root, changed ? 'trust/pnpm-lock.yaml' : 'trust/README.md'), 'head');
      git('add', '.');
      git('commit', '-m', 'head');
      const workflow = template('cq-verify.yml');
      const guard = workflow
        .slice(
          workflow.indexOf('          # Lockfile guard:'),
          workflow.indexOf('          # End lockfile guard.'),
        )
        .replace(/^ {10}/gm, '');
      const output = join(root, 'output');
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-eu', '-c', guard + '\necho recompute'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          KIND: 'pr',
          SUBJECT: git('rev-parse', 'HEAD'),
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.includes('recompute')).toBe(!changed);
      expect(readFileSync(output, 'utf8').includes('trusted typecheck recompute skipped')).toBe(
        changed,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
