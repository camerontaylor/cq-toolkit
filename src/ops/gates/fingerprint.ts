// Gates lane C2 — failure fingerprints that survive diff drift (R2 D5):
// a baseline/regression gate comparing raw failure positions would block on
// every harmless line shift; the fingerprint instead buckets position and
// deliberately EXCLUDES the message text for positioned failures, so a
// pre-existing failure re-keys to the same fingerprint after small drift
// while a genuinely new failure still keys differently. LOCATION-LESS
// failures (line null — vitest's suite/assertion shape) have no position to
// bucket, so they match by CONTENT instead: a normalized message component
// (stable test names) alongside the offset bucket. Pure decision code:
// zero I/O.
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
//   - Two matching regimes: positioned failures match by drift-tolerant
//     position (message ignored); location-less failures match by content
//     (normalized message). Residual limitations, documented (Set semantics
//     cannot count): duplicate IDENTICAL failures — positioned keys
//     included — collapse to one fingerprint, so one fixed copy of two
//     identical failures is invisible to the gate; and on the positioned
//     branch a null column folds to bucket 0 (a column-less failure shares
//     its line bucket with its column-less siblings).
//   - Exactness: gate decisions compare FULL canonical keys — JSON of the
//     component tuple, so components containing `|` (or any delimiter)
//     cannot collide across splits. The 32-bit FNV form is a compact
//     display/ledger encoding of the key, NEVER the comparison unit, making
//     novel/fixed detection deterministic rather than probabilistic.
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
 * spirit `tool|file|ruleId|severity|position|lineBucket:colBucket` for
 * POSITIONED failures and `tool|file|ruleId|severity|message|offN` for
 * LOCATION-LESS ones, but array-encoded so no delimiter in any component
 * can make two different failures key identically. This is what the
 * regression gate compares.
 */
export function fingerprintKey(f: CheckFailure, cfg?: FingerprintConfig): string {
  return JSON.stringify(keyComponents(f, resolveConfig(cfg)));
}

/**
 * The drift-surviving COMPACT form of {@link fingerprintKey}: FNV-1a 32-bit
 * over the key, as 8 lowercase hex digits — for display and ledgers. Gate
 * decisions never use this form. The message is not a positioned-failure
 * component (message rewording is exactly the drift survived); it IS the
 * identity of a location-less failure (stable test names).
 */
export function fingerprintFailure(f: CheckFailure, cfg?: FingerprintConfig): string {
  return fnv1a32Hex(fingerprintKey(f, resolveConfig(cfg)));
}

/**
 * Every failure of a {@link FailureSet} paired with its EXACT canonical
 * key, the FailureSet's `tool` folded in. The regression gate compares
 * these pair lists so novel/fixed failures can be REPORTED, not just
 * counted — by key equality, deterministically.
 */
export function fingerprintPairs(
  s: FailureSet,
  cfg?: FingerprintConfig,
): Array<{ failure: CheckFailure; key: string }> {
  const effective = { ...cfg, tool: s.tool };
  return s.failures.map((failure) => ({ failure, key: fingerprintKey(failure, effective) }));
}

/**
 * The canonical-key set of a whole {@link FailureSet} — the unit the
 * regression gate compares. Exact keys, not hashes: Set membership makes
 * the comparison order-invariant AND collision-free.
 */
export function fingerprintSet(s: FailureSet, cfg?: FingerprintConfig): Set<string> {
  return new Set(fingerprintPairs(s, cfg).map((pair) => pair.key));
}

/** The component tuple of the pre-hash key: tool, normalized file, ruleId, severity, and the position regime. */
function keyComponents(f: CheckFailure, cfg: Required<FingerprintConfig>): string[] {
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
 * Location-less identity: first line of the message, whitespace runs
 * collapsed, trimmed. Case is PRESERVED — distinct test names that differ
 * only in case stay distinct. NO length cap: hashing is O(n) anyway, and a
 * cap would only mint a prefix-collision class (two long distinct names
 * sharing a prefix would key identically).
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
