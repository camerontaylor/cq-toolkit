// Split from policy-provenance.test.ts: cq-policy runs trusted code over
// head data (ADR-0004 D-B, D-G, D-H.2). Shared helpers live in
// policy-provenance.helpers.ts.
import { describe, expect, it } from 'vitest';
import { bothCopies, code, jobBlocks, onBlock, steps } from './policy-provenance.helpers.js';

describe('cq-policy runs trusted code over head data (ADR-0004 D-B, D-G, D-H.2)', () => {
  it.each(bothCopies('cq-policy.yml'))(
    '%s: default-branch carrier, judge signs in cq-verdict, no other secret',
    (_label, text) => {
      const body = code(text);
      const on = onBlock(body);
      expect(on).toMatch(/^ {2}workflow_run:\n {4}workflows:\n {6}- cq-signal\n/m);
      expect(on).toMatch(/^ {4}types:\n {6}- completed$/m);
      expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
      expect(on).toMatch(/^ {2}pull_request:$/m);
      expect(on).not.toMatch(/branches:/);
      expect(on).not.toMatch(/pull_request_target|push:/);
      expect(body).toMatch(/^permissions: \{\}$/m);
      expect([...jobBlocks(body).keys()]).toEqual(['main-advisory', 'resolve', 'judge']);
      const advisory = jobBlocks(body).get('main-advisory') ?? '';
      expect(advisory).toContain("if: github.event_name == 'pull_request'");
      expect(advisory).toContain('permissions: {}');
      expect(advisory).not.toMatch(/uses:|secrets\./);
      expect(jobBlocks(body).get('resolve')).toContain("github.event_name != 'pull_request'");
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
      for (const step of steps(judge).filter((s) => /\bpnpm (?:install|run|exec)\b/.test(s))) {
        expect(step).toMatch(/^ {8}working-directory: trust$/m);
      }
      for (const install of body.matchAll(/pnpm install[^\n]*/g)) {
        expect(install[0]).toContain('--ignore-scripts');
      }
      // The only node invocation is the in-process policy check (R1): never
      // the CLI, which loads every op registry.
      for (const m of body.matchAll(/\bnode (\S+)/g)) {
        expect(m[1]).toBe('trust/dist/selfhost/policy-diff.js');
      }
      expect(body).not.toMatch(/\bnpx\b|\bpnpm exec\b|vitest|pnpm test|pnpm run test/);
      // The head is fetched as objects, never materialised as a tree.
      expect(body).not.toMatch(/git (?:-C \S+ )?(?:checkout|switch|worktree|archive|reset)/);
      expect(body).not.toMatch(/actions\/(?:download|upload)-artifact/);
      expect(judge).toContain('git -C trust fetch --no-tags origin "$SUBJECT"');
      expect(judge).toContain("'+refs/heads/cq-state:refs/remotes/origin/cq-state'");
      // No cache is restored by a deciding job (D-C.7).
      expect(body).toMatch(/cache: ''/);
      expect(body).not.toMatch(/cache: p?npm|actions\/cache/);
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
      expect(judge).toContain('node trust/dist/selfhost/policy-diff.js "${args[@]}"');
      expect(body).not.toContain('cli.js');
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
      const judgeStep = steps(judge).find((s) => s.includes('selfhost/policy-diff.js')) ?? '';
      expect(judgeStep).not.toBe('');
      expect(judgeStep).not.toMatch(/GH_TOKEN|github\.token/);
    },
  );
});
