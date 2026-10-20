// W1.7 fix-forward (composition F1) — the worker's default-deny taxonomy
// (`src/ops/gates/protectedPaths.ts`) and the ratchet DEFINITION SET
// (`baselines/ratchets.json`, read at the trust ref) are two lists that must
// not drift: a shape only one of them names is either worker-editable with no
// human in the loop, or needlessly need-human.
//
// This test reads the REAL manifest and asserts:
//   1. every `definitionSet` source has a representative path, and each
//      representative is protected by `isProtectedStagePath`;
//   2. the shapes ADR-0004 D-G.1 names that no static pattern can enumerate —
//      the tsconfig `extends`/`references` graph — are protected too;
//   3. the paths that carry the protected-path list and the required-check
//      list are in the definition set (D-C.4's last bullet).
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PROTECTED_STAGE_PATTERNS,
  isProtectedPolicyPath,
  isProtectedStagePath,
} from '../../../src/ops/gates/protectedPaths.js';
import { tsconfigGraphPaths } from '../../../src/ops/ratchet/internal/definitions.js';
import { scanWorkflow } from '../../../src/ops/gates/workflowScan.js';
import { VERDICT_CHECK } from '../../../src/selfhost/promote-gate.js';
import { scanModuleLoads, type ModuleScan } from '../../helpers/import-closure.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The committed manifest, read from the working tree (this is a repo-shape test, not a trust test). */
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, 'baselines', 'ratchets.json'), 'utf8'),
) as { definitionSet: string[] };

/** A path each definition-set source is meant to catch. Keyed BY SOURCE: a new source with no entry here fails the test. */
const REPRESENTATIVES: Readonly<Record<string, readonly string[]>> = {
  '^\\.github/': ['.github/workflows/ci.yml', '.github/actions/setup/action.yml'],
  '(?:^|/)vitest\\.config\\.[^/]+$': ['vitest.config.ts', 'packages/x/vitest.config.mts'],
  '(?:^|/)vite\\.config\\.[^/]+$': ['vite.config.ts'],
  '(?:^|/)vitest\\.workspace\\.[^/]+$': ['vitest.workspace.json'],
  '(?:^|/)tsconfig[^/]*\\.json$': ['tsconfig.json', 'tsconfig.base.json'],
  '(?:^|/)package\\.json$': ['package.json'],
  '(?:^|/)package-lock\\.json$': ['package-lock.json'],
  '(?:^|/)npm-shrinkwrap\\.json$': ['npm-shrinkwrap.json'],
  '(?:^|/)pnpm-lock\\.yaml$': ['pnpm-lock.yaml'],
  // pnpm settings and install hooks decide what is installed.
  '(?:^|/)pnpm-workspace\\.yaml$': ['pnpm-workspace.yaml', 'packages/x/pnpm-workspace.yaml'],
  '(?:^|/)\\.pnpmfile\\.[cm]?js$': ['.pnpmfile.cjs', '.pnpmfile.mjs'],
  '(?:^|/)\\.npmrc$': ['.npmrc', 'packages/x/.npmrc'],
  '(?:^|/)\\.nvmrc$': ['.nvmrc'],
  '(?:^|/)\\.node-version$': ['.node-version'],
  '(?:^|/)\\.gitattributes$': ['.gitattributes'],
  '^\\.cq/tool/': ['.cq/tool/lint.sh'],
  // F1: the whole ratchet-evidence tree, not just the manifest.
  '^baselines/': ['baselines/coverage--coverage--a8ceec8f7024.json', 'baselines/nested/x.json'],
  // F2: the protected-path list and the required-check list ARE definitions.
  '^src/ops/gates/protectedPaths\\.ts$': ['src/ops/gates/protectedPaths.ts'],
  '^scripts/denylist-scan$': ['scripts/denylist-scan'],
  // W1.9 (ADR-0004 D-C.4): the D11 protected-path / required-check list and
  // the C3 attestation that activates override records are definitions.
  '^policy/protected-paths\\.json$': ['policy/protected-paths.json'],
  '^policy/attestations/': ['policy/attestations/c3.json'],
  // W1.9 H3: what the required checks run is measurement configuration.
  '(?:^|/)\\.oxlintrc\\.json$': ['.oxlintrc.json'],
  '(?:^|/)\\.oxfmtrc\\.json$': ['.oxfmtrc.json'],
  '^knip\\.json$': ['knip.json'],
  '^lint/': ['lint/plugin.mjs', 'lint/rules/x.mjs'],
  '^scripts/ratchet-[^/]+\\.mjs$': ['scripts/ratchet-typecheck.mjs', 'scripts/ratchet-lib.mjs'],
  '^scripts/gen-op-docs\\.mjs$': ['scripts/gen-op-docs.mjs'],
  '^scripts/copy-prompt-assets\\.mjs$': ['scripts/copy-prompt-assets.mjs'],
  '^policy/denylist/': ['policy/denylist/patterns.yml'],
};

describe('worker gate / ratchet definition-set sync (F1, F2)', () => {
  test('every definition-set source has a representative path', () => {
    expect(Object.keys(REPRESENTATIVES).sort()).toEqual([...MANIFEST.definitionSet].sort());
  });

  test.each(
    Object.entries(REPRESENTATIVES).flatMap(([source, paths]) =>
      paths.map((path) => [source, path] as const),
    ),
  )('%s protects %s', (_source, path) => {
    expect(isProtectedStagePath(path)).toBe(true);
  });

  test('the trust tsconfig graph is protected (a static pattern cannot enumerate it)', async () => {
    // Read from git, exactly as the verifier does, so a graph target that is
    // not even on disk is still counted.
    const graph = await tsconfigGraphPaths(REPO_ROOT, 'HEAD');
    expect(graph.length).toBeGreaterThan(0);
    for (const path of graph) expect(isProtectedStagePath(path)).toBe(true);
  });

  test('the definition set is not merely the old workflows-only subset (F6)', () => {
    expect(MANIFEST.definitionSet).toContain('^\\.github/');
    expect(MANIFEST.definitionSet).not.toContain('^\\.github/workflows/');
  });
});

/**
 * A path each protected pattern is meant to catch, keyed by that pattern's
 * exact `.source`. This is the REVERSE direction of the table above: keyed by
 * pattern, so a pattern added to the taxonomy with no representative here
 * fails the test instead of going untested.
 *
 * It is a LIVENESS guard, not a pairing proof. The taxonomy is deliberately
 * broader than the ratchet definition set (test evidence is worker-controlled
 * but is not a ratchet definition), so "every representative is a definition
 * path" is neither true nor wanted — see the RATCHET-SET SYNC note on
 * `PROTECTED_CONFIG_PATH_PATTERNS`.
 */
const PATTERN_REPRESENTATIVES: Readonly<Record<string, readonly string[]>> = {
  '(^|\\/)(?:test|tests|spec|specs|__tests__|__mocks__|__fixtures__|__snapshots__|cypress|e2e|test-utils)\\/':
    [
      'test/unit/a.ts',
      'src/__mocks__/fs.ts',
      'cypress/support/commands.ts',
      'e2e/login.ts',
      'src/test-utils/render.ts',
    ],
  '\\.(?:test|spec)\\.[cm]?[jt]sx?$': ['src/a.test.ts', 'src/b.spec.mts'],
  '\\.config\\.[^/]+$': ['vitest.config.ts', 'packages/a/vite.config.js'],
  '(?:^|\\/)(?:setupTests|globalSetup|global[-.]setup|conftest)\\.(?:[cm]?[jt]sx?|py)$': [
    'src/setupTests.ts',
    'globalSetup.ts',
    'test/globalSetup.mts',
    'global-setup.ts',
    'global.setup.mjs',
    'conftest.py',
  ],
  '(?:^|\\/)\\.env\\.test(?:\\.[^/]+)?$': ['.env.test', 'packages/a/.env.test.local'],
  '(?:^|\\/)(?:oxlint\\.json|karma\\.conf\\.[cm]?[jt]s)$': [
    'oxlint.json',
    'karma.conf.js',
    'karma.conf.ts',
    'karma.conf.mts',
  ],
  '^baselines(?:\\/|$)': ['baselines/coverage--coverage--a8ceec8f7024.json'],
  '(?:^|\\/)\\.node-version$': ['.node-version'],
  '^\\.cq\\/tool(?:\\/|$)': ['.cq/tool/lint.sh'],
  '^src\\/ops\\/gates\\/protectedPaths\\.ts$': ['src/ops/gates/protectedPaths.ts'],
  '^scripts\\/denylist-scan$': ['scripts/denylist-scan'],
  '^scripts\\/ratchet-[^/]+\\.mjs$': ['scripts/ratchet-typecheck.mjs'],
  '^scripts\\/(?:gen-op-docs|copy-prompt-assets)\\.mjs$': [
    'scripts/gen-op-docs.mjs',
    'scripts/copy-prompt-assets.mjs',
  ],
  '(?:^|\\/)knip\\.jsonc?$': ['knip.json', 'packages/a/knip.jsonc'],
  '^policy(?:\\/|$)': ['policy/DOCTRINE.md', 'policy/templates/ratchet.yml'],
  '^lint(?:\\/|$)': ['lint/plugin.mjs', 'lint/rules/x.mjs'],
  '(?:^|\\/)[^/]*\\.setup\\.[^/]+$': ['vitest.setup.ts'],
  '(?:^|\\/)\\.[^/]*rc(?:\\.[^/]*)?$': ['.npmrc', 'packages/a/.npmrc'],
  '(?:^|\\/)\\.gitignore$': ['.gitignore', 'packages/a/.gitignore'],
  '(?:^|\\/)\\.gitattributes$': ['.gitattributes'],
  '(?:^|\\/)(?:tsconfig(?:\\.[^/]+)?\\.json|package\\.json|biome\\.jsonc?)$': [
    'tsconfig.json',
    'package.json',
  ],
  '^\\.github(?:\\/|$)': ['.github/workflows/ci.yml', '.github/actions/a/action.yml'],
  '^\\.husky(?:\\/|$)': ['.husky/pre-commit'],
  '(?:^|\\/)vitest\\.(?:workspace|projects)\\.(?:[cm]?[jt]sx?|json)$': ['vitest.workspace.json'],
  '(?:^|\\/)(?:package(?:-lock)?\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb?|poetry\\.lock|uv\\.lock|pdm\\.lock|Pipfile\\.lock|Gemfile\\.lock|Cargo\\.lock|composer\\.lock|mix\\.lock|go\\.sum)$':
    ['package-lock.json', 'npm-shrinkwrap.json'],
  '(?:^|\\/)(?:pnpm-workspace\\.yaml|\\.pnpmfile\\.[cm]?js)$': [
    'pnpm-workspace.yaml',
    '.pnpmfile.cjs',
  ],
  '\\.snap$': ['src/__snapshots__/a.snap'],
};

describe('worker gate pattern liveness (reverse direction)', () => {
  const sources = [...new Set(PROTECTED_STAGE_PATTERNS.map((pattern) => pattern.source))];

  test('every protected pattern has a representative path', () => {
    // Keyed by source, so a NEW pattern without an entry here fails loudly.
    expect(Object.keys(PATTERN_REPRESENTATIVES).sort()).toEqual([...sources].sort());
  });

  test.each(
    PROTECTED_STAGE_PATTERNS.flatMap((pattern) => {
      const reps = PATTERN_REPRESENTATIVES[pattern.source] ?? [];
      return reps.map((path) => [pattern.source, path] as const);
    }),
  )('%s actually matches %s', (source, path) => {
    // The representative is matched by ITS OWN pattern (all are built with
    // the `i` flag), so a pattern that can never match anything is caught.
    expect(new RegExp(source, 'i').test(path)).toBe(true);
    // …and the stage path gate really does protect it.
    expect(isProtectedStagePath(path)).toBe(true);
  });
});

// The project list is the PRIVILEGED list (advisory development posture,
// 2026-10-20; docs/protected-scope.md "Advisory posture"): under
// `CQ_MERGE_PROTECTED_PATHS=advisory` a path it names is a `privileged-path`
// finding and still needs a human; the trusted closure, the settle schema
// and the D11 check code are no longer listed, so a change to them is an
// `advisory:` annotation (the built-in taxonomy still reports them as
// `protected-path`).
describe('the privileged list (advisory development posture)', () => {
  const patterns = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'policy/protected-paths.json'), 'utf8')) as {
      protectedPaths: string[];
    }
  ).protectedPaths;
  const privileged = (path: string): boolean =>
    patterns.some((pattern) => new RegExp(pattern).test(path));

  test.each([
    'policy/protected-paths.json',
    '.github/workflows/denylist.yml',
    'policy/promotion-reviewer.json',
    'policy/denylist/patterns.yml',
    'scripts/denylist-scan',
    'src/selfhost/promote-gate.ts',
    'scripts/github-settings-drift.mjs',
    'scripts/lib/github-settings.mjs',
    'policy/templates/github-settings.json',
    'policy/attestations/c3.json',
    'apps/crq-python/signer/signer.py',
    'apps/crq-python/ops/systemd/crq.service',
    'apps/crq-python/config.json',
  ])('%s is privileged', (path) => {
    expect(privileged(path)).toBe(true);
  });

  test.each([
    'src/selfhost/settle-state.ts',
    '.github/workflows/ci.yml',
    'src/selfhost/acceptance.ts',
    'src/ops/gates/policyDiff.ts',
    'src/ops/gates/registry.ts',
    'src/shared/messageOf.ts',
    'scripts/ratchet-check.mjs',
    'apps/crq-python/ops/prepare-host.py',
    'src/selfhost/promote-gate.tsx',
    'apps/crq-python/config.json.bak',
  ])('%s is not privileged', (path) => {
    expect(privileged(path)).toBe(false);
  });
});

describe('isProtectedPolicyPath (D11, ADR-0004 D-G.1)', () => {
  test.each([
    'policy/DOCTRINE.md',
    'policy/templates/cq-policy.yml',
    'lint/x',
    'lint/rules/no-vendor-sdk-in-kernel.mjs',
    '.github/workflows/ci.yml',
    'baselines/ratchets.json',
  ])('%s is a protected policy path', (path) => {
    expect(isProtectedPolicyPath(path)).toBe(true);
  });

  test.each([
    // Tests and snapshots are worker evidence, not enforcement definitions.
    'src/foo.test.ts',
    '__snapshots__/a.snap',
    'test/unit/a.ts',
    'src/index.ts',
    // Anchored at the repo root: a nested `policy/` or `lint/` is content.
    'src/policy/index.ts',
    'src/lint/index.ts',
    'policyish/a.md',
  ])('%s is not a protected policy path', (path) => {
    expect(isProtectedPolicyPath(path)).toBe(false);
  });

  test('policy and lint paths are also denied to sweep workers', () => {
    expect(isProtectedStagePath('policy/templates/ratchet.yml')).toBe(true);
    expect(isProtectedStagePath('lint/plugin.mjs')).toBe(true);
  });
});

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
/** `loadEngine`'s `imp('<rel>.js')` modules, as `src/ops/ratchet/<rel>.ts`. */
function engineModules(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'scripts', 'ratchet-lib.mjs'), 'utf8');
  const body = /export async function loadEngine\(\)[\s\S]*?\n\}/.exec(text)?.[0] ?? '';
  const out = [...body.matchAll(/\bimp\('([\w/.-]+)\.js'\)/g)].map(
    (m) => `src/ops/ratchet/${m[1]!}.ts`,
  );
  if (out.length === 0) throw new Error('scripts/ratchet-lib.mjs: no loadEngine imports found');
  return out;
}

describe('every trusted job runs a selfhost entry point with a classified closure', () => {
  const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
  const workflows = readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(WORKFLOWS_DIR, file), 'utf8') }));

  /** A job's lines without comments or step names (prose, not commands). */
  const commandLines = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !/^\s*#/.test(line) && !/^\s*(?:-\s+)?name:/.test(line))
      .join('\n');

  /** A job builds or runs the trust checkout when its commands name `trust` as a path. */
  const TRUST_PATH = /(?:^|[\s"'=:])trust(?:\/|[ \t]*$)/m;

  /** Every job that builds or runs the trust checkout, with its workflow's head (env, defaults). */
  const trustedJobs = workflows.flatMap(({ file, text }) => {
    const scan = scanWorkflow(text);
    if (!scan.ok) throw new Error(`${file}: workflow does not scan`);
    const head = commandLines(text.slice(0, Math.max(0, text.search(/^jobs:/m))));
    return [...scan.jobs.values()]
      .map((job) => ({
        key: `${file}:${job.id}`,
        code: commandLines(job.text),
        head,
        localUses: job.localUses,
      }))
      .filter((job) => TRUST_PATH.test(job.code));
  });

  /** The one `node` form a trusted job may use, and the `pnpm` forms that build it. */
  const NODE_TOKEN = /(?<![\w-])node(?![\w.-])/g;
  const NODE_ENTRY = /^node\s+trust\/dist\/selfhost\/([\w-]+)\.js(?=[\s\\"';|)]|$)/;
  const PNPM_TOKEN = /(?<![\w./-])pnpm(?![\w./-])/g;
  const PNPM_FORMS = /^pnpm (?:install --frozen-lockfile --ignore-scripts|run build)[ \t]*$/m;
  /** Ways to load or run code a job's argv does not name, in the job or its workflow head. */
  const LOADERS =
    /\b(?:NODE_OPTIONS|NODE_PATH|nodejs|npx|pnpx|bunx?|deno|tsx|ts-node)\b|--(?:import|require|loader|experimental-loader)\b|\$\{?NODE\b|node_modules\/\.bin\b|^\s*shell:(?![ \t]*bash[ \t]*$)/m;

  /** One trusted job's selfhost entries, and every invocation of any other form. */
  function classifyTrustedJob(job: {
    key: string;
    code: string;
    head: string;
    localUses: readonly string[];
  }): { entries: string[]; unclassified: string[] } {
    const { key, code } = job;
    const entries: string[] = [];
    const unclassified: string[] = [];
    for (const m of code.matchAll(NODE_TOKEN)) {
      const entry = NODE_ENTRY.exec(code.slice(m.index))?.[1];
      // `/usr/bin/node …`: a node named by path is not the runner's `node`.
      if (entry === undefined || code[m.index - 1] === '/') {
        unclassified.push(`${key}: ${code.slice(Math.max(0, m.index - 20), m.index + 60)}`);
      } else entries.push(entry);
    }
    for (const m of code.matchAll(PNPM_TOKEN)) {
      if (!PNPM_FORMS.test(code.slice(m.index).split('\n')[0]!)) {
        unclassified.push(`${key}: ${code.slice(m.index).split('\n')[0]!}`);
      }
    }
    for (const [where, text] of [
      ['job', code],
      ['workflow head', job.head],
    ] as const) {
      const loader = LOADERS.exec(text);
      if (loader !== null) unclassified.push(`${key}: ${where} loads code via ${loader[0].trim()}`);
    }
    for (const local of job.localUses) unclassified.push(`${key}: runs local action ./${local}`);
    return { entries, unclassified };
  }

  /** Each trusted job's entries, computed once. */
  const TRUSTED = trustedJobs.map((job) => ({ key: job.key, ...classifyTrustedJob(job) }));

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
      'gate.yml:decide': ['promote-gate'],
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

  test("the trust build runs only protected scripts (package.json's build)", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const build = pkg.scripts['build'] ?? '';
    const scripts = [...build.matchAll(/(?:^|[\s'"])(?:\.\/)?(scripts\/[\w./-]+\.m?js)\b/g)].map(
      (m) => m[1]!,
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(isProtectedPolicyPath(script), script).toBe(true);
    // Nothing else runs: every command is node on a script, or the build tsc.
    for (const command of build.split('&&').map((c) => c.trim())) {
      expect(command, command).toMatch(
        /^(?:node (?:scripts\/|--input-type=module -e )|tsc -p tsconfig\.build\.json$)/,
      );
    }
  });

  const ENTRY_POINTS = [
    ...[...new Set(TRUSTED.flatMap((job) => job.entries))].map((e) => `src/selfhost/${e}.ts`),
    // The prebuilt engine `scripts/ratchet-propose.mjs` loads in its
    // `automation`-environment job (scripts/ratchet-lib.mjs `loadEngine`).
    ...engineModules(),
  ];

  const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const DEPENDENCIES = new Set(Object.keys(PACKAGE.dependencies));
  /** `zod` → `zod`, `@scope/pkg/sub` → `@scope/pkg`. */
  const packageOf = (spec: string): string =>
    spec
      .split('/')
      .slice(0, spec.startsWith('@') ? 2 : 1)
      .join('/');

  /** The module-loading closure of `entries`, and every edge it could not classify. */
  function closure(entries: readonly string[]): { files: string[]; problems: string[] } {
    const seen = new Set<string>();
    const problems: string[] = [];
    const stack = [...entries];
    while (stack.length > 0) {
      const file = stack.pop() ?? '';
      if (seen.has(file)) continue;
      seen.add(file);
      const scan = scanModuleLoads(readFileSync(join(REPO_ROOT, file), 'utf8'));
      problems.push(...scan.problems.map((p) => `${file}: ${p}`));
      for (const spec of scan.specifiers) {
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const target = posix.normalize(
            posix.join(posix.dirname(file), spec.replace(/\.js$/, '.ts')),
          );
          if (!target.startsWith('src/') || !target.endsWith('.ts')) {
            problems.push(`${file}: ${spec} resolves outside src/*.ts`);
          } else stack.push(target);
        } else if (!spec.startsWith('node:') && !DEPENDENCIES.has(packageOf(spec))) {
          problems.push(`${file}: ${spec} is not relative, a node: builtin or a dependency`);
        }
      }
    }
    return { files: [...seen].sort(), problems };
  }

  const POLICY = JSON.parse(
    readFileSync(join(REPO_ROOT, 'policy', 'protected-paths.json'), 'utf8'),
  ) as { protectedPaths: string[] };
  const REGEXES = POLICY.protectedPaths.map((source) => new RegExp(source));

  test('the closure walk refuses what it cannot classify', () => {
    const scan = (text: string): ModuleScan => scanModuleLoads(text);
    expect(
      scan(
        [
          "import { a, type B } from './a.js';",
          "import type { C } from './c.js';",
          "export type { D } from './d.js';",
          "export { e } from '../e.js';",
          "export * from './f.js';",
          "import {\n  g,\n  h,\n} from './g.js';",
          "import './side.js';",
          "const m = await import('./dyn.js');",
          "import { x } from 'node:fs';",
          "// import { c } from './comment.js';",
          'const s = "import(\'./string.js\')";',
          "const re = /'/g;",
        ].join('\n'),
      ),
    ).toEqual({
      specifiers: ['./a.js', '../e.js', './f.js', './g.js', 'node:fs', './side.js', './dyn.js'],
      problems: [],
    });
    expect(scan('const m = await import(name);').problems).toHaveLength(1);
    expect(scan('const m = await import(`./${x}.js`);').problems).toHaveLength(1);
    expect(scan("const r = createRequire(import.meta.url); r('./x.cjs');").problems).toHaveLength(
      1,
    );
    // A from-clause cannot span a call: the computed import stays visible.
    expect(
      scan("export const f = (n) => import(n)\nexport { x } from './x.js';").problems,
    ).toHaveLength(1);
    for (const text of [
      "register('./hooks.mjs', import.meta.url);",
      "new Function('return 1')();",
      "eval('1');",
      "process.dlopen(m, './x.node');",
    ]) {
      expect(scan(text).problems, text).toHaveLength(1);
    }
    expect(scan("export * from 'node:fs';")).toEqual({ specifiers: ['node:fs'], problems: [] });
    // The package self-import resolves through dist/index.js, the whole SDK.
    expect(packageOf('@camerontaylor/cq-toolkit')).toBe('@camerontaylor/cq-toolkit');
    expect(DEPENDENCIES.has(packageOf('@camerontaylor/cq-toolkit'))).toBe(false);
    expect(DEPENDENCIES.has(packageOf('#internal'))).toBe(false);
  });

  test('the closure walk classifies every edge and reaches the judges', () => {
    const { files, problems } = closure(ENTRY_POINTS);
    expect(problems).toEqual([]);
    // The judges the trusted entries exist to run are reached.
    expect(files).toEqual(
      expect.arrayContaining([
        ...ENTRY_POINTS,
        'src/ops/gates/policyDiff.ts',
        'src/ops/gates/policyConfig.ts',
        'src/ops/ratchet/verifyRatchet.ts',
        'src/ops/ratchet/recomputeTypecheck.ts',
        'src/ops/review/threads.ts',
      ]),
    );
    // R1: none of the CLI shell runs in a trusted job.
    expect(
      files.filter((f) => /^src\/(?:cli|kernel|registry)\//.test(f) || f === 'src/cli.ts'),
    ).toEqual([]);
    // Advisory development posture (2026-10-20): the closure is no longer
    // required to match the project list — only the promotion gate itself is
    // privileged. The fail-closed walk above still refuses any edge it
    // cannot classify.
    expect(REGEXES.some((re) => re.test('src/selfhost/promote-gate.ts'))).toBe(true);
  });
});

// W1.10 fix round (P1 composition L5, direct-diff r1 L3) — the required-
// check list that gates D11 (`policy/protected-paths.json` `requiredChecks`)
// and ruleset R2's required list (`policy/templates/github-settings.json`)
// must not drift apart silently: a check removed from R2 while still listed
// here would trip D11's "removed required check" rule at C2, and a check
// added here with no R2 entry would never be enforced there. R2 is the C2
// target and is a SUPERSET modulo one recorded supersession: the classic
// `ratchet` context becomes the verdict-App `cq/ratchet` (methods note,
// Residuals). This pins the mapping so the supersession stays documented.
describe('requiredChecks are enforced at merge (R2) or at promotion (the gate)', () => {
  const POLICY = JSON.parse(
    readFileSync(join(REPO_ROOT, 'policy', 'protected-paths.json'), 'utf8'),
  ) as { requiredChecks: string[]; requiredJobs?: Record<string, string[]> };
  const SETTINGS = JSON.parse(
    readFileSync(join(REPO_ROOT, 'policy', 'templates', 'github-settings.json'), 'utf8'),
  ) as {
    rulesets: Array<{
      name: string;
      rules: Array<{
        parameters?: { required_status_checks?: Array<{ context: string }> };
      }>;
    }>;
  };

  /** Classic context → its verdict-App successor. Every key must stay recorded in the methods Residuals. */
  const SUPERSEDED: Readonly<Record<string, string>> = {
    ratchet: 'cq/ratchet',
  };

  const r2 = SETTINGS.rulesets.find((r) => r.name === 'cq-r2-merge-queue');
  const r2Contexts = new Set(
    r2?.rules
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context) ?? [],
  );
  // The minimal merge-time set (docs/protected-scope.md): what the gate
  // enforces on the queue tip is not required again at merge.
  const gateContexts = new Set([...Object.values(POLICY.requiredJobs ?? {}).flat(), VERDICT_CHECK]);

  test('R2 exists and carries required status checks', () => {
    expect(r2Contexts.size).toBeGreaterThan(0);
  });

  test.each(POLICY.requiredChecks)('requiredChecks entry %s is enforced somewhere', (context) => {
    const enforced = SUPERSEDED[context] ?? context;
    expect(
      r2Contexts.has(enforced) || gateContexts.has(enforced),
      `${context} (as ${enforced}) is enforced neither by R2 nor by the gate`,
    ).toBe(true);
  });

  test('no gate-enforced CI job is also required at merge', () => {
    const doubled = [...r2Contexts].filter(
      (context) => gateContexts.has(context) && !['denylist'].includes(context),
    );
    // denylist stays at merge too: merge-queue history is append-only (R0),
    // so a leak the gate refuses to promote could not be un-merged.
    expect(doubled).toEqual([]);
  });

  test('every recorded supersession is documented in the methods note Residuals', () => {
    const methods = readFileSync(join(REPO_ROOT, 'docs', 'methods-w1-10.md'), 'utf8');
    for (const [from, to] of Object.entries(SUPERSEDED)) {
      expect(methods).toContain(`replaces \`${from}\` with the verdict-App \`${to}\``);
    }
  });
});
