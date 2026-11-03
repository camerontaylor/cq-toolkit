// Split from policy-provenance.test.ts: App variable pairs are refused
// half-set (W1.10 Decisions 6, 7). Shared helpers live in
// policy-provenance.helpers.ts.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { bothCopies, code, jobBlocks, runScript, steps } from './policy-provenance.helpers.js';

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
