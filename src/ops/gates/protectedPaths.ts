// The one base-owned taxonomy of worker-controlled test and configuration
// evidence. Both sweep's staged/committed path gate and hackDetector consume
// these shapes so a protected rename cannot disagree across the composition.

/** Regex sources for test and test-support roots protected at every depth. */
export const PROTECTED_TEST_ROOT_PATTERN_SOURCES: readonly string[] = Object.freeze([
  '(^|/)(?:test|tests|spec|specs|__tests__|__mocks__|__fixtures__|__snapshots__)/',
]);

/** Regex sources for test/spec filenames in every supported module suffix. */
export const PROTECTED_TEST_FILE_PATTERN_SOURCES: readonly string[] = Object.freeze([
  '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
]);

/** Test and test-support roots protected at every depth. */
export const PROTECTED_TEST_ROOT_PATTERNS: readonly RegExp[] = Object.freeze(
  PROTECTED_TEST_ROOT_PATTERN_SOURCES.map((source) => new RegExp(source, 'i')),
);

/** Test/spec filenames, including every JavaScript/TypeScript module suffix. */
export const PROTECTED_TEST_FILE_PATTERNS: readonly RegExp[] = Object.freeze(
  PROTECTED_TEST_FILE_PATTERN_SOURCES.map((source) => new RegExp(source, 'i')),
);

/**
 * Configuration, package metadata, lockfiles, ratchet evidence, and
 * repository automation that can redefine what the final probe runs or how
 * the result is measured.
 *
 * RATCHET-SET SYNC (composition F1): every shape in the ratchet definition
 * set is ALSO protected here — `baselines/ratchets.json`'s `definitionSet`
 * is the trust-ref list that routes a subject's edit to needs-human, and
 * `test/ops/gates/protectedPaths.test.ts` asserts that direction over the
 * real manifest, plus the shapes ADR-0004 D-G.1 names that no regex can
 * enumerate statically (`baselines/**`, `.node-version`, `.cq/tool/**`, the
 * tsconfig `extends`/`references` graph).
 *
 * The relationship is ONE-DIRECTIONAL BY DESIGN, not a mirror: this taxonomy
 * is deliberately BROADER, because worker-controlled test evidence (a test
 * root, a `.spec.ts`, a snapshot, `.gitignore`, `.husky`) is not a ratchet
 * definition and must not become one. So the inverse — a new pattern here
 * with no definition-set counterpart — is a judgement call, not a test
 * failure; the two list files are themselves needs-human, which is what makes
 * that judgement reviewable. The test's reverse table is a LIVENESS guard
 * (every pattern below has a representative it actually matches), not a
 * pairing proof.
 */
export const PROTECTED_CONFIG_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /\.config\.[^/]+$/i,
  // Ratchet evidence: the definitions (ratchets.json) and every baseline a
  // ratchet is measured against. A worker baseline edit is a definition of
  // what the ratchet means, not ordinary content.
  /^baselines(?:\/|$)/i,
  // Node interpreter pin (.node-version is a dotfile but NOT an `rc` file, so
  // the rc pattern below misses it).
  /(?:^|\/)\.node-version$/i,
  // Base-owned tool shims the gates invoke (.cq/tool/**).
  /^\.cq\/tool(?:\/|$)/i,
  // The gate's OWN taxonomy and the required-check list it parses: editing
  // either is editing the rules that judge a worker commit (ADR-0004 D-C.4
  // puts both in the ratchet definition set for the same reason).
  /^src\/ops\/gates\/protectedPaths\.ts$/i,
  /^scripts\/denylist-scan$/i,
  // D11 protected paths (ADR-0004 D-G.1): policy templates instantiate the
  // repository's workflows and the doctrine, and lint rules define what the
  // static gate enforces, so both are enforcement definitions, not content.
  /^policy(?:\/|$)/i,
  /^lint(?:\/|$)/i,
  /(?:^|\/)[^/]*\.setup\.[^/]+$/i,
  /(?:^|\/)\.[^/]*rc(?:\.[^/]*)?$/i,
  /(?:^|\/)\.gitignore$/i,
  /(?:^|\/)\.gitattributes$/i,
  /(?:^|\/)(?:tsconfig(?:\.[^/]+)?\.json|package\.json|biome\.jsonc?)$/i,
  /^\.github(?:\/|$)/i,
  /^\.husky(?:\/|$)/i,
  /(?:^|\/)vitest\.(?:workspace|projects)\.(?:[cm]?[jt]sx?|json)$/i,
  /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|Gemfile\.lock|Cargo\.lock|composer\.lock|mix\.lock|go\.sum)$/i,
]);

/** Every protected worker path, in one default-deny taxonomy. */
export const PROTECTED_STAGE_PATTERNS: readonly RegExp[] = Object.freeze([
  ...PROTECTED_TEST_ROOT_PATTERNS,
  ...PROTECTED_TEST_FILE_PATTERNS,
  ...PROTECTED_CONFIG_PATH_PATTERNS,
  /\.snap$/i,
]);

/** True when a repo-relative path is worker-controlled test evidence. */
export function isProtectedTestPath(path: string): boolean {
  return [...PROTECTED_TEST_ROOT_PATTERNS, ...PROTECTED_TEST_FILE_PATTERNS].some((pattern) =>
    pattern.test(path),
  );
}

/** True when a repo-relative path is protected runner/repository configuration. */
export function isProtectedConfigPath(path: string): boolean {
  return (
    PROTECTED_CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(path)) || /\.snap$/i.test(path)
  );
}

/**
 * True when a repo-relative path is a D11 protected policy path (ADR-0004
 * D-G.1): exactly the configuration patterns above. Deliberately WITHOUT the
 * test-root, test-file and `.snap` patterns — tests and snapshots are worker
 * evidence (W1.8), not D11 enforcement definitions, so a human-authored test
 * change is not a D11 event.
 */
export function isProtectedPolicyPath(path: string): boolean {
  return PROTECTED_CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** True when a repo-relative path is any kind of protected worker evidence. */
export function isProtectedStagePath(path: string): boolean {
  return isProtectedTestPath(path) || isProtectedConfigPath(path);
}
