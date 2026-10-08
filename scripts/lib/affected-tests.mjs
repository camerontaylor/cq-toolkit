// Pure selection logic for scripts/test-narrow.mjs (kept free of process and
// git access so test/scripts/affected-tests.test.ts exercises it directly).
//
// A changed file maps to test files three ways, unioned:
//   1. the static import graph (`related`, supplied by the caller);
//   2. the reviewed NON_IMPORT_MAP below: files the module graph cannot see
//      (prompts, fixtures, scripts, policy templates, generated docs) mapped
//      to the suites that own them;
//   3. a broad FALLBACK — every unit test file — when the impact is unknown
//      (a changed file that is neither a test, a mapped file, an import-graph
//      hit, nor an inert path; a DELETED module under src/ or scripts/, whose
//      importers the graph can no longer see) or the import-graph query
//      itself failed.
// Inert paths (plain prose that no test reads) select nothing and never
// trigger the fallback.

/** [path pattern, test-file patterns]; first matching rows all contribute. */
export const NON_IMPORT_MAP = [
  [/^src\/.*\.prompt$/, [/^test\/(driver|kernel|plans|ops)\//]],
  // Fixtures are consumed across areas (sweep, ratchet-baseline, ...) and
  // fixture paths are not part of the related-source query: select every test.
  [/^test\/fixtures\//, [/^(test|lint)\//]],
  [/^test\/helpers\//, [/^(test|lint)\//]],
  [/^scripts\//, [/^test\/scripts\//, /^test\/workflows\//]],
  // The CLI smoke test runs `pnpm run build`, which executes this script by path.
  [/^scripts\/copy-prompt-assets\.mjs$/, [/^test\/cli\/plans\.smoke\.test\.ts$/]],
  // Source-tree scanners read src/** from disk: no import-graph edge.
  [
    /^src\/driver\//,
    [/^test\/kernel\/driver-hygiene\.test\.ts$/, /^test\/scripts\/static-conformance\.test\.ts$/],
  ],
  [
    /^src\/ops\//,
    [
      /^test\/cli\/(registry|conformance)\.test\.ts$/,
      /^test\/driver\/served-model-sites\.test\.ts$/,
    ],
  ],
  // protectedPaths walks the relative-import closure of the gate and
  // acceptance entry points from disk; that closure crosses src/, so any
  // source can join it.
  [/^src\/.*\.ts$/, [/^test\/ops\/gates\/protectedPaths\.test\.ts$/]],
  [/^src\/selfhost\/promote-gate\.ts$/, [/^test\/workflows\/default-ref-guards\.test\.ts$/]],
  // Entry points these suites only run in a child process, by path.
  [
    /^src\/harness\/mcp\//,
    [/^test\/harness\/mcp-bin\.test\.ts$/, /^test\/driver\/harness-parity\.test\.ts$/],
  ],
  [/^src\/(cli\.ts$|cli\/|harness\/run\.ts$)/, [/^test\/driver\/subprocess\.test\.ts$/]],
  [/^scripts\/api-report\.mjs$/, [/^test\/api-report\.test\.mjs$/]],
  [/^policy\/templates\//, [/^test\/workflows\//, /^test\/scripts\//, /^test\/ops\/gates\//]],
  [/^policy\/self-host\//, [/^test\/workflows\//, /^test\/selfhost\//]],
  [/^docs\/ops\//, [/^test\/scripts\//]],
  [/^baselines\//, [/^test\/(scripts|workflows)\//, /^test\/ops\/(ratchet|gates)\//]],
  // Docs and prompts that code or tests read at runtime.
  [/^(docs\/(dd-1-|methods-)|src\/.*\.md$)/, [/^test\//]],
  [/^(vitest\.config\.ts|test\/suite-classes\.json)$/, [/^(test|lint)\//]],
  // Root configs that specific suites read from disk.
  [
    /^knip\.json$/,
    [/^test\/scripts\/knip\.test\.ts$/, /^test\/ops\/gates\/protectedPaths\.test\.ts$/],
  ],
  [
    /^(\.oxlintrc\.json|lint\/(?!.*\.test\.ts$).*)$/,
    [
      /^lint\//,
      /^test\/scripts\/(oxlint-boundaries|static-conformance|tooling-commands)\.test\.ts$/,
      /^test\/ops\/gates\/protectedPaths\.test\.ts$/,
      /^test\/ops\/sweep\/unit-registry\.test\.ts$/,
    ],
  ],
  // Workflows and composite actions: the suites that read them from disk.
  [
    /^\.github\/(workflows|actions)\//,
    [
      /^test\/workflows\//,
      /^test\/ops\/gates\/(workflowScan|policyDiff|protectedPaths)\.test\.ts$/,
      /^test\/ops\/ratchet\/definitions\.test\.ts$/,
      /^test\/scripts\/github-settings\.test\.ts$/,
    ],
  ],
  // Dependency and compiler inputs affect every test project.
  [
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.pnpmfile\.[cm]?js|tsconfig[^/]*\.json)$/,
    [/^(test|lint)\//],
  ],
];

/** Paths whose edits no test reads: prose and repo metadata. */
export const INERT = [
  /^docs\/(?!ops\/|dd-1-|methods-)/,
  /^(README|LICENSE|CHANGELOG|AGENTS|CLAUDE)[^/]*$/,
  /^\.github\/(?!workflows\/|actions\/)/,
];

// A test file by vitest.config.ts's include globs: `.test.ts` or `.test.mjs`
// under test/, `.test.ts` under lint/.
export const isTest = (path) => /^(test\/.*\.test\.(ts|mjs)|lint\/.*\.test\.ts)$/.test(path);
// src/** is delegated to the import graph (plus the scanner rows above):
// `related` is an aggregate answer, so a src file with no importing test
// selects nothing rather than falling back.
const isSource = (path) => /^src\/.*\.(ts|mts|js|mjs)$/.test(path);
// The runner sends existing scripts/ modules through the import graph too, so
// a deleted one loses its importers the same way a deleted source does.
const isGraphModule = (path) => isSource(path) || /^scripts\/.*\.(ts|mts|js|mjs)$/.test(path);

// Vitest reports module ids with the platform separator; every manifest entry
// and pattern here is a repository-relative POSIX path.
const toPosix = (path) => path.replaceAll('\\', '/');

const full = (allTests, reason) => ({ files: [...allTests].sort(), fallback: true, reason });

/**
 * @param {{ changed: string[], allTests: string[], related: string[] | null, missing?: string[] }} input
 *   `related` is the import-graph hit list, or null when that query failed;
 *   `missing` lists changed paths that no longer exist (deletions).
 * @returns {{ files: string[], fallback: boolean, reason: string }}
 */
export function selectAffected({ changed, allTests, related, missing = [] }) {
  if (related === null) return full(allTests, 'import-graph query failed');
  const deleted = changed.find((path) => isGraphModule(path) && missing.includes(path));
  if (deleted !== undefined) return full(allTests, `deleted module ${deleted}`);
  const selected = new Set(related.map(toPosix).filter((test) => allTests.includes(test)));
  for (const path of changed) {
    if (isTest(path)) {
      if (allTests.includes(path)) selected.add(path);
      continue;
    }
    const rows = NON_IMPORT_MAP.filter(([pattern]) => pattern.test(path));
    for (const [, targets] of rows) {
      for (const test of allTests) if (targets.some((t) => t.test(test))) selected.add(test);
    }
    if (rows.length === 0 && !isSource(path) && !INERT.some((p) => p.test(path))) {
      return full(allTests, `no mapping for ${path}`);
    }
  }
  return { files: [...selected].sort(), fallback: false, reason: 'mapped' };
}
