// W1.9 — the D11 policy check's execution provenance (ADR-0004 D-A/D-B/D-G,
// D-H.2), pinned over BOTH the generated workflows (.github/workflows/) and
// their source of truth (policy/templates/), as ratchet-provenance does for
// the W1.7 ratchet family.
//
// Pinned here:
//   1. Lockstep: each generated file is the provenance header plus its
//      template, byte for byte.
//   2. cq-signal is a wake-up only: `permissions: {}` at the top and on its
//      one job, no secrets, no checkout, no action, a no-op body.
//   3. cq-policy runs from the default branch (`workflow_run` on cq-signal;
//      dispatch honoured only on the default ref), refuses fork and foreign
//      runs, signs in environment `cq-verdict` (W1.10 Decision 6) with a
//      verdict-App token when its variable is set and GITHUB_TOKEN otherwise,
//      checks out only the trust ref with no persisted credential, never runs
//      head code, reads the posture from `vars.*`, and posts `cq/policy`.
//   4. The resolver, verdict guard and posting programs behave as documented
//      when actually run (bash + jq, with `gh` stubbed).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const FILES = ['cq-signal.yml', 'cq-policy.yml'] as const;

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

/** The job blocks under `jobs:`, keyed by job id (two-space `<id>:` lines). */
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

/** The step items (six-space `- ` lines) of one job block. */
function steps(job: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  for (const line of job.split('\n')) {
    if (/^ {6}- /.test(line)) {
      if (current !== null) out.push(current.join('\n'));
      current = [line];
    } else if (current !== null) {
      if (line.trim() !== '' && !line.startsWith('        ')) {
        out.push(current.join('\n'));
        current = null;
      } else {
        current.push(line);
      }
    }
  }
  if (current !== null) out.push(current.join('\n'));
  return out;
}

/** The dedented `run: |` script of the step whose `name:` is `stepName`. */
function runScript(job: string, stepName: string): string {
  const step = steps(job).find((s) => s.startsWith(`      - name: ${stepName}\n`));
  if (step === undefined) throw new Error(`no step named ${stepName}`);
  const lines = step.split('\n');
  const at = lines.findIndex((line) => line === '        run: |');
  if (at === -1) throw new Error(`step ${stepName} has no run: | block`);
  const script: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    script.push(line.startsWith('          ') ? line.slice(10) : '');
  }
  return script.join('\n');
}

describe('policy workflows: template ↔ generated lockstep', () => {
  it.each(FILES)('%s is its template plus the provenance header', (name) => {
    expect(generated(name)).toBe(
      `# instantiated from policy/templates/${name} — edit the template, not this file\n${template(name)}`,
    );
  });
});

describe('cq-signal is a wake-up only (ADR-0004 D-B)', () => {
  it.each(bothCopies('cq-signal.yml'))(
    '%s: head-defined, holds nothing, does nothing',
    (_label, text) => {
      const body = code(text);
      const on = onBlock(body);
      expect(on).toMatch(
        /^ {2}pull_request:\n {4}types:\n {6}- opened\n {6}- synchronize\n {6}- reopened\n {6}- labeled\n {6}- unlabeled\n {6}- ready_for_review\n {6}- edited$/m,
      );
      expect(on).toMatch(/^ {2}pull_request_review:$/m);
      expect(on).toMatch(/^ {2}pull_request_review_comment:$/m);
      expect(on).toMatch(/^ {2}push:\n {4}branches:\n {6}- merge-queue$/m);
      expect(on).not.toMatch(/pull_request_target|workflow_run|workflow_dispatch/);
      expect(body).toMatch(/^permissions: \{\}$/m);
      const jobs = jobBlocks(body);
      expect([...jobs.keys()]).toEqual(['signal']);
      const job = jobs.get('signal') ?? '';
      expect(job).toMatch(/^ {4}permissions: \{\}$/m);
      expect(steps(job)).toHaveLength(1);
      expect(job).toMatch(/^ {8}run: 'true'$/m);
      expect(body).not.toMatch(/secrets\.|github\.token|GH_TOKEN/);
      expect(body).not.toMatch(/uses:|actions\/checkout|environment:/);
    },
  );
});

describe('cq-policy runs trusted code over head data (ADR-0004 D-B, D-G, D-H.2)', () => {
  it.each(bothCopies('cq-policy.yml'))(
    '%s: default-branch carrier, judge signs in cq-verdict, no other secret',
    (_label, text) => {
      const body = code(text);
      const on = onBlock(body);
      expect(on).toMatch(/^ {2}workflow_run:\n {4}workflows:\n {6}- cq-signal\n/m);
      expect(on).toMatch(/^ {4}types:\n {6}- completed$/m);
      expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
      expect(on).not.toMatch(/pull_request|push:/);
      expect(body).toMatch(/^permissions: \{\}$/m);
      expect([...jobBlocks(body).keys()]).toEqual(['resolve', 'judge']);
      // Only the signing job has an environment (Decision 6).
      expect([...body.matchAll(/^\s*environment: (.*)$/gm)].map((m) => m[1])).toEqual([
        'cq-verdict',
      ]);
      expect(jobBlocks(body).get('judge')).toMatch(/^ {4}environment: cq-verdict$/m);
      // The only secret is the verdict App key, reached only by the mint step.
      for (const m of body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
        expect(m[1]).toBe('CQ_VERDICT_APP_KEY');
      }
      const judgeSteps = steps(jobBlocks(body).get('judge') ?? '');
      const mint = judgeSteps.filter((s) => s.includes('actions/create-github-app-token@'));
      expect(mint).toHaveLength(1);
      expect(mint[0]).toMatch(/^ {8}if: vars\.CQ_VERDICT_APP_CLIENT_ID != ''$/m);
      expect(mint[0]).toMatch(/^ {10}permission-checks: write$/m);
      expect(judgeSteps.filter((s) => s.includes('secrets.'))).toEqual(mint);
      expect(body).toContain('${{ github.token }}');
      // Every `${{ }}` reaches a script through env:, never run: text.
      for (const job of jobBlocks(body).values()) {
        for (const step of steps(job)) {
          const at = step.indexOf('        run: ');
          if (at !== -1) expect(step.slice(at)).not.toContain('${{');
        }
      }
    },
  );

  it.each(bothCopies('cq-policy.yml'))(
    '%s: only the trust ref is checked out, credential-free; no head code runs',
    (_label, text) => {
      const body = code(text);
      const checkouts = [...jobBlocks(body).values()].flatMap((job) =>
        steps(job).filter((s) => s.includes('actions/checkout@')),
      );
      expect(checkouts).toHaveLength(1);
      for (const step of checkouts) {
        expect(step).toMatch(/^ {10}persist-credentials: false$/m);
        expect(step).toMatch(/^ {10}ref: \$\{\{ github\.sha \}\}$/m);
        expect(step).toMatch(/^ {10}path: trust$/m);
      }
      expect(body).not.toMatch(/persist-credentials: true/);
      const refs = [...body.matchAll(/^\s+ref: (.*)$/gm)].map((m) => m[1]);
      expect(refs).toEqual(['${{ github.sha }}']);
      // Installs and builds happen only in trust/, with no lifecycle scripts.
      const judge = jobBlocks(body).get('judge') ?? '';
      for (const step of steps(judge).filter((s) => /\bnpm\b/.test(s))) {
        expect(step).toMatch(/^ {8}working-directory: trust$/m);
      }
      for (const install of body.matchAll(/npm ci[^\n]*/g)) {
        expect(install[0]).toContain('--ignore-scripts');
      }
      // The only node invocation is the trusted CLI.
      for (const m of body.matchAll(/\bnode (\S+)/g)) {
        expect(m[1]).toBe('trust/dist/cli.js');
      }
      expect(body).not.toMatch(/\bnpx\b|vitest|npm test|npm run test/);
      // The head is fetched as objects, never materialised as a tree.
      expect(body).not.toMatch(/git (?:-C \S+ )?(?:checkout|switch|worktree|archive|reset)/);
      expect(body).not.toMatch(/actions\/(?:download|upload)-artifact/);
      expect(judge).toContain('git -C trust fetch --no-tags origin "$SUBJECT"');
      expect(judge).toContain("'+refs/heads/cq-state:refs/remotes/origin/cq-state'");
      // No cache is restored by a deciding job (D-C.7).
      expect(body).toMatch(/cache: ''/);
      expect(body).not.toMatch(/cache: npm|actions\/cache/);
    },
  );

  it.each(bothCopies('cq-policy.yml'))(
    '%s: resolve verifies the run; judge maps the posture and posts cq/policy',
    (_label, text) => {
      const body = code(text);
      const jobs = jobBlocks(body);
      const resolveJob = jobs.get('resolve') ?? '';
      // Dispatch is honoured only on the default ref (D-A.1).
      expect(resolveJob).toMatch(
        /github\.event_name == 'workflow_run' \|\|\s*github\.ref ==\s*format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
      );
      expect(resolveJob).toContain('[ "$path" = ".github/workflows/cq-signal.yml" ]');
      expect(resolveJob).toContain('[ "$head_repo" = "$REPO_ID" ]');
      expect(resolveJob).toContain("jq -r '.head_sha'");
      expect(resolveJob).toContain('/commits/${subject}/pulls');
      expect(resolveJob).toMatch(/^ {4}permissions:\n(?: {6}\S+: read\n)+ {4}outputs:/m);
      const judge = jobs.get('judge') ?? '';
      expect(judge).toMatch(/^ {4}needs: resolve$/m);
      expect(judge).toMatch(
        /^ {4}permissions:\n {6}contents: read\n {6}checks: write\n {6}pull-requests: read\n {6}issues: read\n {4}env:/m,
      );
      expect(judge).toMatch(
        /^ {6}CQ_MERGE_PROTECTED_PATHS: \$\{\{ vars\.CQ_MERGE_PROTECTED_PATHS \}\}$/m,
      );
      expect(body.match(/CQ_MERGE_PROTECTED_PATHS:/g)).toHaveLength(1);
      expect(judge).toContain('node trust/dist/cli.js gates.policyDiff');
      expect(judge).toContain('OWNER_ID: ${{ github.repository_owner_id }}');
      expect(judge).toContain('repos/${REPO}/issues/${PR}/timeline');
      // I11: the override record reads the COMPLETE, chronological label
      // history — every page, slurped in API order.
      expect(judge).toContain('gh api --paginate "repos/${REPO}/issues/${PR}/timeline"');
      expect(judge).toContain(`jq -s '.' > "\${RUNNER_TEMP}/label-events.json"`);
      // A head-authored path cannot close the summary's code fence.
      expect(judge).toContain(`($report | gsub("${'`'}{3,}"; "${'` ` `'}"))`);
      expect(judge).toContain('name: "cq/policy"');
      expect(judge).toContain('external_id: $ext');
      expect(judge).toContain('--arg ext "${TRUST}:${SUBJECT}"');
      expect(judge).toContain('$GITHUB_STEP_SUMMARY');
      expect(judge).toContain('policy check emitted no valid JSON result');
      // The fetch credential lives in the fetch step's env only; the post
      // runs under the verdict-App token when minted (Decision 6).
      const tokenSteps = steps(judge).filter((s) => s.includes('github.token }}'));
      expect(tokenSteps.map((s) => s.split('\n')[0])).toEqual([
        '      - name: Fetch the subject, base and cq-state objects (no checkout)',
        '      - name: Fetch the PR timeline label events (API data, not head bytes)',
        '      - name: Post the cq/policy check run and the run report',
      ]);
      expect(tokenSteps[2]).toContain(
        'GH_TOKEN: ${{ steps.verdict-app.outputs.token || github.token }}',
      );
      const judgeStep = steps(judge).find((s) => s.includes('gates.policyDiff')) ?? '';
      expect(judgeStep).not.toMatch(/GH_TOKEN|github\.token/);
    },
  );
});

describe('cq-policy programs behave as documented (bash + jq, gh stubbed)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const resolveScript = (text: string) =>
    runScript(
      jobBlocks(code(text)).get('resolve') ?? '',
      'Verify the triggering run and resolve the subject',
    );
  const judgeJob = (text: string) => jobBlocks(code(text)).get('judge') ?? '';

  it.each(bothCopies('cq-policy.yml'))(
    '%s: resolve accepts PR/review/push runs and refuses fork, path, event, ambiguity',
    { timeout: 120_000 },
    (_label, text) => {
      const shell = `gh() {
  [ "$1" = api ] || return 9
  local data
  case "$2" in
    "repos/owner/repo/actions/runs/$RUN_ID") data="$RUN_DATA";;
    "repos/owner/repo/commits/${SHA}/pulls") data="$PULLS_DATA";;
    *) return 9;;
  esac
  if [ "\${3:-}" = --jq ]; then jq "$4" <<<"$data"; else printf '%s\\n' "$data"; fi
}
${resolveScript(text)}`;
      const valid = {
        path: '.github/workflows/cq-signal.yml',
        event: 'pull_request',
        head_branch: 'feature',
        head_repository: { id: 42 },
        head_sha: SHA,
      };
      const pull = (base: string, over: Record<string, unknown> = {}) => ({
        number: 7,
        state: 'open',
        head: { sha: SHA, repo: { id: 42 } },
        base: { ref: base },
        ...over,
      });
      const dir = mkdtempSync(join(tmpdir(), 'cq-policy-resolve-'));
      const outputPath = join(dir, 'github-output');
      const check = (run: Record<string, unknown>, pulls: unknown[] = [pull('merge-queue')]) => {
        rmSync(outputPath, { force: true });
        const result = spawnSync('bash', ['-c', shell], {
          encoding: 'utf8',
          env: {
            ...process.env,
            RUN_ID: '123',
            RUN_DATA: JSON.stringify(run),
            PULLS_DATA: JSON.stringify(pulls),
            SHA,
            REPO: 'owner/repo',
            REPO_ID: '42',
            GITHUB_OUTPUT: outputPath,
          },
        });
        return {
          ...result,
          outputs: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
        };
      };
      try {
        for (const event of [
          'pull_request',
          'pull_request_review',
          'pull_request_review_comment',
        ]) {
          const ok = check({ ...valid, event }, [
            pull('other'),
            pull('main', { state: 'closed' }),
            pull('merge-queue'),
          ]);
          expect(ok.status, ok.stderr + ok.stdout).toBe(0);
          expect(ok.outputs).toBe(`subject=${SHA}\nkind=pr\nbase=merge-queue\npr=7\n`);
        }
        const push = check({ ...valid, event: 'push', head_branch: 'merge-queue' }, []);
        expect(push.status, push.stderr + push.stdout).toBe(0);
        expect(push.outputs).toBe(`subject=${SHA}\nkind=push\nbase=main\npr=\n`);
        for (const [label, run, pulls] of [
          ['path', { ...valid, path: '.github/workflows/other.yml' }, undefined],
          ['fork', { ...valid, head_repository: { id: 43 } }, undefined],
          ['event', { ...valid, event: 'pull_request_target' }, undefined],
          ['head SHA shape', { ...valid, head_sha: 'not-a-sha' }, undefined],
          ['push branch', { ...valid, event: 'push', head_branch: 'main' }, undefined],
          ['no PR', valid, []],
          ['fork PR', valid, [pull('main', { head: { sha: SHA, repo: { id: 43 } } })]],
          [
            'stale PR head',
            valid,
            [pull('main', { head: { sha: 'f'.repeat(40), repo: { id: 42 } } })],
          ],
          ['ambiguous PR', valid, [pull('main'), pull('merge-queue', { number: 8 })]],
        ] as const) {
          const refused = check(run, pulls === undefined ? undefined : [...pulls]);
          expect(refused.status, `${label}: ${refused.stdout}`).toBe(1);
          expect(refused.outputs, label).toBe('');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(bothCopies('cq-policy.yml'))(
    '%s: the verdict guard rejects empty, malformed and malformed-shape output',
    { timeout: 120_000 },
    (_label, text) => {
      const guard =
        /if ! jq -e -s \\\n\s+'([\s\S]*?)' \\\n\s+"\$\{RUNNER_TEMP\}\/verdict\.json"/.exec(
          judgeJob(text),
        )?.[1];
      expect(guard).toBeDefined();
      const accepted = (result: string): boolean =>
        spawnSync('jq', ['-e', '-s', guard ?? ''], { input: result, encoding: 'utf8' }).status ===
        0;
      const value = (over: Record<string, unknown>) =>
        JSON.stringify({
          status: 'ok',
          value: {
            verdict: 'pass',
            posture: 'human',
            postureLayer: 'default',
            report: [],
            ...over,
          },
        });
      expect(accepted('')).toBe(false);
      expect(accepted('{"status":')).toBe(false);
      expect(accepted('{"status":"ok","value":42}')).toBe(false);
      expect(accepted('{"status":"ok"}')).toBe(false);
      expect(accepted(`${value({})}\n${value({})}`)).toBe(false);
      expect(accepted(value({ verdict: 'maybe' }))).toBe(false);
      expect(accepted(value({ report: [42] }))).toBe(false);
      expect(accepted(value({ report: 'x' }))).toBe(false);
      expect(accepted(value({ posture: null }))).toBe(false);
      expect(accepted(value({ postureLayer: 1 }))).toBe(false);
      expect(accepted('{"status":"failed","error":"CLI failed"}')).toBe(true);
      expect(accepted('{"status":"failed","error":7}')).toBe(false);
      for (const verdict of ['pass', 'fail', 'needs-human']) {
        expect(accepted(value({ verdict, report: ['line'] }))).toBe(true);
      }
    },
  );

  it.each(bothCopies('cq-policy.yml'))(
    '%s: posting maps only an ok pass to success and logs the report',
    { timeout: 120_000 },
    (_label, text) => {
      const script = runScript(judgeJob(text), 'Post the cq/policy check run and the run report');
      const dir = mkdtempSync(join(tmpdir(), 'cq-policy-post-'));
      const shell = `gh() { cp "$6" "$RUNNER_TEMP/posted.json"; echo https://example.test; }
${script}`;
      const post = (verdict: string) => {
        writeFileSync(join(dir, 'verdict.json'), verdict);
        rmSync(join(dir, 'posted.json'), { force: true });
        rmSync(join(dir, 'summary.md'), { force: true });
        const result = spawnSync('bash', ['-c', shell], {
          encoding: 'utf8',
          env: {
            ...process.env,
            RUNNER_TEMP: dir,
            GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
            REPO: 'owner/repo',
            TRUST: 'a'.repeat(40),
            SUBJECT: SHA,
          },
        });
        const posted = existsSync(join(dir, 'posted.json'))
          ? (JSON.parse(readFileSync(join(dir, 'posted.json'), 'utf8')) as {
              name: string;
              head_sha: string;
              external_id: string;
              conclusion: string;
              output: { title: string; summary: string };
            })
          : undefined;
        const summary = existsSync(join(dir, 'summary.md'))
          ? readFileSync(join(dir, 'summary.md'), 'utf8')
          : '';
        return { status: result.status, stderr: result.stderr, posted, summary };
      };
      const ok = (verdict: string, report: string[]) =>
        JSON.stringify({
          status: 'ok',
          value: { verdict, posture: 'human', postureLayer: 'default', report },
        });
      try {
        const pass = post(ok('pass', ['no findings']));
        expect(pass.status, pass.stderr).toBe(0);
        expect(pass.posted).toMatchObject({
          name: 'cq/policy',
          head_sha: SHA,
          external_id: `${'a'.repeat(40)}:${SHA}`,
          conclusion: 'success',
          output: { title: 'policy: pass' },
        });
        const human = post(ok('needs-human', ['protected-path policy/x', 'override: dormant']));
        expect(human.status).toBe(1);
        expect(human.posted?.conclusion).toBe('failure');
        expect(human.posted?.output.title).toBe('needs-human (D11)');
        expect(human.posted?.output.summary).toContain(
          'protected-path policy/x\noverride: dormant',
        );
        expect(human.summary).toContain('override: dormant');
        const fail = post(ok('fail', ['lint']));
        expect(fail.posted?.conclusion).toBe('failure');
        expect(fail.posted?.output.title).toBe('policy: fail');
        const crashed = post('{"status":"failed","error":"boom"}');
        expect(crashed.posted?.conclusion).toBe('failure');
        expect(crashed.posted?.output.title).toBe('policy: check failed');
        expect(crashed.posted?.output.summary).toContain('boom');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// W1.10 review fix-forward — each App is named by a PAIR of repository
// variables: the client id mints its token, the numeric id selects its
// verdicts (gate, cq-accept's sweep dedupe) or is rendered into the settings
// target (drift). Every job that reads either half refuses, in a LEADING
// step, when exactly one of a pair is set (Decisions 6, 7).
describe('App variable pairs are refused half-set (W1.10 Decisions 6, 7)', () => {
  const VERDICT_STEP = 'Refuse a half-registered verdict App (paired vars)';
  const BOTH_STEP = 'Refuse a half-registered App (paired vars)';
  const CASES: Array<[string, string, string, boolean]> = [
    ['cq-policy.yml', 'judge', VERDICT_STEP, false],
    ['cq-verify.yml', 'judge', VERDICT_STEP, false],
    ['cq-accept.yml', 'judge', VERDICT_STEP, false],
    ['gate.yml', 'decide', BOTH_STEP, true],
    ['settings-drift.yml', 'drift', BOTH_STEP, true],
  ];
  const copies = CASES.flatMap(([file, job, step, promoter]) =>
    bothCopies(file).map(
      ([label, text]) =>
        [label, job, step, promoter, text] as [string, string, string, boolean, string],
    ),
  );

  it.each(copies)(
    '%s: the %s job refuses a half-set pair first, through env: only',
    { timeout: 60_000 },
    (_label, jobId, stepName, promoter, text) => {
      const job = jobBlocks(code(text)).get(jobId) ?? '';
      const first = steps(job)[0] ?? '';
      expect(first.startsWith(`      - name: ${stepName}\n`)).toBe(true);
      const envNames = promoter
        ? {
            VERDICT_APP_ID: 'CQ_VERDICT_APP_ID',
            VERDICT_CLIENT_ID: 'CQ_VERDICT_APP_CLIENT_ID',
            PROMOTER_APP_ID: 'CQ_PROMOTER_APP_ID',
            PROMOTER_CLIENT_ID: 'CQ_PROMOTER_APP_CLIENT_ID',
          }
        : { APP_ID: 'CQ_VERDICT_APP_ID', CLIENT_ID: 'CQ_VERDICT_APP_CLIENT_ID' };
      for (const [name, variable] of Object.entries(envNames)) {
        expect(first).toContain(`          ${name}: \${{ vars.${variable} }}`);
      }
      const script = runScript(job, stepName);
      expect(script).not.toContain('${{');
      const runWith = (env: Record<string, string>) =>
        spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          env: { PATH: process.env['PATH'] ?? '', ...env },
        });
      const pairs = promoter
        ? [
            ['VERDICT_APP_ID', 'VERDICT_CLIENT_ID'],
            ['PROMOTER_APP_ID', 'PROMOTER_CLIENT_ID'],
          ]
        : [['APP_ID', 'CLIENT_ID']];
      const blank = Object.fromEntries(Object.keys(envNames).map((k) => [k, '']));
      const full = Object.fromEntries(Object.keys(envNames).map((k) => [k, '123']));
      expect(runWith(blank).status).toBe(0);
      expect(runWith(full).status).toBe(0);
      for (const [id, client] of pairs) {
        for (const half of [id, client]) {
          const r = runWith({ ...blank, [half ?? '']: '123' });
          expect(r.status, `${half ?? ''} alone`).toBe(1);
          expect(r.stdout).toMatch(/refusing: set vars\.\S+ and/);
          expect(r.stdout).toMatch(/together \(exactly one is set\)/);
          const r2 = runWith({ ...full, [half === id ? (client ?? '') : (id ?? '')]: '' });
          expect(r2.status, `${half ?? ''} alone (other pair full)`).toBe(1);
        }
      }
    },
  );
});

// W1.10 review fix-forward — cq/acceptance posts are ordered per PR: judge
// holds a per-PR lock that resolve emits, so two runs for one PR never judge
// and post concurrently (an older snapshot can never post last).
describe('cq-accept serializes judge per PR (W1.10 Decision 10)', () => {
  it.each(bothCopies('cq-accept.yml'))(
    '%s: judge locks on resolve.outputs.lock; no workflow-level group',
    (_label, text) => {
      const body = code(text);
      expect(body).not.toMatch(/^concurrency:/m);
      const judge = jobBlocks(body).get('judge') ?? '';
      expect(judge).toMatch(
        /^ {4}concurrency:\n {6}group: cq-accept-\$\{\{ needs\.resolve\.outputs\.lock \}\}\n {6}cancel-in-progress: false$/m,
      );
      expect(jobBlocks(body).get('resolve')).toMatch(
        /^ {6}lock: \$\{\{ steps\.targets\.outputs\.lock \}\}$/m,
      );
    },
  );

  it.each(bothCopies('cq-accept.yml'))(
    '%s: resolve emits pr-<n> for a dispatch and sweep for the schedule',
    { timeout: 60_000 },
    (_label, text) => {
      const script = runScript(
        jobBlocks(code(text)).get('resolve') ?? '',
        'Verify the trigger and resolve the targets',
      );
      const SHA = '0123456789abcdef0123456789abcdef01234567';
      const pull = {
        number: 7,
        state: 'open',
        draft: false,
        head: { sha: SHA, repo: { id: 42 } },
        base: { ref: 'merge-queue' },
      };
      const shell = `gh() {
  [ "$1" = api ] || return 9
  shift
  [ "$1" = --paginate ] && shift
  local path="$1" data
  shift
  case "$path" in
    repos/o/r/pulls/7) data="$PULL";;
    repos/o/r/pulls\\?*) data="$PULLS";;
    *) return 9;;
  esac
  if [ "\${1:-}" = --jq ]; then jq -c "$2" <<<"$data"; else printf '%s\\n' "$data"; fi
}
${script}`;
      const dir = mkdtempSync(join(tmpdir(), 'cq-accept-lock-'));
      try {
        const out = join(dir, 'out');
        const lockFor = (env: Record<string, string>): string | undefined => {
          rmSync(out, { force: true });
          const r = spawnSync('bash', ['-c', shell], {
            encoding: 'utf8',
            env: {
              ...process.env,
              REPO: 'o/r',
              REPO_ID: '42',
              RUN_ID: '',
              PR_INPUT: '',
              PULL: JSON.stringify(pull),
              PULLS: JSON.stringify([pull, { ...pull, number: 8 }]),
              GITHUB_OUTPUT: out,
              ...env,
            },
          });
          expect(r.status, r.stderr + r.stdout).toBe(0);
          return /^lock=(.*)$/m.exec(readFileSync(out, 'utf8'))?.[1];
        };
        expect(lockFor({ EVENT: 'workflow_dispatch', PR_INPUT: '7' })).toBe('pr-7');
        expect(lockFor({ EVENT: 'schedule' })).toBe('sweep');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// W1.10 fresh-review fix — the post step's stale-verdict guard and the
// sweep's "unchanged" dedupe, run for real (bash + jq, `gh` stubbed and its
// argv and POSTed payloads recorded). Every row we post carries its SNAPSHOT
// time as `started_at` (the judge step's judged-at), so rows are modelled
// with started_at = snapshot time. The reference row is the same-app row
// with the latest snapshot (not the greatest id); a verdict is POSTed only
// when that snapshot is not later than its own, and the sweep re-posts only
// a verdict that differs from the reference row.
describe('cq-accept posts: stale-verdict guard and sweep dedupe (W1.10 Decision 10)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const JUDGED = '2026-09-27T10:00:00Z';
  const OLDER = '2026-09-27T09:59:00Z';
  const NEWER = '2026-09-27T10:00:05Z';
  const APP = '999';
  const POST = `api -X POST repos/o/r/check-runs --input`;
  type Row = {
    id: number;
    app: 'actions' | 'app';
    started: string;
    conclusion?: string;
    ext?: string;
  };
  const row = (r: Row) => ({
    id: r.id,
    app:
      r.app === 'actions'
        ? { id: 15368, slug: 'github-actions' }
        : { id: Number(APP), slug: 'cq-verdict' },
    conclusion: r.conclusion ?? 'success',
    external_id: r.ext ?? `trust:${SHA}`,
    started_at: r.started,
  });
  const STUB = `gh() {
  printf '%s\\n' "$*" >> "$ARGV_LOG"
  [ "$1" = api ] || return 9
  shift
  if [ "$1" = -X ]; then
    [ "$4" = --input ] || return 9
    cat "$5" >> "$POSTED_LOG"; echo >> "$POSTED_LOG"
    echo https://example.invalid/run; return 0
  fi
  [ "$1" = --paginate ] && shift
  local path="$1"
  shift
  case "$path" in
    "repos/o/r/commits/${SHA}/check-runs?check_name=cq/acceptance&filter=all&per_page=100") ;;
    *) return 9;;
  esac
  if [ "\${1:-}" = --jq ]; then jq -c "$2" <<<"$RUNS"; else printf '%s\\n' "$RUNS"; fi
}
`;

  it.each(bothCopies('cq-accept.yml'))(
    '%s: judge stamps the payload started_at with its snapshot time (judged-at)',
    { timeout: 60_000 },
    (_label, text) => {
      const script = runScript(
        jobBlocks(code(text)).get('judge') ?? '',
        "'Judge (CLI: selfhost/acceptance)'",
      );
      expect(script).not.toContain('${{');
      const dir = mkdtempSync(join(tmpdir(), 'cq-accept-judge-'));
      try {
        const node = `node() { printf '%s\\n' "$VERDICT"; }\n`;
        const r = spawnSync('bash', ['-c', node + script], {
          encoding: 'utf8',
          env: {
            PATH: process.env['PATH'] ?? '',
            RUNNER_TEMP: dir,
            GH_TOKEN: 'x',
            REPO: 'o/r',
            TRUST: 'trust',
            TARGETS: JSON.stringify([{ pr: 7, subject: SHA }]),
            VERDICT: JSON.stringify({
              status: 'ok',
              value: { verdict: 'pass', report: ['ok'] },
            }),
          },
        });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        const judged = readFileSync(join(dir, 'cq-accept', '7.judged-at'), 'utf8').trim();
        expect(judged).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        const payload = JSON.parse(
          readFileSync(join(dir, 'cq-accept', '7.check-run.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(payload['started_at']).toBe(judged);
        expect(payload['conclusion']).toBe('success');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(bothCopies('cq-accept.yml'))(
    '%s: posts only a verdict no newer same-app row supersedes',
    { timeout: 60_000 },
    (_label, text) => {
      const script = runScript(
        jobBlocks(code(text)).get('judge') ?? '',
        'Post the cq/acceptance check runs',
      );
      expect(script).not.toContain('${{');
      const dir = mkdtempSync(join(tmpdir(), 'cq-accept-post-'));
      try {
        const work = join(dir, 'cq-accept');
        mkdirSync(work);
        writeFileSync(join(work, 'crashed'), '');
        const argv = join(dir, 'argv');
        const postedLog = join(dir, 'posted');
        const run = (opts: {
          rows: Row[];
          event?: string;
          appId?: string;
          judged?: string;
          payloadStarted?: string;
        }): {
          status: number | null;
          posted: boolean;
          payloads: Array<Record<string, unknown>>;
          out: string;
        } => {
          writeFileSync(argv, '');
          writeFileSync(postedLog, '');
          const judged = opts.judged ?? JUDGED;
          writeFileSync(join(work, '7.judged-at'), `${judged}\n`);
          // What the judge step writes: the payload's started_at is judged-at.
          writeFileSync(
            join(work, '7.check-run.json'),
            JSON.stringify({
              name: 'cq/acceptance',
              head_sha: SHA,
              conclusion: 'success',
              external_id: `trust:${SHA}`,
              started_at: opts.payloadStarted ?? judged,
              output: { title: 'pass', summary: 'ok' },
            }),
          );
          const r = spawnSync('bash', ['-c', STUB + script], {
            encoding: 'utf8',
            env: {
              PATH: process.env['PATH'] ?? '',
              SHA,
              ARGV_LOG: argv,
              POSTED_LOG: postedLog,
              RUNNER_TEMP: dir,
              GITHUB_STEP_SUMMARY: join(dir, 'summary'),
              GH_TOKEN: 'x',
              EVENT: opts.event ?? 'workflow_run',
              REPO: 'o/r',
              VERDICT_APP_ID: opts.appId ?? '',
              TARGETS: JSON.stringify([{ pr: 7, subject: SHA }]),
              RUNS: JSON.stringify({ check_runs: opts.rows.map(row) }),
            },
          });
          const calls = readFileSync(argv, 'utf8').split('\n');
          const payloads = readFileSync(postedLog, 'utf8')
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          return {
            status: r.status,
            posted: calls.some((c) => c.startsWith(POST)),
            payloads,
            out: r.stdout + r.stderr,
          };
        };
        const expectRun = (
          opts: Parameters<typeof run>[0],
          posted: boolean,
          why: string,
        ): string => {
          const r = run(opts);
          expect(r.status, `${why}: ${r.out}`).toBe(0);
          expect(r.posted, `${why}: ${r.out}`).toBe(posted);
          // A POSTed row records its snapshot time, never a POST-time stamp.
          expect(
            r.payloads.map((p) => p['started_at']),
            why,
          ).toEqual(posted ? [opts.judged ?? JUDGED] : []);
          return r.out;
        };

        // The stale guard, interim (github-actions) mode.
        expect(expectRun({ rows: [] }, true, 'no prior row')).not.toMatch(/not posted/);
        expect(
          expectRun({ rows: [{ id: 3, app: 'actions', started: NEWER }] }, false, 'newer row'),
        ).toMatch(/a newer snapshot's verdict \(2026-09-27T10:00:05Z\) postdates this snapshot/);
        expectRun({ rows: [{ id: 3, app: 'actions', started: OLDER }] }, true, 'older row');
        expectRun({ rows: [{ id: 3, app: 'actions', started: JUDGED }] }, true, 'same second');

        // The reference row is the latest SNAPSHOT, not the greatest id.
        // Codex scenario: a sweep read an old snapshot (OLDER) but posted
        // after a per-PR run posted a newer one (NEWER), so the stale row
        // has the greater id and the earlier started_at.
        const lateStaleSweep: Row[] = [
          { id: 3, app: 'actions', started: NEWER, conclusion: 'failure' },
          { id: 5, app: 'actions', started: OLDER, conclusion: 'success' },
        ];
        // This run's snapshot (JUDGED) is older than the id-3 row's: skipped,
        // although the greatest-id row (id 5) is older than it.
        expect(expectRun({ rows: lateStaleSweep }, false, 'older id, later snapshot wins')).toMatch(
          /a newer snapshot's verdict \(2026-09-27T10:00:05Z\) postdates/,
        );
        // A run whose snapshot is the newest still posts over both.
        expectRun(
          { rows: lateStaleSweep, judged: '2026-09-27T10:00:09Z' },
          true,
          'newest snapshot posts',
        );
        // The other ordering: the newer snapshot also has the newer id.
        expectRun(
          {
            rows: [
              { id: 3, app: 'actions', started: OLDER },
              { id: 5, app: 'actions', started: NEWER },
            ],
          },
          false,
          'newer id, later snapshot',
        );
        // The stale sweep itself (snapshot OLDER), arriving after the newer
        // snapshot's row (id 3, NEWER), is skipped — not posted over it.
        expectRun(
          {
            rows: [{ id: 3, app: 'actions', started: NEWER, conclusion: 'failure' }],
            judged: OLDER,
            event: 'schedule',
          },
          false,
          'stale sweep verdict skipped',
        );
        // Tie on started_at: the greater id is the reference row.
        const tie: Row[] = [
          { id: 5, app: 'actions', started: OLDER, conclusion: 'failure' },
          { id: 3, app: 'actions', started: OLDER, conclusion: 'success' },
        ];
        expectRun({ rows: tie, event: 'schedule' }, true, 'tie → greater id (failure) differs');
        expectRun(
          {
            rows: [
              { id: 5, app: 'actions', started: OLDER, conclusion: 'success' },
              { id: 3, app: 'actions', started: OLDER, conclusion: 'failure' },
            ],
            event: 'schedule',
          },
          false,
          'tie → greater id (success) unchanged',
        );

        // The sweep dedupes against the latest-snapshot row, not the
        // greatest id: the greatest-id row matches, the reference does not.
        expectRun(
          { rows: lateStaleSweep, judged: '2026-09-27T10:00:09Z', event: 'schedule' },
          true,
          'sweep dedupes on the reference row',
        );

        // Same-app selection: each mode ignores the other app's rows.
        const actionsNewer: Row[] = [
          { id: 3, app: 'app', started: OLDER },
          { id: 5, app: 'actions', started: NEWER },
        ];
        const appNewer: Row[] = [
          { id: 3, app: 'actions', started: OLDER },
          { id: 5, app: 'app', started: NEWER },
        ];
        expectRun({ rows: actionsNewer, appId: APP }, true, 'App mode ignores actions');
        expectRun({ rows: appNewer, appId: APP }, false, 'App mode, newer App row');
        expectRun({ rows: appNewer }, true, 'interim mode ignores the App');
        expectRun({ rows: actionsNewer }, false, 'interim mode, newer actions row');

        // The sweep re-posts only a changed verdict.
        expect(
          expectRun(
            { rows: [{ id: 3, app: 'actions', started: OLDER }], event: 'schedule' },
            false,
            'sweep, unchanged',
          ),
        ).toMatch(/#7: unchanged \(success\) — not re-posted/);
        expectRun(
          {
            rows: [{ id: 3, app: 'actions', started: OLDER, conclusion: 'failure' }],
            event: 'schedule',
          },
          true,
          'sweep, conclusion changed',
        );
        expectRun(
          {
            rows: [{ id: 3, app: 'actions', started: OLDER, ext: `other:${SHA}` }],
            event: 'schedule',
          },
          true,
          'sweep, binding changed',
        );
        expectRun(
          { rows: [{ id: 3, app: 'app', started: OLDER }], event: 'schedule' },
          true,
          'sweep, unchanged row from the other app only',
        );

        // A payload whose started_at is not judged-at refuses.
        {
          const r = run({ rows: [], payloadStarted: NEWER });
          expect(r.status).toBe(1);
          expect(r.out).toContain('refusing: #7 payload started_at is not judged-at');
          expect(r.posted).toBe(false);
        }

        // A malformed judged-at refuses before any read or post.
        for (const judged of ['', 'yesterday', '2026-09-27 10:00:00Z', `${JUDGED}x`]) {
          const r = run({ rows: [], judged });
          expect(r.status, `judged-at '${judged}'`).toBe(1);
          expect(r.out).toContain('refusing: judged-at');
          expect(r.posted).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
