// Gates lane C2 — failure fingerprints that survive diff drift (R2 D5):
// a baseline/regression gate comparing raw failure positions would block on
// every harmless line shift; the fingerprint instead buckets position and
// deliberately EXCLUDES the message text, so a pre-existing failure re-keys
// to the same fingerprint after small drift while a genuinely new failure
// still keys differently. Pure decision code: zero I/O.
//
// Invariants honored here:
//   - Determinism: the same failure always yields the same fingerprint —
//     the hash is FNV-1a 32-bit, implemented inline (no crypto import), so
//     output is stable across processes and platforms.
//   - Position is bucketed, never exact: line/column buckets (default 20)
//     for line-addressed failures, an offset bucket (default 500) for
//     offset-addressed ones (line null) — documented coarseness, asserted
//     in tests (drift WITHIN a bucket survives, ACROSS buckets is a
//     regression).
import { z } from 'zod';
import type { CheckFailure, FailureSet } from './checkRunner.js';

/**
 * Fingerprint tuning. All fields optional; the defaults are the documented
 * contract (20-line/20-column buckets, 500-offset buckets). `rootDir`, when
 * set, is stripped from file paths before hashing so fingerprints do not
 * depend on where the repo was checked out.
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
}

/** Registry-time mirror of {@link FingerprintConfig}: the full object, and only it. */
export const FingerprintConfigSchema: z.ZodType<FingerprintConfig> = z
  .object({
    lineBucketSize: z.number().int().positive().optional(),
    columnBucketSize: z.number().int().positive().optional(),
    offsetBucketSize: z.number().int().positive().optional(),
    rootDir: z.string().optional(),
  })
  .strict();

/** FNV-1a 32-bit offset basis and prime (the standard constants). */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

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
 * `${file}|${ruleId}|${lineBucket}:${colBucket}` (line-addressed) or
 * `${file}|${ruleId}|off${offsetBucket}` (line null). The message is NOT a
 * component — message rewording is exactly the drift this must survive.
 */
export function fingerprintFailure(f: CheckFailure, cfg?: FingerprintConfig): string {
  return fnv1a32Hex(failureKey(f, resolveConfig(cfg)));
}

/**
 * The fingerprint set of a whole {@link FailureSet} — the unit the
 * regression gate compares (Set membership makes the comparison
 * order-invariant).
 */
export function fingerprintSet(s: FailureSet, cfg?: FingerprintConfig): Set<string> {
  return new Set(s.failures.map((failure) => fingerprintFailure(failure, cfg)));
}

/** Config with defaults applied — the single place bucket sizes are chosen. */
function resolveConfig(cfg?: FingerprintConfig): Required<Omit<FingerprintConfig, 'rootDir'>> & {
  rootDir?: string;
} {
  return {
    lineBucketSize: cfg?.lineBucketSize ?? 20,
    columnBucketSize: cfg?.columnBucketSize ?? 20,
    offsetBucketSize: cfg?.offsetBucketSize ?? 500,
    rootDir: cfg?.rootDir,
  };
}

/** The pre-hash key: normalized file, ruleId, and the bucketed position. */
function failureKey(
  f: CheckFailure,
  cfg: ReturnType<typeof resolveConfig>,
): string {
  const file = f.file === null ? '' : normalizePath(f.file, cfg.rootDir);
  const ruleId = f.ruleId ?? '';
  if (typeof f.line === 'number') {
    const lineBucket = Math.floor(f.line / cfg.lineBucketSize);
    const colBucket = Math.floor((f.column ?? 0) / cfg.columnBucketSize);
    return `${file}|${ruleId}|${lineBucket}:${colBucket}`;
  }
  const offsetBucket = Math.floor((f.column ?? 0) / cfg.offsetBucketSize);
  return `${file}|${ruleId}|off${offsetBucket}`;
}

/** Backslashes to posix separators, then strip `rootDir` (also posix-normalized) when the path is under it. */
function normalizePath(file: string, rootDir: string | undefined): string {
  const posix = file.replace(/\\/g, '/');
  if (rootDir === undefined || rootDir === '') {
    return posix;
  }
  const root = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root !== '' && (posix === root || posix.startsWith(`${root}/`))) {
    return posix.slice(root.length).replace(/^\/+/, '');
  }
  return posix;
}
