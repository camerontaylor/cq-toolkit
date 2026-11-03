// Split from policy-provenance.test.ts: cq-accept serializes judge per PR
// (W1.10 Decision 10) and reads every page of the commit→PR list (#280).
// Shared helpers live in policy-provenance.helpers.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bothCopies, code, jobBlocks, runScript } from './policy-provenance.helpers.js';

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
        base: { ref: 'main' },
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

  it.each(bothCopies('cq-accept.yml'))(
    '%s: the sweep judges a rotating 25-PR window, cursor from the 15-minute clock slot, that reaches every eligible PR',
    { timeout: 60_000 },
    (_label, text) => {
      const script = runScript(
        jobBlocks(code(text)).get('resolve') ?? '',
        'Verify the trigger and resolve the targets',
      );
      const SHA = '0123456789abcdef0123456789abcdef01234567';
      const shell = `gh() {
  [ "$1" = api ] || return 9
  shift
  [ "$1" = --paginate ] && shift
  case "$1" in
    repos/o/r/pulls\\?*) jq -c "$3" <<<"$PULLS";;
    *) return 9;;
  esac
}
date() {
  [ "$*" = '-u +%s' ] || return 9
  printf '%s\\n' "$NOW"
}
${script}`;
      const pull = (n: number, over: Record<string, unknown> = {}) => ({
        number: n,
        state: 'open',
        draft: false,
        head: { sha: SHA, repo: { id: 42 } },
        base: { ref: 'main' },
        ...over,
      });
      const dir = mkdtempSync(join(tmpdir(), 'cq-accept-sweep-'));
      try {
        const out = join(dir, 'out');
        // The clock at a given 15-minute slot, some seconds into it (a late
        // firing lands anywhere inside its slot).
        const at = (slot: number, into = 437): string => String(slot * 900 + into);
        const sweep = (pulls: unknown[], slot: number | string = 0) => {
          writeFileSync(out, '');
          const r = spawnSync('bash', ['-c', shell], {
            encoding: 'utf8',
            env: {
              ...process.env,
              EVENT: 'schedule',
              REPO: 'o/r',
              REPO_ID: '42',
              RUN_ID: '',
              PR_INPUT: '',
              PULLS: JSON.stringify(pulls),
              NOW: typeof slot === 'number' ? at(slot) : slot,
              GITHUB_OUTPUT: out,
            },
          });
          const targets = /^targets=(.*)$/m.exec(readFileSync(out, 'utf8'))?.[1];
          return {
            status: r.status,
            out: r.stdout + r.stderr,
            targets: targets === undefined ? undefined : (JSON.parse(targets) as unknown[]),
          };
        };
        const ids = (r: ReturnType<typeof sweep>) =>
          (r.targets as Array<{ pr: number; subject: string }> | undefined)?.map((t) => t.pr);
        const range = (from: number, to: number) =>
          Array.from({ length: to - from + 1 }, (_, i) => from + i);
        // 45 eligible PRs, listed out of order, plus ineligible ones (a
        // draft, a fork): sorted by number, windows of 25 that wrap.
        const eligible = Array.from({ length: 45 }, (_, i) => pull(45 - i));
        const all = [
          pull(100, { draft: true }),
          ...eligible,
          pull(101, { head: { sha: SHA, repo: { id: 7 } } }),
        ];
        const windows = [0, 1, 2].map((n) => {
          const r = sweep(all, n);
          expect(r.status, r.out).toBe(0);
          expect(r.targets).toHaveLength(25);
          expect(r.targets?.every((t) => (t as { subject: string }).subject === SHA)).toBe(true);
          return ids(r);
        });
        expect(windows[0]).toEqual(range(1, 25));
        expect(windows[1]).toEqual([...range(26, 45), ...range(1, 5)]);
        expect(windows[2]).toEqual(range(6, 30));
        // The cursor is the slot alone: the second within it does not move
        // the window, and no run count is read.
        const onTime = sweep(all, 1);
        const late = sweep(all, at(1, 899));
        expect(ids(late)).toEqual(ids(onTime));
        expect(late.out).toMatch(/slot 1: 45 eligible PRs; judging 25 from index 25/);
        // ceil(45 / 25) = 2 consecutive slots reach every eligible PR, from
        // any starting slot (a present-day one included); drafts and forks
        // are never judged.
        for (const start of [0, 1, 7, 1_000_003, Math.floor(1_790_000_000 / 900)]) {
          const seen = new Set([
            ...(ids(sweep(all, start)) ?? []),
            ...(ids(sweep(all, start + 1)) ?? []),
          ]);
          expect(
            [...seen].sort((a, b) => a - b),
            `from slot ${String(start)}`,
          ).toEqual(range(1, 45));
        }
        // At most one window: every eligible PR, sorted, whatever the slot.
        for (const n of [0, 3]) {
          const few = sweep([pull(9), pull(100, { draft: true }), pull(2), pull(5)], n);
          expect(few.status, few.out).toBe(0);
          expect(ids(few)).toEqual([2, 5, 9]);
          expect(
            ids(
              sweep(
                Array.from({ length: 25 }, (_, i) => pull(25 - i)),
                n,
              ),
            ),
          ).toEqual(range(1, 25));
        }
        // A malformed clock refuses, and no targets are emitted.
        for (const clock of ['-1', '', 'soon', '12a', '0900']) {
          const bad = sweep(all, clock);
          expect(bad.status, `clock '${clock}': ${bad.out}`).toBe(1);
          expect(bad.out).toMatch(/refusing: clock/);
          expect(bad.targets).toBeUndefined();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// The resolve step's commit→PR lookup is a REST list (30 per page by
// default), so it reads EVERY page (#280; the repo rule that REST lists
// paginate — as cq-policy and cq-verify have done since 26150b1) and fails
// closed on an API error: a partial read must never drop the PR whose head
// is the subject, nor let an errored lookup pass as "nothing to judge".
describe('cq-accept resolve reads every page of the commit→PR list (#280)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  it.each(bothCopies('cq-accept.yml'))(
    '%s: a match on a later page is judged; ambiguity or an API error fails the step',
    { timeout: 60_000 },
    (_label, text) => {
      const script = runScript(
        jobBlocks(code(text)).get('resolve') ?? '',
        'Verify the trigger and resolve the targets',
      );
      // The commit→PR list is answered ONLY in its paginated form, as two
      // pages (PULLS_PAGE2 defaults to an empty page). PULLS_FAIL makes the
      // list call an API error.
      const shell = `gh() {
  [ "$1" = api ] || return 9
  local pg='' data
  if [ "$2" = --paginate ]; then pg=1; shift; fi
  case "$pg:$2" in
    ":repos/o/r/actions/runs/$RUN_ID") data="$RUN_DATA";;
    "1:repos/o/r/commits/${SHA}/pulls?per_page=100")
      [ -z "\${PULLS_FAIL:-}" ] || return 22
      printf '%s\\n' "$PULLS_DATA" "\${PULLS_PAGE2:-[]}"
      return 0;;
    *) return 9;;
  esac
  printf '%s\\n' "$data"
}
${script}`;
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
      const dir = mkdtempSync(join(tmpdir(), 'cq-accept-pages-'));
      const outputPath = join(dir, 'github-output');
      const check = (pulls: unknown[], extra: Record<string, string> = {}) => {
        rmSync(outputPath, { force: true });
        const r = spawnSync('bash', ['-c', shell], {
          encoding: 'utf8',
          env: {
            ...process.env,
            EVENT: 'workflow_run',
            RUN_ID: '123',
            RUN_DATA: JSON.stringify(valid),
            PULLS_DATA: JSON.stringify(pulls),
            REPO: 'o/r',
            REPO_ID: '42',
            GITHUB_OUTPUT: outputPath,
            ...extra,
          },
        });
        return {
          ...r,
          outputs: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
        };
      };
      try {
        // The PR on the SECOND page is judged anyway: every page is read,
        // so the target is emitted and judge locks pr-7.
        const paged = check([pull('other')], {
          PULLS_PAGE2: JSON.stringify([pull('main')]),
        });
        expect(paged.status, paged.stderr + paged.stdout).toBe(0);
        expect(paged.outputs).toBe(`targets=[{"pr":7,"subject":"${SHA}"}]\nlock=pr-7\n`);
        // The one match split across the two pages is still one match.
        const split = check([], { PULLS_PAGE2: JSON.stringify([pull('main')]) });
        expect(split.status, split.stderr + split.stdout).toBe(0);
        expect(split.outputs).toBe(`targets=[{"pr":7,"subject":"${SHA}"}]\nlock=pr-7\n`);
        // Two matches across the pages refuse: the slurped array is one.
        const ambiguous = check([pull('main')], {
          PULLS_PAGE2: JSON.stringify([pull('main', { number: 8 })]),
        });
        expect(ambiguous.status, ambiguous.stdout).toBe(1);
        expect(ambiguous.outputs).toBe('');
        // An API error fails closed: the step refuses, no targets are
        // emitted, judge never runs.
        const failed = check([pull('main')], { PULLS_FAIL: '1' });
        expect(failed.status, failed.stdout).not.toBe(0);
        expect(failed.outputs).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
