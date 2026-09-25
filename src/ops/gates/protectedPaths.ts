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
 * Configuration, package metadata, lockfiles, and repository automation that
 * can redefine what the final probe runs or how the result is measured.
 */
export const PROTECTED_CONFIG_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /\.config\.[^/]+$/i,
  /(?:^|\/)[^/]*\.setup\.[^/]+$/i,
  /(?:^|\/)\.[^/]*rc(?:\.[^/]*)?$/i,
  /(?:^|\/)\.gitignore$/i,
  /(?:^|\/)\.gitattributes$/i,
  /(?:^|\/)(?:tsconfig(?:\.[^/]+)?\.json|package\.json|biome\.jsonc?)$/i,
  /^\.github(?:\/|$)/i,
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

/** True when a repo-relative path is any kind of protected worker evidence. */
export function isProtectedStagePath(path: string): boolean {
  return isProtectedTestPath(path) || isProtectedConfigPath(path);
}
