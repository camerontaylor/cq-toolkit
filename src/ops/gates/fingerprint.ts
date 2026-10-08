// Gates lane C2 — failure fingerprints that survive diff drift (R2 D5):
// a baseline/regression gate comparing raw failure positions would block on
// every harmless line shift; the fingerprint instead buckets position and
// deliberately EXCLUDES the message text for positioned non-Vitest failures, so a
// pre-existing failure re-keys to the same fingerprint after small drift
// while a genuinely new failure still keys differently. LOCATION-LESS
// failures (line null — vitest's suite/assertion shape) have no position to
// bucket, so they match by CONTENT instead: the normalized message — for
// vitest assertions the FULL test name, since `adapters/vitest.ts` carries the
// test's `fullName` (or `ancestorTitles`+`title`) in `message`. Suite-level
// vitest failures (ruleId `vitest-suite` or `vitest-unnamed`, free-form error text) use the
// first-line content regime instead. Duplicate canonical
// identities receive occurrence ordinals, preserving counts without
// depending on input order. Pure decision code: zero I/O.
//
// Invariants honored here:
//   - Determinism: the same failure always yields the same fingerprint —
//     the hash is FNV-1a 32-bit, implemented inline (no crypto import), so
//     output is stable across processes and platforms.
//   - Key components: `tool|file|ruleId|severity|position` — tool and
//     severity are identity (an error escalation at a tolerated warning's
//     spot is a regression; cross-tool failures never collide); position is
//     bucketed, never exact (line/column buckets default 20, offset bucket
//     default 500 — documented coarseness, asserted in tests).
//   - Matching regimes: Vitest test failures match by full test name regardless
//     of reported location; other positioned failures match by drift-tolerant
//     position (message ignored); other location-less failures match by the
//     FIRST LINE of the normalized message plus the offset bucket, so
//     volatile free-form tool text still keys stably. On the positioned
//     branch a null column folds to bucket 0 (a column-less failure shares
//     its line bucket with its column-less siblings).
//   - Exactness: gate decisions compare FULL canonical keys — JSON of the
//     component tuple, so components containing `|` (or any delimiter)
//     cannot collide across splits. The 32-bit FNV form is a compact
//     display/ledger encoding of the key, NEVER the comparison unit, making
//     novel/fixed detection deterministic rather than probabilistic.
import { VITEST_SUITE_RULE_ID, VITEST_UNNAMED_RULE_ID } from './adapters/vitest.js';
import type { CheckFailure, FailureSet } from './checkRunner.js';

/**
 * Fingerprint tuning. All fields optional; the defaults are the documented
 * contract (20-line/20-column buckets, 500-offset buckets). `rootDir`, when
 * set, is stripped from file paths before hashing so fingerprints do not
 * depend on where the repo was checked out. `tool` is normally supplied by
 * {@link fingerprintSet} from the FailureSet itself; setting it by hand
 * namespaces ad-hoc single-failure keys.
 */
export interface FingerprintConfig {
  /** Bucket width for line numbers (default 20). */
  lineBucketSize?: number;
  /** Bucket width for columns (default 20). */
  columnBucketSize?: number;
  /** Bucket width for offset-addressed failures (line null; default 500). */
  offsetBucketSize?: number;
  /** Repository root stripped from file paths before hashing (posix separators). */
  rootDir?: string;
  /** Tool namespace in the key; {@link fingerprintSet} always sets it from the FailureSet. */
  tool?: string;
}

/** FNV-1a 32-bit offset basis and prime (the standard constants). */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Config with defaults applied — the single place bucket sizes are chosen. */
function resolveConfig(cfg?: FingerprintConfig): Required<FingerprintConfig> {
  return {
    lineBucketSize: cfg?.lineBucketSize ?? 20,
    columnBucketSize: cfg?.columnBucketSize ?? 20,
    offsetBucketSize: cfg?.offsetBucketSize ?? 500,
    rootDir: cfg?.rootDir ?? '',
    tool: cfg?.tool ?? '',
  };
}

/**
 * FNV-1a 32-bit hash of a string, as 8 lowercase hex digits. Exported so the
 * known-vector test can pin the published FNV-1a values, pinning the whole
 * fingerprint scheme against silent change. Operates on UTF-16 code units —
 * deterministic everywhere; identical to byte-wise FNV-1a for ASCII keys.
 */
export function fnv1a32Hex(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The EXACT identity of one failure: JSON of its component tuple — in
 * spirit `tool|file|ruleId|severity|testName` for Vitest failures,
 * `tool|file|ruleId|severity|position|lineBucket:colBucket` for other
 * positioned failures and `tool|file|ruleId|severity|message|offN` for
 * other location-less ones, but array-encoded so no delimiter in any
 * component can make two different failures key identically. This is what
 * the regression gate compares once an occurrence ordinal is appended (see
 * {@link fingerprintPairs}).
 */
export function fingerprintKey(f: CheckFailure, cfg?: FingerprintConfig): string {
  return JSON.stringify(keyComponents(f, resolveConfig(cfg)));
}

/**
 * The drift-surviving COMPACT form of {@link fingerprintKey}: FNV-1a 32-bit
 * over the key, as 8 lowercase hex digits — for display and ledgers. Gate
 * decisions never use this form. The message is not a component of
 * other tools' positioned failures (message rewording is exactly the drift
 * survived); it IS the identity of a Vitest failure (test name, wherever
 * reported) and of a location-less failure (stable text).
 */
export function fingerprintFailure(f: CheckFailure, cfg?: FingerprintConfig): string {
  return fnv1a32Hex(fingerprintKey(f, resolveConfig(cfg)));
}

/**
 * The compact fingerprint under the PRE-W4.4 scheme (ledger signature
 * scheme 1), kept ONLY so persisted ledger escalations survive the scheme
 * change: Vitest failures key by position (located) or first message line
 * (location-less) like every other tool, and suite-level failures carry the
 * null ruleId they had before {@link VITEST_SUITE_RULE_ID} existed. Equal to
 * {@link fingerprintFailure} for every non-Vitest tool. Never a gate input.
 */
export function legacyFingerprintFailure(f: CheckFailure, cfg?: FingerprintConfig): string {
  const resolved = resolveConfig(cfg);
  const ruleId = resolved.tool === 'vitest' && isFreeFormVitestRule(f.ruleId) ? null : f.ruleId;
  return fnv1a32Hex(JSON.stringify(locationComponents({ ...f, ruleId }, resolved)));
}

/**
 * Every failure of a {@link FailureSet} paired with its OCCURRENCE key — the
 * exact canonical {@link fingerprintKey} with a `#<ordinal>` suffix — the
 * FailureSet's `tool` folded in. The ordinal preserves duplicate counts while
 * keeping comparison independent of failure order (ordinals are assigned in a
 * deterministic order of the equivalent failures, not array position, so the
 * pairing of failure to key is stable under shuffling too).
 *
 * The composite is collision-free: the canonical key is JSON array text that
 * always ends in `]` (components may themselves contain `#`), and the
 * appended ordinal is decimal digits, so the LAST `#` is always the separator
 * and `(identity, ordinal)` is recoverable.
 */
export function fingerprintPairs(
  s: FailureSet,
  cfg?: FingerprintConfig,
): Array<{ failure: CheckFailure; key: string }> {
  const effective = { ...cfg, tool: s.tool };
  const identities = s.failures.map((failure) => fingerprintKey(failure, effective));
  // Ordinals follow a deterministic order of equivalent failures (by their
  // excluded fields), never array position, so reports are order-invariant.
  const order = s.failures
    .map((_, index) => index)
    .sort(
      (a, b) =>
        compareText(identities[a] ?? '', identities[b] ?? '') ||
        compareFailures(s.failures[a], s.failures[b]) ||
        a - b,
    );
  const keys: string[] = new Array<string>(s.failures.length);
  const occurrences = new Map<string, number>();
  for (const index of order) {
    const identity = identities[index] ?? '';
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    keys[index] = `${identity}#${occurrence}`;
  }
  return s.failures.map((failure, index) => ({ failure, key: keys[index] ?? '' }));
}

/**
 * Total order: null, then numbers ascending, then NaN — so null and a
 * negative position never alias, and a NaN (reachable from SDK callers;
 * `a - b` would make the comparator inconsistent) sorts deterministically.
 */
function compareNullableNumber(a: number | null, b: number | null): number {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? -1 : 1;
  }
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return Number.isNaN(a) === Number.isNaN(b) ? 0 : Number.isNaN(a) ? 1 : -1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders null before any string, so null and '' never alias. */
function compareNullableText(a: string | null, b: string | null): number {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? -1 : 1;
  }
  return compareText(a, b);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total order over every failure field, used only to break ties among equivalent failures. */
function compareFailures(a: CheckFailure | undefined, b: CheckFailure | undefined): number {
  if (a === undefined || b === undefined) {
    return 0;
  }
  return (
    compareNullableNumber(a.line, b.line) ||
    compareNullableNumber(a.column, b.column) ||
    compareText(a.message, b.message) ||
    compareNullableText(a.file, b.file) ||
    compareNullableText(a.ruleId, b.ruleId) ||
    compareText(a.severity, b.severity)
  );
}

/**
 * The occurrence-key set of a whole {@link FailureSet}. Duplicate
 * canonical identities have distinct ordinals, so the set retains
 * multiset counts while remaining order-invariant. Keys are canonical
 * identities plus an ordinal suffix, never compact hashes.
 */
export function fingerprintSet(s: FailureSet, cfg?: FingerprintConfig): Set<string> {
  return new Set(fingerprintPairs(s, cfg).map((pair) => pair.key));
}

/** Vitest failures whose message is free-form error text, not a test name. */
function isFreeFormVitestRule(ruleId: string | null): boolean {
  return ruleId === VITEST_SUITE_RULE_ID || ruleId === VITEST_UNNAMED_RULE_ID;
}

/** The component tuple of the pre-hash key: tool, normalized file, ruleId, severity, and the position regime. */
function keyComponents(f: CheckFailure, cfg: Required<FingerprintConfig>): string[] {
  if (cfg.tool === 'vitest' && !isFreeFormVitestRule(f.ruleId)) {
    const file = f.file === null ? '' : normalizePath(f.file, cfg.rootDir);
    return [cfg.tool, file, f.ruleId ?? '', f.severity, 'test-name', normalizeTestName(f.message)];
  }
  return locationComponents(f, cfg);
}

/** The position (located) or first-line content (location-less) component tuple. */
function locationComponents(f: CheckFailure, cfg: Required<FingerprintConfig>): string[] {
  const file = f.file === null ? '' : normalizePath(f.file, cfg.rootDir);
  const ruleId = f.ruleId ?? '';
  if (typeof f.line === 'number') {
    const lineBucket = Math.floor(f.line / cfg.lineBucketSize);
    const colBucket = Math.floor((f.column ?? 0) / cfg.columnBucketSize);
    return [cfg.tool, file, ruleId, f.severity, 'position', String(lineBucket), String(colBucket)];
  }
  const offsetBucket = Math.floor((f.column ?? 0) / cfg.offsetBucketSize);
  return [
    cfg.tool,
    file,
    ruleId,
    f.severity,
    'content',
    normalizeMessage(f.message),
    String(offsetBucket),
  ];
}

/**
 * Vitest identity: the FULL message with whitespace runs collapsed and
 * trimmed. `adapters/vitest.ts` already funnels the test's `fullName` (or
 * `ancestorTitles`+`title`) into `message`, so for a named test this is the
 * whole test name; suite-level (`vitest-suite`) and unnamed-assertion
 * (`vitest-unnamed`) failures never reach this function — their free-form
 * error text takes the position / first-line regime. Case is PRESERVED — distinct names differing only
 * in case stay distinct. NO length cap: hashing is O(n) anyway, and a cap
 * would only mint a prefix-collision class (two long distinct names sharing
 * a prefix would key identically).
 */
function normalizeTestName(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

/**
 * Location-less identity for every OTHER tool: the FIRST line of the
 * message, whitespace runs collapsed and trimmed. First-line truncation is
 * what keeps free-form tool text (stack traces, diffs, timings)
 * drift-tolerant; the vitest regime above does not need it because a test
 * name is one line. Case is PRESERVED — distinct messages differing only in
 * case stay distinct.
 */
function normalizeMessage(message: string): string {
  const newline = message.indexOf('\n');
  const firstLine = newline === -1 ? message : message.slice(0, newline);
  return firstLine.replace(/\s+/g, ' ').trim();
}

/** Backslashes to posix separators, then strip `rootDir` (also posix-normalized) when the path is under it. */
function normalizePath(file: string, rootDir: string): string {
  const posix = file.replace(/\\/g, '/');
  if (rootDir === '') {
    return posix;
  }
  const root = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root !== '' && (posix === root || posix.startsWith(`${root}/`))) {
    return posix.slice(root.length).replace(/^\/+/, '');
  }
  return posix;
}
