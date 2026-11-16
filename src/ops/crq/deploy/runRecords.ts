/**
 * Run-record helpers of the deploy runbook, over injected fs/clock/phase seams.
 *
 * Ports `Run.claim_run_dir`, `Run.persist_recovery_receipt` and `Run.complete`
 * from `apps/crq-python/ops/deploy-runbook.py`. Inactive and unimported:
 * nothing here touches the disk; the caller supplies every effect.
 */
import { createHash } from 'node:crypto';

/** Python `Refused`: a precondition failed. */
export class Refused extends Error {
  override name = 'Refused';
}

function require_(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Refused(message);
}

export interface ClaimRunDirEffects {
  /** `Path(p).resolve()`. */
  resolve(path: string): string;
  /** `Path(base) / name`. */
  join(base: string, name: string): string;
  /** `base.mkdir(mode=0o700, parents=True, exist_ok=True)`. */
  mkdirPrivateAll(path: string): void;
  /** `base.stat().st_mode & 0o777` (permission bits of the record directory). */
  mode(path: string): number;
  /** `run_dir.mkdir(mode=0o700)`; throws (OSError) when it already exists. */
  mkdirPrivate(path: string): void;
  /** `time.gmtime()` instant. */
  now(): Date;
  /** `uuid.uuid4().hex`. */
  uuidHex(): string;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** `time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())`. */
export function runStamp(at: Date): string {
  const year = String(at.getUTCFullYear()).padStart(4, '0');
  return `${year}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}T${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}Z`;
}

/** True when `descendant` is below `root`; equality is refused by the caller. */
function isStrictlyInside(root: string, descendant: string): boolean {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return descendant.startsWith(prefix);
}

/** Python `claim_run_dir`: a fresh private run directory outside the checkout. */
export function claimRunDir(
  effects: ClaimRunDirEffects,
  recordDir: string,
  checkoutRoot: string,
): string {
  const resolved = effects.resolve(recordDir);
  const root = effects.resolve(checkoutRoot);
  require_(
    resolved !== root && !isStrictlyInside(root, resolved),
    '--record-dir must be outside the deployment checkout',
  );
  effects.mkdirPrivateAll(recordDir);
  require_(
    (effects.mode(recordDir) & 0o077) === 0,
    `private record directory must have mode 0700: ${recordDir}`,
  );
  const name = `run-${runStamp(effects.now())}-${effects.uuidHex().slice(0, 6)}`;
  const runDir = effects.join(recordDir, name);
  effects.mkdirPrivate(runDir);
  return runDir;
}

export interface RecoveryReceiptEffects {
  exists(path: string): boolean;
  /** `load_json`: parsed JSON, or a `Refused`. */
  loadJson(path: string): unknown;
  /** `durable_write`. */
  durableWrite(path: string, payload: Record<string, unknown>): void;
  /** `now_iso()`. */
  nowIso(): string;
}

export interface RecoveryReceiptInput {
  readonly runDir: string;
  readonly target: string;
  readonly priorSha: string;
  readonly originalTriggers: Record<string, string>;
  readonly cqBin: unknown;
  readonly originalConfig: Uint8Array;
  readonly preserved: unknown;
}

/** Python `==` on JSON data: bool/int/float compare numerically, dicts by key set. */
export function pyEqual(left: unknown, right: unknown): boolean {
  const num = (v: unknown): number | null =>
    typeof v === 'boolean' ? Number(v) : typeof v === 'number' ? v : null;
  const a = num(left);
  const b = num(right);
  if (a !== null || b !== null) return a !== null && b !== null && a === b;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((v, i) => pyEqual(v, right[i]))
    );
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const l = left as Record<string, unknown>;
    const r = right as Record<string, unknown>;
    const keys = Object.keys(l);
    return (
      keys.length === Object.keys(r).length &&
      keys.every((k) => Object.hasOwn(r, k) && pyEqual(l[k], r[k]))
    );
  }
  return left === right;
}

/**
 * Python `persist_recovery_receipt`: write `recovery-receipt.json` once. An
 * existing receipt must equal the new one modulo `written_at`, else refuse.
 */
export function persistRecoveryReceipt(
  effects: RecoveryReceiptEffects,
  input: RecoveryReceiptInput,
): void {
  const path = `${input.runDir.replace(/\/+$/, '')}/recovery-receipt.json`;
  const receipt: Record<string, unknown> = {
    operation: 'deploy',
    written_at: effects.nowIso(),
    target: input.target,
    prior_sha: input.priorSha,
    original_triggers: input.originalTriggers,
    cq_bin: input.cqBin,
    config_sha256: createHash('sha256').update(input.originalConfig).digest('hex'),
    preserved: input.preserved,
  };
  if (effects.exists(path)) {
    const existing = effects.loadJson(path);
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing))
      throw new TypeError(`existing recovery receipt is not an object: ${typeof existing}`);
    const { written_at: _stamp, ...stored } = existing as Record<string, unknown>;
    const { written_at: _own, ...expected } = receipt;
    require_(
      pyEqual(stored, expected),
      `the recovery receipt in ${input.runDir} already exists with different content; ` +
        'refusing to mutate the recorded evidence',
    );
    return;
  }
  effects.durableWrite(path, receipt);
}

export interface CompleteContext {
  readonly priorSha: string;
  readonly target: string;
  readonly cqBin: unknown;
  readonly finalTriggers: Record<string, string>;
}
export interface CompleteEffects {
  /** Sets the run's `rollback` evidence so the next record carries it. */
  setRollback(rollback: Record<string, unknown>): void;
  writeRecord(outcome: string, extra: Record<string, unknown>): void;
  phase(name: string, extra: Record<string, unknown>): void;
  narrate(message: string): void;
}

/** Python `complete`: the completed record, the `released` phase and the narration. */
export function complete(effects: CompleteEffects, ctx: CompleteContext): void {
  effects.setRollback({
    permitted: true,
    to: ctx.priorSha,
    cq_bin: ctx.cqBin,
    statement:
      'rollback is available while the queue carries no schema marker or author_* keys; ' +
      'this run invoked it only on failure',
  });
  effects.writeRecord('completed', { released: true });
  effects.phase('released', { triggers: ctx.finalTriggers });
  effects.narrate(
    `deployed ${ctx.target.slice(0, 12)} (was ${ctx.priorSha.slice(0, 12)}); health ok`,
  );
}
