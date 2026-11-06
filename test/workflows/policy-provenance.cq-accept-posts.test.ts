// Split from policy-provenance.test.ts: cq-accept posts — the stale-verdict
// guard and the sweep dedupe (W1.10 Decision 10). Shared helpers live in
// policy-provenance.helpers.ts.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bothCopies, code, jobBlocks, runScript } from './policy-provenance.helpers.js';

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
  const TRUST_SHA = '89abcdef0123456789abcdef0123456789abcdef';
  // This run's clock (the step's `date -u +%s`, stubbed): ten minutes
  // after JUDGED, so every fixture row is in the past.
  const NOW_EPOCH = String(Date.parse('2026-09-27T10:10:00Z') / 1000);
  const POST = `api -X POST repos/o/r/check-runs --input`;
  type Row = {
    id: number;
    app: 'actions' | 'app';
    started: string;
    // Defaults to `started` (our rows post completed_at = snapshot time); a
    // row posted before that fix carries GitHub's POST time instead.
    completed?: string;
    conclusion?: string;
    ext?: string;
    // Defaults to the post-step fixture payload's title.
    title?: string;
  };
  const row = (r: Row) => ({
    id: r.id,
    app:
      r.app === 'actions'
        ? { id: 15368, slug: 'github-actions' }
        : { id: Number(APP), slug: 'cq-verdict' },
    conclusion: r.conclusion ?? 'success',
    external_id: r.ext ?? `${TRUST_SHA}:${SHA}`,
    started_at: r.started,
    completed_at: r.completed ?? r.started,
    output: { title: r.title ?? 'pass' },
  });
  const STUB = `date() {
  if [ "$*" = '-u +%s' ]; then echo "$NOW_EPOCH"; else command date "$@"; fi
}
gh() {
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
    '%s: judge stamps the payload started_at and completed_at with its snapshot time (judged-at)',
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
        // completed_at is the snapshot time too, never GitHub's POST time.
        expect(payload['completed_at']).toBe(judged);
        expect(payload['conclusion']).toBe('neutral');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(bothCopies('cq-accept.yml'))(
    '%s: an interim (no verdict App) row labels itself unauthenticated; App mode does not',
    { timeout: 60_000 },
    (_label, text) => {
      const script = runScript(
        jobBlocks(code(text)).get('judge') ?? '',
        "'Judge (CLI: selfhost/acceptance)'",
      );
      const judge = (appId: string | undefined) => {
        const dir = mkdtempSync(join(tmpdir(), 'cq-accept-mode-'));
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
              ...(appId === undefined ? {} : { VERDICT_APP_ID: appId }),
              TARGETS: JSON.stringify([{ pr: 7, subject: SHA }]),
              VERDICT: JSON.stringify({
                status: 'ok',
                value: { verdict: 'pass', report: ['ok'] },
              }),
            },
          });
          expect(r.status, r.stdout + r.stderr).toBe(0);
          return (
            JSON.parse(readFileSync(join(dir, 'cq-accept', '7.check-run.json'), 'utf8')) as {
              output: { title: string; summary: string };
            }
          ).output;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };
      for (const interim of [judge(''), judge(undefined)]) {
        expect(interim.title).toBe('acceptance: pass (#7) (interim: unauthenticated)');
        expect(interim.summary).toMatch(/Interim mode: no verdict App is registered/);
      }
      // App mode is unchanged: the exact pre-label title and summary.
      const app = judge('5113217');
      expect(app.title).toBe('acceptance: pass (#7)');
      expect(app.summary).toBe(`\`\`\`text\nok\n\`\`\`\n\ntrust ref \`trust:${SHA}\``);
    },
  );

  it.each(bothCopies('cq-accept.yml'))(
    '%s: posts only a verdict no newer same-app row supersedes',
    // ~45 bash + jq runs of the post step: slow on a loaded host.
    { timeout: 180_000 },
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
          payloadCompleted?: string;
          conclusion?: string;
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
              conclusion: opts.conclusion ?? 'success',
              external_id: `${TRUST_SHA}:${SHA}`,
              started_at: opts.payloadStarted ?? judged,
              completed_at: opts.payloadCompleted ?? judged,
              output: { title: 'pass', summary: 'ok' },
            }),
          );
          const r = spawnSync('bash', ['-c', STUB + script], {
            encoding: 'utf8',
            env: {
              PATH: process.env['PATH'] ?? '',
              SHA,
              NOW_EPOCH,
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
            r.payloads.map((p) => [p['started_at'], p['completed_at']]),
            why,
          ).toEqual(posted ? [[opts.judged ?? JUDGED, opts.judged ?? JUDGED]] : []);
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

        // B/C (fresh-review r3 #1): B is a per-PR failure at a later
        // snapshot, posted first; C is a stale sweep success at an earlier
        // snapshot, posted later, as rows were before they carried
        // completed_at (GitHub stamped C's POST time, so C is GitHub's
        // latest row). A later sweep that judges failure matches the
        // reference row B but must still post: the latest-completed row (C)
        // is not the reference row.
        const bc: Row[] = [
          { id: 3, app: 'actions', started: NEWER, conclusion: 'failure' },
          {
            id: 5,
            app: 'actions',
            started: OLDER,
            completed: '2026-09-27T10:00:07Z',
            conclusion: 'success',
          },
        ];
        const bcJudged = '2026-09-27T10:00:09Z';
        expect(
          expectRun(
            { rows: bc, judged: bcJudged, conclusion: 'failure', event: 'schedule' },
            true,
            'B/C: stale latest-completed row re-posted over',
          ),
        ).not.toMatch(/unchanged/);
        // Once B is also the latest-completed row, the sweep dedupes again.
        expect(
          expectRun(
            {
              rows: [bc[0] as Row, { ...(bc[1] as Row), completed: OLDER }],
              judged: bcJudged,
              conclusion: 'failure',
              event: 'schedule',
            },
            false,
            'B/C healed: reference row is the latest-completed row',
          ),
        ).toMatch(/#7: unchanged \(failure\) — not re-posted/);
        // A latest-completed row with a completed_at past the ceiling is
        // ignored (it cannot force a re-post every sweep).
        expectRun(
          {
            rows: [bc[0] as Row, { ...(bc[1] as Row), completed: '2099-01-01T00:00:00Z' }],
            judged: bcJudged,
            conclusion: 'failure',
            event: 'schedule',
          },
          false,
          'future-completed row ignored for the latest-completed check',
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
            rows: [{ id: 3, app: 'actions', started: OLDER, title: 'acceptance: pass (#7)' }],
            event: 'schedule',
          },
          true,
          'sweep, title changed (a row from before the interim label)',
        );
        expectRun(
          {
            rows: [{ id: 3, app: 'actions', started: OLDER, ext: `${'0'.repeat(40)}:${SHA}` }],
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

        // Forged interim rows cannot become sticky (r2 #4): a row dated
        // past this run's clock + 120 s skew is ignored, and so is a row
        // whose external_id is not exactly `<40-hex>:<this head>`.
        for (const started of ['2099-01-01T00:00:00Z', '2026-09-27T10:12:01Z']) {
          expect(
            expectRun(
              { rows: [{ id: 9, app: 'actions', started, conclusion: 'failure' }] },
              true,
              `future-dated row ${started} ignored`,
            ),
          ).not.toMatch(/not posted/);
        }
        // Within the skew it still counts.
        expectRun(
          { rows: [{ id: 9, app: 'actions', started: '2026-09-27T10:12:00Z' }] },
          false,
          'row within the skew',
        );
        // The sweep never dedupes against a future-dated row either.
        expectRun(
          { rows: [{ id: 9, app: 'actions', started: '2099-01-01T00:00:00Z' }], event: 'schedule' },
          true,
          'sweep ignores a future-dated row',
        );
        for (const ext of [
          `trust:${SHA}`,
          `${TRUST_SHA}:${'1'.repeat(40)}`,
          `${TRUST_SHA}:${SHA}x`,
          `${TRUST_SHA.toUpperCase()}:${SHA}`,
          '',
        ]) {
          expect(
            expectRun(
              { rows: [{ id: 9, app: 'actions', started: NEWER, ext }] },
              true,
              `malformed external_id '${ext}' ignored`,
            ),
          ).not.toMatch(/not posted/);
        }

        // A payload whose started_at or completed_at is not judged-at
        // refuses.
        for (const bad of [{ payloadStarted: NEWER }, { payloadCompleted: NEWER }]) {
          const r = run({ rows: [], ...bad });
          expect(r.status).toBe(1);
          expect(r.out).toContain('refusing: #7 payload started_at/completed_at is not judged-at');
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

  it.each(bothCopies('cq-accept.yml'))(
    '%s: the future bound is read per PR, so a long sweep honours a newer row',
    { timeout: 60_000 },
    (_label, text) => {
      const script = runScript(
        jobBlocks(code(text)).get('judge') ?? '',
        'Post the cq/acceptance check runs',
      );
      const dir = mkdtempSync(join(tmpdir(), 'cq-accept-clock-'));
      try {
        const work = join(dir, 'cq-accept');
        mkdirSync(work);
        writeFileSync(join(work, 'crashed'), '');
        const argv = join(dir, 'argv');
        const postedLog = join(dir, 'posted');
        writeFileSync(argv, '');
        writeFileSync(postedLog, '');
        // The clock advances ten minutes per read: PR 7 reads 10:10:00,
        // PR 8 reads 10:20:00 (the step started at 10:10:00).
        const clock = join(dir, 'clock');
        writeFileSync(clock, NOW_EPOCH);
        const tick = `date() {
  if [ "$*" = '-u +%s' ]; then
    local t; t="$(cat "$CLOCK")"; echo $((t + 600)) > "$CLOCK"; echo "$t"
  else command date "$@"; fi
}
`;
        for (const pr of [7, 8]) {
          writeFileSync(join(work, `${String(pr)}.judged-at`), `${JUDGED}\n`);
          writeFileSync(
            join(work, `${String(pr)}.check-run.json`),
            JSON.stringify({
              name: 'cq/acceptance',
              head_sha: SHA,
              conclusion: 'success',
              external_id: `${TRUST_SHA}:${SHA}`,
              started_at: JUDGED,
              completed_at: JUDGED,
              output: { title: `pass #${String(pr)}`, summary: 'ok' },
            }),
          );
        }
        // A row newer than this snapshot, dated 10:15:00: past the step
        // start's ceiling (10:12:00) but within PR 8's (10:22:00).
        const r = spawnSync('bash', ['-c', STUB + tick + script], {
          encoding: 'utf8',
          env: {
            PATH: process.env['PATH'] ?? '',
            SHA,
            CLOCK: clock,
            ARGV_LOG: argv,
            POSTED_LOG: postedLog,
            RUNNER_TEMP: dir,
            GITHUB_STEP_SUMMARY: join(dir, 'summary'),
            GH_TOKEN: 'x',
            EVENT: 'schedule',
            REPO: 'o/r',
            VERDICT_APP_ID: '',
            TARGETS: JSON.stringify([
              { pr: 7, subject: SHA },
              { pr: 8, subject: SHA },
            ]),
            RUNS: JSON.stringify({
              check_runs: [
                row({
                  id: 9,
                  app: 'actions',
                  started: '2026-09-27T10:15:00Z',
                  conclusion: 'failure',
                }),
              ],
            }),
          },
        });
        const out = r.stdout + r.stderr;
        expect(r.status, out).toBe(0);
        const titles = readFileSync(postedLog, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => (JSON.parse(line) as { output: { title: string } }).output.title);
        // PR 7's clock puts the row past its ceiling (ignored → posted);
        // PR 8's later clock honours it (a newer snapshot → not posted).
        expect(titles, out).toEqual(['pass #7']);
        expect(out).toMatch(
          /#8: a newer snapshot's verdict \(2026-09-27T10:15:00Z\) postdates this snapshot/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
