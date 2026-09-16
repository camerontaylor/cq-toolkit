// captureBaseline + pruneBaselines — lane H slice 2.
//
// createCaptureBaseline is a kernel Op factory (data-in/data-out, OpResult
// taxonomy): it records ONE (target, metric) baseline into <ws>/baselines.
//
// CODEX P1 (op-input serializability): the kernel's makeManifest clones
// Job.input with structuredClone, and functions cannot be cloned — so the
// metric runner NEVER travels in the op input. The input carries only a
// `sourceId` string; the actual MetricSource functions live in a
// SourceCatalog (ReadonlyMap — chosen over a plain Record for a type-safe
// string keyset) injected once at composition time by the caller (tests
// now, lane C's CheckRunner wiring next phase, CLI later). There is no
// default op instance that hides this dependency. Like the adapter registry,
// the catalog is runtime-only and never persisted.
//
// Failure direction, named (I5): a null from the source or the adapter is
// NON-PASSING EVIDENCE — the op returns `failed` naming the metric, never a
// fabricated pass and never a fabricated baseline; the same holds when the
// source or adapter THROWS (a throw never crosses the op seam — and
// rejections are not assumed to be Errors: any thrown value is mapped to a
// message). A type-violating adapter — undefined or any non-object where a
// MetricReading was declared — is treated the same: non-passing evidence
// (I5), not a crash. The write path does not trust its own output either: a
// non-finite reading and an unparseable capturedAt both fail the capture.
// A corrupt EXISTING baseline is likewise a failure, as is an EXISTING
// baseline whose identity (target, metric, direction, unit) disagrees with
// the capture: evidence is never silently re-identified, re-scaled, or
// overwritten. Baselines land via temp-file + rename in the same
// directory, so a crash mid-write can never leave a torn baseline at the
// target path — and a failed publish cleans up its temp file (best-effort).
// P1 containment: before any read or mutation the baselines dir is
// realpath-resolved and must be a STRICT DESCENDANT of the resolved ws (a
// baselines → ws self-symlink would make prune scan the ws root); a symlinked
// baselines dir pointing outside fails the capture and makes prune return
// the zero outcome with `error` — nothing outside the workspace is ever
// touched — and containment runs BEFORE the existing-baseline read, so a
// symlinked baselines dir can neither be read from nor serve an
// ok/unchanged verdict. Capture does NOT judge tightening (that is the
// checkRatchet/guard's job in H2) — it records facts and reports the
// lifecycle trio created/updated/unchanged, rewriting an equal-value
// baseline only when the rendered bytes differ.
//
// pruneBaselines deletes baseline files whose (target, metric) is no longer
// live, and NEVER THROWS: I/O faults are reported per-file in `unreadable`
// (distinct from `skipped`, which means readable-but-unclassifiable content —
// including a file whose name disagrees with its parsed (target, metric) —
// nothing is deleted that cannot be classified), and a scan that cannot
// start at all returns the zero outcome with `error` describing the fault
// (including a baselines dir that resolves outside the ws — P1).
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { lock } from 'proper-lockfile';
import type { LockOptions } from 'proper-lockfile';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { Op, OpResult } from '../../kernel/types.js';
import { baselineRelPath, isIso8601Instant, parseBaseline, renderBaseline } from './format.js';
import type { BaselineFile } from './format.js';
import { getAdapter } from './registry.js';
import type { MetricReading, MetricSource } from './registry.js';

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Any thrown value → a message string. Rejections are not assumed to be
 * Errors (a `Promise.reject(null)` must not turn into a TypeError inside the
 * handler): Error → .message; object with a non-empty string message → it;
 * string → itself; anything else (null/undefined/plain object) → 'unknown
 * error'.
 */
function errorMessage(err: unknown): string {
  // The whole body is guarded (review-debt #72): a hostile thrown object's
  // `message` getter can itself throw, and a containment helper that
  // throws inside a catch handler would REPLACE the original fault.
  try {
    if (err instanceof Error) return err.message;
    if (typeof err === 'object' && err !== null) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string' && message !== '') return message;
      return 'unknown error';
    }
    if (typeof err === 'string') return err;
  } catch {
    // the thrown value's message accessor threw — fall through
  }
  return 'unknown error';
}

/**
 * P1 containment: the baselines dir must resolve to a STRICT DESCENDANT of
 * the resolved ws. realpath resolves intermediate symlinks, so a symlinked
 * baselines dir pointing outside the workspace — or AT the workspace
 * itself, which would make prune scan the ws root — fails the prefix
 * check; neither capture nor prune may touch anything outside (or at) the
 * ws. `missing` (ENOENT) is reported separately: for capture it means a
 * vanishing dir mid-op, for prune the ordinary no-baselines-yet case, and
 * for checkRatchet (which shares this resolver — additive export, no
 * behavior change) it means there is no baseline to check against.
 */
export async function resolveBaselinesDir(
  ws: string,
): Promise<{ ok: true; dir: string } | { ok: false; missing: boolean; error: string }> {
  const baselinesDir = join(ws, 'baselines');
  let wsReal: string;
  let dirReal: string;
  try {
    [wsReal, dirReal] = await Promise.all([realpath(ws), realpath(baselinesDir)]);
  } catch (err) {
    if (isEnoent(err)) return { ok: false, missing: true, error: `${baselinesDir} does not exist` };
    return {
      ok: false,
      missing: false,
      error: `could not resolve '${baselinesDir}' — ${errorMessage(err)}`,
    };
  }
  const prefix = wsReal.endsWith(sep) ? wsReal : wsReal + sep;
  if (dirReal.startsWith(prefix) === false) {
    return {
      ok: false,
      missing: false,
      error: `baselines dir '${baselinesDir}' does not resolve to a strict descendant of the workspace ('${dirReal}') — refusing to touch it`,
    };
  }
  return { ok: true, dir: dirReal };
}

/** Capture one (target, metric) baseline in a workspace. Fully serializable: survives structuredClone. */
export interface CaptureBaselineInput {
  ws: string;
  target: string;
  metric: string;
  /** Key into the capture catalog injected via createCaptureBaseline. */
  sourceId: string;
  /** Overrides the capture clock (ISO-8601); tests pin this for determinism. */
  capturedAt?: string;
}

/** Runtime-only wiring: metric id → the runner that produces its raw data. Never persisted, never cloned into an op input. */
export type SourceCatalog = ReadonlyMap<string, MetricSource>;

export interface CaptureBaselineOutcome {
  /** Repo-relative baseline path, e.g. 'baselines/typecheck--typecheck-count--7caef1e76077.json'. */
  path: string;
  value: number;
  /** The previously recorded value; null when none existed. */
  previous: number | null;
  lifecycle: 'created' | 'updated' | 'unchanged';
}

/** Build the capture op over a fixed source catalog (see the CODEX P1 note above). */
export function createCaptureBaseline(
  sources: SourceCatalog,
): Op<CaptureBaselineInput, CaptureBaselineOutcome> {
  return async (input) => {
    if (input.capturedAt !== undefined && isIso8601Instant(input.capturedAt) === false) {
      return {
        status: 'failed',
        error: `ratchet: invalid capturedAt '${input.capturedAt}' — must be a strict ISO-8601 instant`,
      };
    }
    const adapter = getAdapter(input.metric);
    if (adapter === undefined) {
      return {
        status: 'failed',
        error: `ratchet: unknown metric '${input.metric}' — no registered adapter`,
      };
    }
    const source = sources.get(input.sourceId);
    if (source === undefined) {
      return {
        status: 'failed',
        error: `ratchet: unknown source '${input.sourceId}' for metric '${input.metric}' — not in the capture catalog`,
      };
    }

    let raw: unknown;
    try {
      raw = await source(input.ws);
    } catch (err) {
      return {
        status: 'failed',
        error: `ratchet: metric '${input.metric}' source failed — ${errorMessage(err)}`,
      };
    }
    let reading: MetricReading | null;
    try {
      reading = raw === null ? null : adapter.extract(raw);
    } catch (err) {
      return {
        status: 'failed',
        error: `ratchet: metric '${input.metric}' adapter failed — ${errorMessage(err)}`,
      };
    }
    // A type-violating adapter (declared MetricReading | null) can return
    // undefined — or any non-object — at runtime; null, undefined, and
    // non-objects are all the same I5 non-passing evidence, never a
    // TypeError on a later `.value` dereference.
    if (reading == null || typeof reading !== 'object') {
      return {
        status: 'failed',
        error:
          `ratchet: metric '${input.metric}' has no metrics summary in '${input.ws}' ` +
          '(I5: non-passing evidence, never a pass) — baseline not captured',
      };
    }
    // The reading is ADAPTER-OWNED: its fields may be getters or a hostile
    // Proxy that throws on access, so value and unit are snapshotted ONCE
    // inside this containment; only the snapshots are used downstream. The
    // adapter's `direction` joins the snapshot (review-debt #72): it is
    // adapter-owned property too, read later at the render and the identity
    // check, where a throwing/mutating getter would previously have escaped
    // the op seam — and a direction outside the two literals is refused
    // here rather than silently rendered into an unparsable baseline.
    let value: number;
    let unit: string | undefined;
    let direction: 'lower-is-better' | 'higher-is-better';
    try {
      value = reading.value;
      unit = reading.unit;
      const adapterDirection = adapter.direction;
      if (adapterDirection !== 'lower-is-better' && adapterDirection !== 'higher-is-better') {
        return {
          status: 'failed',
          error:
            `ratchet: metric '${input.metric}' adapter produced an unusable direction ` +
            `(${String(adapterDirection)}) — baseline not captured`,
        };
      }
      direction = adapterDirection;
      if (!Number.isFinite(value)) {
        // A non-finite value would JSON.stringify to null and the written
        // file would fail its own parser — refuse it here, at the boundary.
        return {
          status: 'failed',
          error:
            `ratchet: metric '${input.metric}' adapter produced an unusable reading ` +
            `(${value}) — baseline not captured`,
        };
      }
    } catch (err) {
      return {
        status: 'failed',
        error:
          `ratchet: metric '${input.metric}' adapter produced an unusable reading — ` +
          `${errorMessage(err)}`,
      };
    }

    const relPath = baselineRelPath(input.target, input.metric);

    // Boundary self-check: BOTH the render and a parse-back of its bytes
    // run inside this containment — a third-party adapter shape that makes
    // JSON.stringify throw (e.g. unit: 1n, a BigInt) or that renders to
    // bytes failing their own parser (unit: null, a bogus direction) is a
    // `failed` verdict, never a throw across the op seam.
    let bytes: string;
    try {
      bytes = renderBaseline({
        schemaVersion: 1,
        target: input.target,
        metric: input.metric,
        direction: direction,
        value: value,
        ...(unit === undefined ? {} : { unit }),
        capturedAt: input.capturedAt ?? new Date().toISOString(),
      });
      parseBaseline(bytes);
    } catch (err) {
      return {
        status: 'failed',
        error:
          `ratchet: metric '${input.metric}' produced an unparsable baseline — refusing to publish — ` +
          `${errorMessage(err)}`,
      };
    }

    // P1 containment BEFORE any read of the baselines dir: ensure it exists,
    // then resolve both paths and require baselines to stay inside the ws.
    // The existing-file read below uses the RESOLVED dir, so a symlinked
    // baselines dir pointing outside can neither be read from nor written
    // to, and the unchanged fast path is only reachable after containment
    // passed.
    try {
      await mkdir(join(input.ws, 'baselines'), { recursive: true });
    } catch (err) {
      return {
        status: 'indeterminate',
        detail: `ratchet: could not ensure baselines dir for '${input.ws}' — ${errorMessage(err)}`,
      };
    }
    const containment = await resolveBaselinesDir(input.ws);
    if (containment.ok === false) {
      if (containment.missing) {
        return {
          status: 'indeterminate',
          detail: `ratchet: baselines dir vanished during capture — ${containment.error}`,
        };
      }
      return { status: 'failed', error: containment.error };
    }
    // Read/write through the RESOLVED dir: relPath's 'baselines/' prefix is
    // the virtual repo-relative form; containment guarantees it maps here.
    const absPath = join(containment.dir, relPath.slice('baselines/'.length));

    // Leaf check BEFORE the read: the expected baseline file itself may be
    // a symlink — the read would follow it, and byte-identical external
    // content would hit the unchanged fast path. Anything that is not a
    // regular file is refused outright.
    try {
      const leafStat = await lstat(absPath);
      if (leafStat.isFile() === false) {
        return {
          status: 'failed',
          error: `ratchet: existing baseline '${relPath}' is not a regular file — refusing to overwrite`,
        };
      }
    } catch (err) {
      if (!isEnoent(err)) {
        return {
          status: 'indeterminate',
          detail: `ratchet: could not inspect existing baseline '${relPath}' — ${errorMessage(err)}`,
        };
      }
    }

    // Per-path mutual exclusion (review-debt #68): a plan with two
    // dependency-free capture jobs for the SAME (target, metric) executes
    // its wave concurrently; without serialization both read the same
    // prior file and race their publishes — the last rename wins
    // nondeterministically, one reported lifecycle disagrees with the
    // persisted evidence, and the looser measurement can be left behind.
    // proper-lockfile (the same dependency the ledger lane binds) wraps
    // the whole read→identity→publish critical section per ABSOLUTE path:
    // same-path captures serialize, different paths never contend. A
    // rejected release is an indeterminate fault, never a swallowed ok;
    // lock acquisition itself failing (a wedged foreign lock past the
    // backoff) is indeterminate too — the baseline was NOT written.
    const readModifyPublish = async (): Promise<OpResult<CaptureBaselineOutcome>> => {
      let existingText: string | null = null;
      try {
        existingText = await readFile(absPath, 'utf8');
      } catch (err) {
        if (!isEnoent(err)) {
          return {
            status: 'indeterminate',
            detail: `ratchet: could not read existing baseline '${relPath}' — ${errorMessage(err)}`,
          };
        }
      }

      let previous: number | null = null;
      let lifecycle: CaptureBaselineOutcome['lifecycle'] = 'created';
      if (existingText !== null) {
        let existing: BaselineFile;
        try {
          existing = parseBaseline(existingText);
        } catch (err) {
          return {
            status: 'failed',
            error:
              `ratchet: existing baseline '${relPath}' is corrupt and was not overwritten — ` +
              `${errorMessage(err)}`,
          };
        }
        // Identity check BEFORE the value is trusted: a file at the expected
        // path that belongs to another identity — mistaken move, adapter
        // direction change, UNIT change — is never accepted as `previous` nor
        // overwritten: values in different units are never the same ratchet
        // evidence. Every disagreeing field is named.
        const disagreements: string[] = [];
        if (existing.target !== input.target) {
          disagreements.push(`target '${existing.target}' → '${input.target}'`);
        }
        if (existing.metric !== input.metric) {
          disagreements.push(`metric '${existing.metric}' → '${input.metric}'`);
        }
        if (existing.direction !== direction) {
          disagreements.push(`direction '${existing.direction}' → '${direction}'`);
        }
        if (existing.unit !== unit) {
          const renderUnit = (u: string | undefined): string =>
            u === undefined ? 'undefined' : `'${u}'`;
          disagreements.push(`unit ${renderUnit(existing.unit)} → ${renderUnit(unit)}`);
        }
        if (disagreements.length > 0) {
          return {
            status: 'failed',
            error:
              `ratchet: existing baseline '${relPath}' for metric '${input.metric}' disagrees on ` +
              `${disagreements.join('; ')} — incomparable scale — refusing to overwrite`,
          };
        }
        previous = existing.value;
        lifecycle = existing.value === value ? 'unchanged' : 'updated';
        // Equal value AND identical bytes: the file is already exactly what this
        // capture would write — leave it untouched (no spurious mtime churn).
        if (lifecycle === 'unchanged' && bytes === existingText) {
          return { status: 'ok', value: { path: relPath, value: value, previous, lifecycle } };
        }
      }

      let tempPath: string | undefined;
      let tempCreated = false;
      try {
        // Atomic publish: bytes land in a unique temp file in the SAME
        // directory, then rename over the target — a crash mid-write can
        // never leave a torn baseline at the target path. The temp is created
        // EXCLUSIVELY ('wx'): the PID/counter name is predictable, and a
        // pre-planted symlink there would make a plain 'w' write follow it
        // and truncate the outside target. EEXIST advances the counter —
        // bounded retries, then indeterminate. Cleanup below only ever
        // removes a temp THIS invocation actually created: exhausted retries
        // collide on pre-existing entries that must stay untouched.
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidate = join(
            dirname(absPath),
            `.${basename(absPath)}.${process.pid}.${++tempFileCounter}.tmp`,
          );
          let handle: FileHandle;
          try {
            handle = await open(candidate, 'wx');
          } catch (err) {
            if ((err as { code?: unknown }).code !== 'EEXIST' || attempt === 4) throw err;
            continue;
          }
          // OWNED FROM THE OPEN, not from a completed write (review-debt
          // #69): writeFile(flag 'wx') marks ownership only AFTER the bytes
          // land, so a fault mid-write (ENOSPC, I/O error) left the
          // just-created zero-length temp behind as debris. The handle
          // sequence owns the file the moment the exclusive open succeeds —
          // a faulting write still reaches the cleanup unlink below.
          tempPath = candidate;
          tempCreated = true;
          try {
            await handle.writeFile(bytes);
          } finally {
            await handle.close();
          }
          break;
        }
        if (tempCreated === false || tempPath === undefined) {
          throw new Error('all temp candidates already existed');
        }
        await rename(tempPath, absPath);
      } catch (err) {
        // Best-effort temp cleanup: a failed publish must not litter
        // baselines/ with .tmp debris (unlink errors are swallowed — the
        // indeterminate verdict already names the primary fault). Ownership
        // guard: only a temp created by THIS invocation is removed — a
        // colliding pre-existing entry is never ours to delete.
        if (tempPath !== undefined && tempCreated) {
          await unlink(tempPath).catch(() => undefined);
        }
        return {
          status: 'indeterminate',
          detail: `ratchet: writing baseline '${relPath}' failed — ${errorMessage(err)}`,
        };
      }
      return { status: 'ok', value: { path: relPath, value: value, previous, lifecycle } };
    };
    try {
      const release = await lock(absPath, CAPTURE_LOCK_OPTIONS);
      return await Promise.resolve()
        .then(readModifyPublish)
        .then(
          (outcome) =>
            // A rejected release is a fault: the critical section ran, but
            // the lock state is unknown — report indeterminate naming it.
            release()
              .then(() => outcome)
              .catch(
                (releaseErr: unknown) =>
                  ({
                    status: 'indeterminate',
                    detail: `ratchet: lock release failed for baseline '${relPath}' — ${errorMessage(releaseErr)}`,
                  }) as OpResult<CaptureBaselineOutcome>,
              ),
          (sectionErr: unknown) =>
            // The section already returned its own verdicts; a THROW here
            // is unexpected — release best-effort and surface it.
            release()
              .catch(() => undefined)
              .then(() => {
                throw sectionErr;
              }),
        );
    } catch (err) {
      return {
        status: 'indeterminate',
        detail: `ratchet: could not acquire the capture lock for baseline '${relPath}' — ${errorMessage(err)}`,
      };
    }
  };
}

/**
 * proper-lockfile tuning for the capture critical section (review-debt
 * #68), mirroring the ledger store's staleness policy: no realpath (the
 * baseline may not exist yet on a first capture), stale comfortably above
 * the worst-case all-sync section (the write is a small JSON file, but the
 * same sync-section-blocks-the-mtime-refresh reasoning applies — PR #78's
 * review). The acquire backoff is deliberately SHORT (≈1.6s cumulative):
 * the contention this lock exists for is same-process wave concurrency
 * (holders release in milliseconds), while a persistent acquire fault —
 * e.g. a read-only baselines dir — must surface as a fast indeterminate,
 * never a half-minute retry burn. A crashed holder's lock goes stale at
 * 30s and is stolen by a LATER capture.
 */
const CAPTURE_LOCK_OPTIONS: LockOptions = {
  realpath: false,
  stale: 30_000,
  retries: { retries: 6, factor: 2, minTimeout: 25 },
};

/** Temp-name salt: uniqueness within a process; EEXIST collisions (planted or raced) advance the counter, bounded. */
let tempFileCounter = 0;

/** Prune baselines that are no longer live. */
export interface PruneBaselinesInput {
  ws: string;
  live: Array<{ target: string; metric: string }>;
}

export interface PruneBaselinesOutcome {
  /** Repo-relative paths deleted (deterministic order). */
  deleted: string[];
  /** Files kept because their (target, metric) is live. */
  kept: number;
  /** Readable-but-unclassifiable content, or a non-regular entry (symlink/fifo/dir — never followed, never deleted). */
  skipped: string[];
  /** File exists but readFile/unlink failed (I/O fault) — left untouched. */
  unreadable: string[];
  /** Present only when the scan itself could not run; all arrays are then empty. */
  error?: string;
}

export async function pruneBaselines(input: PruneBaselinesInput): Promise<PruneBaselinesOutcome> {
  // Classify by CONTENT, not filename: the parsed baseline's (target, metric)
  // is normalized through the same path rule as the live list, so hand-renamed
  // or drifted filenames cannot strand a live baseline nor spare a dead one.
  const liveKeys = new Set(input.live.map((entry) => baselineRelPath(entry.target, entry.metric)));
  // P1 containment before any scan or unlink: an escape is the zero outcome
  // with `error` naming the resolved path — prune never touches outside ws.
  const containment = await resolveBaselinesDir(input.ws);
  if (containment.ok === false) {
    if (containment.missing) return { deleted: [], kept: 0, skipped: [], unreadable: [] }; // no baselines yet
    return {
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: [],
      error: containment.error,
    };
  }
  const baselinesDir = containment.dir;
  let names: string[];
  try {
    names = await readdir(baselinesDir);
  } catch (err) {
    if (isEnoent(err)) return { deleted: [], kept: 0, skipped: [], unreadable: [] }; // no baselines yet
    return {
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: [],
      error: `could not scan '${baselinesDir}' — ${errorMessage(err)}`,
    };
  }

  const deleted: string[] = [];
  const skipped: string[] = [];
  const unreadable: string[] = [];
  let kept = 0;
  // Sorted iteration → deterministic deleted/skipped/unreadable order
  // regardless of the filesystem's readdir order.
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const relPath = `baselines/${name}`;
    // Leaf check mirroring capture's: lstat BEFORE readFile — a non-regular
    // entry (symlink, fifo, dir) is never followed (outside escapes) and
    // never deleted; it is skipped as unclassifiable.
    try {
      const leafStat = await lstat(join(baselinesDir, name));
      if (leafStat.isFile() === false) {
        skipped.push(relPath);
        continue;
      }
    } catch (err) {
      if (isEnoent(err)) continue; // raced away — nothing left to classify
      skipped.push(relPath); // uninspectable → unclassifiable
      continue;
    }
    let text: string;
    try {
      text = await readFile(join(baselinesDir, name), 'utf8');
    } catch (err) {
      if (isEnoent(err)) continue; // raced away — nothing left to classify
      unreadable.push(relPath); // exists but unreadable: I/O fault, not content
      continue;
    }
    let parsed: BaselineFile;
    try {
      parsed = parseBaseline(text);
    } catch {
      skipped.push(relPath); // cannot classify the content → never delete
      continue;
    }
    // Name/content disagreement: the content classifies to another file's
    // path, so THIS file cannot be classified at all — skip, never delete.
    const ownPath = baselineRelPath(parsed.target, parsed.metric);
    if (ownPath !== relPath) {
      skipped.push(relPath);
      continue;
    }
    if (liveKeys.has(ownPath)) {
      kept++;
      continue;
    }
    try {
      await unlink(join(baselinesDir, name));
    } catch (err) {
      if (isEnoent(err)) continue; // raced away between read and unlink
      unreadable.push(relPath); // still there, removal failed: I/O fault
      continue;
    }
    deleted.push(relPath);
  }
  return { deleted, kept, skipped, unreadable };
}
