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
//     (normalized message). Residual limitation, documented: duplicate
//     identical location-less messages collapse under Set semantics — one
//     fixed copy of two identical failures is invisible to the gate.
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

/** Location-less messages are keyed by their first line, capped at this many characters. */
const MESSAGE_COMPONENT_CAP = 200;

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
 * The drift-surviving fingerprint of one failure: FNV-1a over
 * `tool|file|ruleId|severity|lineBucket:colBucket` for POSITIONED failures
 * (line is a number — message excluded, that is the drift survived), or
 * `tool|file|ruleId|severity|message|offN` for LOCATION-LESS failures (line
 * null — the normalized message is the identity: stable test names match,
 * a new failing test in the same file keys differently). Note the residual
 * limitation: two location-less failures with identical normalized content
 * share one fingerprint, and Set semantics cannot tell one surviving copy
 * from both surviving.
 */
export function fingerprintFailure(f: CheckFailure, cfg?: FingerprintConfig): string {
  return fnv1a32Hex(failureKey(f, resolveConfig(cfg)));
}

/**
 * Every failure of a {@link FailureSet} paired with its fingerprint, the
 * FailureSet's `tool` folded into the key. The regression gate compares
 * these pair lists so novel/fixed failures can be REPORTED, not just
 * counted.
 */
export function fingerprintPairs(
  s: FailureSet,
  cfg?: FingerprintConfig,
): Array<{ failure: CheckFailure; print: string }> {
  const effective = { ...cfg, tool: s.tool };
  return s.failures.map((failure) => ({ failure, print: fingerprintFailure(failure, effective) }));
}

/**
 * The fingerprint set of a whole {@link FailureSet} — the unit the
 * regression gate compares (Set membership makes the comparison
 * order-invariant).
 */
export function fingerprintSet(s: FailureSet, cfg?: FingerprintConfig): Set<string> {
  return new Set(fingerprintPairs(s, cfg).map((pair) => pair.print));
}

/** The pre-hash key: tool, normalized file, ruleId, severity, and the position regime. */
function failureKey(f: CheckFailure, cfg: Required<FingerprintConfig>): string {
  const file = f.file === null ? '' : normalizePath(f.file, cfg.rootDir);
  const ruleId = f.ruleId ?? '';
  if (typeof f.line === 'number') {
    const lineBucket = Math.floor(f.line / cfg.lineBucketSize);
    const colBucket = Math.floor((f.column ?? 0) / cfg.columnBucketSize);
    return `${cfg.tool}|${file}|${ruleId}|${f.severity}|${lineBucket}:${colBucket}`;
  }
  const offsetBucket = Math.floor((f.column ?? 0) / cfg.offsetBucketSize);
  return `${cfg.tool}|${file}|${ruleId}|${f.severity}|${normalizeMessage(f.message)}|off${offsetBucket}`;
}

/**
 * Location-less identity: first line of the message, whitespace runs
 * collapsed, trimmed, capped at 200 chars. Case is PRESERVED — distinct
 * test names that differ only in case stay distinct.
 */
function normalizeMessage(message: string): string {
  return message
    .split('\n', 1)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_COMPONENT_CAP);
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
