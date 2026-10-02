// Pure selection logic for scripts/affected-tests.mjs (kept free of process
// and git access so test/scripts/affected-tests.test.ts exercises it directly).
//
// A changed file maps to test files three ways, unioned:
//   1. the static import graph (`related`, supplied by the caller);
//   2. the reviewed NON_IMPORT_MAP below: files the module graph cannot see
//      (prompts, fixtures, scripts, policy templates, generated docs) mapped
//      to the suites that own them;
//   3. a broad FALLBACK — every unit test file — when the impact is unknown
//      (a changed file that is neither a test, a mapped file, an import-graph
//      hit, nor an inert path) or the import-graph query itself failed.
// Inert paths (plain prose that no test reads) select nothing and never
// trigger the fallback.

/** [path pattern, test-file patterns]; first matching rows all contribute. */
export const NON_IMPORT_MAP = [
  [/^src\/.*\.prompt$/, [/^test\/(driver|kernel|plans|ops)\//]],
  [/^test\/fixtures\//, [/^test\/(driver|harness|ops|cli|e2e)\//]],
  [/^test\/helpers\//, [/^test\//]],
  [/^scripts\//, [/^test\/scripts\//, /^test\/workflows\//]],
  [/^policy\/templates\//, [/^test\/workflows\//, /^test\/scripts\//]],
  [/^policy\/self-host\//, [/^test\/workflows\//, /^test\/selfhost\//]],
  [/^docs\/ops\//, [/^test\/scripts\//]],
  [/^baselines\//, [/^test\/scripts\//, /^test\/ops\/ratchet\//]],
  [/^(vitest\.config\.ts|test\/suite-classes\.json)$/, [/^test\//]],
  [/^(package\.json|package-lock\.json|tsconfig[^/]*\.json)$/, [/^test\/scripts\//]],
];

/** Paths whose edits no test reads: prose and repo metadata. */
export const INERT = [/^docs\/(?!ops\/)/, /\.md$/, /^LICENSE/, /^\.github\/(?!workflows\/)/];

const isTest = (path) => /^test\/.*\.test\.ts$/.test(path);
// src/** is delegated to the import graph: `related` is an aggregate answer,
// so a src file with no importing test selects nothing rather than falling back.
const isSource = (path) => /^src\/.*\.(ts|mts|js|mjs)$/.test(path);

const full = (allTests, reason) => ({ files: [...allTests].sort(), fallback: true, reason });

/**
 * @param {{ changed: string[], allTests: string[], related: string[] | null }} input
 *   `related` is the import-graph hit list, or null when that query failed.
 * @returns {{ files: string[], fallback: boolean, reason: string }}
 */
export function selectAffected({ changed, allTests, related }) {
  if (related === null) return full(allTests, 'import-graph query failed');
  const selected = new Set(related.filter((test) => allTests.includes(test)));
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
