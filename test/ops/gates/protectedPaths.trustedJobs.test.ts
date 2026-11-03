// Split provenance: test/ops/gates/protectedPaths.test.ts was split by subject
// into protectedPaths.{definitionSet,patternLiveness,privilegedList,policyPath,trustedJobs,trustBuild,closure}.test.ts;
// this file holds the trusted-job derivation and invocation-rule assertions.
// W1.10 (#220, Decision 14) — the check code the promotion gate and the I2
// acceptance verifier DECIDE through must be protected, not just the entry
// points: a PR that weakens a helper they call (say, the unresolved-thread
// count) would otherwise land as an ordinary change and weaken
// `cq/acceptance` and the gate's per-PR recompute without owner
// break-glass.
//
// Protected scope (docs/protected-scope.md, 2026-10-16) and residual R1
// (closed 2026-10-17): the entry points are what a TRUSTED job runs —
// every job that builds or runs the trust checkout, to post a verdict or
// move `main`. They are derived from the rendered workflows, not listed by
// hand, and each must be a `trust/dist/selfhost/<entry>.js` invocation:
// `trust/dist/cli.js` loads every op registry, so it may not run there at
// all. The walk then follows each entry's module-loading closure FAIL
// CLOSED (test/helpers/import-closure.ts). A form the scan cannot resolve,
// or a specifier that is neither relative, a `node:` builtin nor a declared
// dependency (the lockfile and package.json are protected by the built-in
// taxonomy), is a failure, never a skipped edge. Since the advisory
// development posture (2026-10-20) the closure files and the scripts a
// privileged job runs no longer have to match `policy/protected-paths.json`
// (now the privileged list only, which keeps the promotion gate itself);
// the walk and the invocation rules stay.
import { describe, expect, test } from 'vitest';
import { trustedJobsFixture } from './protectedPaths.helpers.js';

const { workflows, TRUST_PATH, TRUSTED, classifyTrustedJob } = trustedJobsFixture();

describe('every trusted job runs a selfhost entry point with a classified closure', () => {
  test('no workflow runs trust/dist/cli.js (residual R1)', () => {
    for (const { file, text } of workflows) {
      expect(text, file).not.toMatch(/\btrust\/dist\/cli\.js\b/);
    }
  });

  test('trusted jobs run node only as `node trust/dist/selfhost/<entry>.js`', () => {
    expect(TRUSTED.flatMap((job) => job.unclassified)).toEqual([]);
    // Pinned, so the derived entry set cannot shrink to vacuity: adding or
    // removing a trusted job, or an entry it runs, updates this table.
    expect(Object.fromEntries(TRUSTED.map((job) => [job.key, job.entries]))).toEqual({
      'cq-accept.yml:judge': ['acceptance'],
      'cq-policy.yml:judge': ['policy-diff'],
      'cq-verify.yml:compute': ['recompute-typecheck'],
      'cq-verify.yml:judge': ['verify-ratchet'],
    });
  });

  test('the invocation rules refuse other forms', () => {
    const refused = (code: string, head = '', localUses: string[] = []): string[] =>
      classifyTrustedJob({ key: 'w:j', code, head, localUses }).unclassified;
    expect(TRUST_PATH.test('        working-directory: trust')).toBe(true);
    expect(TRUST_PATH.test('          git init trust')).toBe(true);
    expect(TRUST_PATH.test('      trusted: yes')).toBe(false);
    expect(refused('node trust/dist/selfhost/acceptance.js \\')).toEqual([]);
    expect(refused('pnpm install --frozen-lockfile --ignore-scripts\npnpm run build')).toEqual([]);
    for (const code of [
      'node trust/dist/cli.js gates.policyDiff',
      'node --import ./x.js trust/dist/selfhost/acceptance.js',
      `node -e "import('./x.js')"`,
      'node dist/cli.js gates.policyDiff',
      'node trust/dist/selfhost/$ENTRY.js',
      '/usr/bin/node trust/dist/selfhost/acceptance.js',
      '"$NODE" trust/dist/selfhost/acceptance.js',
      'nodejs trust/dist/cli.js',
      'trust/node_modules/.bin/tsx x.ts',
      'pnpm run build && node x.js',
      'pnpm install --frozen-lockfile',
      'pnpm exec vitest',
      '    NODE_OPTIONS: --import ./hook.js',
      '        shell: node {0}',
    ]) {
      expect(refused(code), code).not.toEqual([]);
    }
    expect(refused('', 'env:\n  NODE_OPTIONS: --import ./hook.js')).not.toEqual([]);
    expect(refused('', 'defaults:\n  run:\n    shell: node {0}')).not.toEqual([]);
    expect(refused('        shell: bash')).toEqual([]);
    expect(refused('', '', ['trust/.github/actions/x'])).not.toEqual([]);
  });
});
