// Split from policy-provenance.test.ts: the cq-policy resolver, verdict
// guard and posting programs behave as documented (bash + jq, gh stubbed).
// Shared helpers live in policy-provenance.helpers.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bothCopies, code, jobBlocks, runScript } from './policy-provenance.helpers.js';

describe('cq-policy programs behave as documented (bash + jq, gh stubbed)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const resolveScript = (text: string) =>
    runScript(
      jobBlocks(code(text)).get('resolve') ?? '',
      'Verify the triggering run and resolve the subject',
    );
  const judgeJob = (text: string) => jobBlocks(code(text)).get('judge') ?? '';

  it.each(bothCopies('cq-policy.yml'))(
    '%s: resolve accepts PR/review/push runs, skips an unjudgeable head, refuses fork, path, event, ambiguity',
    { timeout: 120_000 },
    (_label, text) => {
      // The commit→PR list is answered only when paginated, as two pages
      // (PULLS_PAGE2 defaults to an empty page). Once PULLS_LATE is set,
      // every query after the first answers with it: an association that
      // lags the push. PULLS_FAIL makes the list call an API error.
      const shell = `gh() {
  [ "$1" = api ] || return 9
  local pg='' data
  if [ "$2" = --paginate ]; then pg=1; shift; fi
  case "$pg:$2" in
    ":repos/owner/repo/actions/runs/$RUN_ID") data="$RUN_DATA";;
    "1:repos/owner/repo/commits/${SHA}/pulls?per_page=100")
      [ -z "\${PULLS_FAIL:-}" ] || return 22
      if [ -n "\${PULLS_LATE:-}" ] && [ -e "$QUERIED" ]; then
        data="$PULLS_LATE"
      else
        : > "$QUERIED"
        data="$PULLS_DATA"
      fi
      printf '%s\\n' "$data" "\${PULLS_PAGE2:-[]}"
      return 0;;
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
      const queried = join(dir, 'queried');
      const check = (
        run: Record<string, unknown>,
        pulls: unknown[] = [pull('main')],
        extra: Record<string, string> = {},
      ) => {
        rmSync(outputPath, { force: true });
        rmSync(queried, { force: true });
        const result = spawnSync('bash', ['-c', shell], {
          encoding: 'utf8',
          env: {
            ...process.env,
            RUN_ID: '123',
            RUN_DATA: JSON.stringify(run),
            PULLS_DATA: JSON.stringify(pulls),
            QUERIED: queried,
            CQ_ASSOC_RETRY_SECONDS: '0',
            ...extra,
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
            pull('main'),
          ]);
          expect(ok.status, ok.stderr + ok.stdout).toBe(0);
          expect(ok.outputs).toBe(`subject=${SHA}\nkind=pr\nbase=main\npr=7\n`);
        }
        // The match on a later page counts: every page is read.
        const paged = check(valid, [pull('other')], {
          PULLS_PAGE2: JSON.stringify([pull('main')]),
        });
        expect(paged.status, paged.stderr + paged.stdout).toBe(0);
        expect(paged.outputs).toBe(`subject=${SHA}\nkind=pr\nbase=main\npr=7\n`);
        // A lagging association is looked up once more before any skip.
        const late = check(valid, [], { PULLS_LATE: JSON.stringify([pull('main')]) });
        expect(late.status, late.stderr + late.stdout).toBe(0);
        expect(late.outputs).toBe(`subject=${SHA}\nkind=pr\nbase=main\npr=7\n`);
        const push = check({ ...valid, event: 'push', head_branch: 'main' }, []);
        expect(push.status).not.toBe(0);
        expect(push.outputs).toBe('');
        for (const [label, run, pulls] of [
          ['path', { ...valid, path: '.github/workflows/other.yml' }, undefined],
          ['fork', { ...valid, head_repository: { id: 43 } }, undefined],
          ['event', { ...valid, event: 'pull_request_target' }, undefined],
          ['head SHA shape', { ...valid, head_sha: 'not-a-sha' }, undefined],
          ['push branch', { ...valid, event: 'push', head_branch: 'main' }, undefined],
          ['ambiguous PR', valid, [pull('main'), pull('main', { number: 8 })]],
        ] as const) {
          const refused = check(run, pulls === undefined ? undefined : [...pulls]);
          expect(refused.status, `${label}: ${refused.stdout}`).toBe(1);
          expect(refused.outputs, label).toBe('');
        }
        // Nothing to judge (cq-accept's rule): no verdict is owed, so the
        // job is green with no subject output and judge is skipped.
        for (const [label, pulls] of [
          ['no PR', []],
          ['fork PR', [pull('main', { head: { sha: SHA, repo: { id: 43 } } })]],
          ['stale PR head', [pull('main', { head: { sha: 'f'.repeat(40), repo: { id: 42 } } })]],
          ['closed PR', [pull('main', { state: 'closed' })]],
          ['another base', [pull('codex/stack')]],
        ] as const) {
          const skipped = check(valid, [...pulls]);
          expect(skipped.status, `${label}: ${skipped.stdout}`).toBe(0);
          expect(skipped.outputs, label).toBe('');
          expect(skipped.stdout, label).toContain('nothing to judge');
          // An empty same-repo association is unconfirmed, not superseded.
          expect(skipped.stdout.includes('association unconfirmed'), label).toBe(
            label === 'no PR' || label === 'fork PR',
          );
        }
        // An API error fails closed: no skip, no subject.
        const failed = check(valid, [], { PULLS_FAIL: '1' });
        expect(failed.status, failed.stdout).not.toBe(0);
        expect(failed.outputs).toBe('');
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
      const post = (verdict: string, advisory = false) => {
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
            ADVISORY: String(advisory),
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
        // A non-pass verdict is a red check run, not a red job.
        const human = post(ok('needs-human', ['protected-path policy/x', 'override: dormant']));
        expect(human.status, human.stderr).toBe(0);
        expect(human.posted?.conclusion).toBe('failure');
        expect(human.posted?.output.title).toBe('needs-human (D11)');
        expect(human.posted?.output.summary).toContain(
          'protected-path policy/x\noverride: dormant',
        );
        expect(human.summary).toContain('override: dormant');
        const mainHuman = post(ok('needs-human', ['advisory finding']), true);
        expect(mainHuman.status, mainHuman.stderr).toBe(0);
        expect(mainHuman.posted?.conclusion).toBe('neutral');
        expect(mainHuman.posted?.output.summary).toContain('advisory finding');
        const fail = post(ok('fail', ['lint']));
        expect(fail.status, fail.stderr).toBe(0);
        expect(fail.posted?.conclusion).toBe('failure');
        expect(fail.posted?.output.title).toBe('policy: fail');
        // Only a verifier crash fails the job (after posting the row).
        const crashed = post('{"status":"failed","error":"boom"}');
        expect(crashed.status).toBe(1);
        expect(crashed.posted?.conclusion).toBe('failure');
        expect(crashed.posted?.output.title).toBe('policy: check failed');
        expect(crashed.posted?.output.summary).toContain('boom');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
