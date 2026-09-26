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
//      runs, holds no environment and no secret but GITHUB_TOKEN, checks out
//      only the trust ref with no persisted credential, never runs head code,
//      reads the posture from `vars.*`, and posts `cq/policy`.
//   4. The resolver, verdict guard and posting programs behave as documented
//      when actually run (bash + jq, with `gh` stubbed).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    '%s: default-branch carrier, no environment, GITHUB_TOKEN only',
    (_label, text) => {
      const body = code(text);
      const on = onBlock(body);
      expect(on).toMatch(/^ {2}workflow_run:\n {4}workflows:\n {6}- cq-signal\n/m);
      expect(on).toMatch(/^ {4}types:\n {6}- completed$/m);
      expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
      expect(on).not.toMatch(/pull_request|push:/);
      expect(body).toMatch(/^permissions: \{\}$/m);
      expect([...jobBlocks(body).keys()]).toEqual(['resolve', 'judge']);
      expect(body).not.toMatch(/^\s*environment:/m);
      // The only secret is GITHUB_TOKEN (spelled `github.token` here).
      for (const m of body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
        expect(m[1]).toBe('GITHUB_TOKEN');
      }
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
      expect(judge).toContain('name: "cq/policy"');
      expect(judge).toContain('external_id: $ext');
      expect(judge).toContain('--arg ext "${TRUST}:${SUBJECT}"');
      expect(judge).toContain('$GITHUB_STEP_SUMMARY');
      expect(judge).toContain('policy check emitted no valid JSON result');
      // The fetch credential lives in the fetch step's env only.
      const tokenSteps = steps(judge).filter((s) => s.includes('${{ github.token }}'));
      expect(tokenSteps.map((s) => s.split('\n')[0])).toEqual([
        '      - name: Fetch the subject, base and cq-state objects (no checkout)',
        '      - name: Fetch the PR timeline label events (API data, not head bytes)',
        '      - name: Post the cq/policy check run and the run report',
      ]);
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
