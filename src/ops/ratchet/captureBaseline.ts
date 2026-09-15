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
// source or adapter THROWS (a throw never crosses the op seam). A corrupt
// EXISTING baseline is likewise a failure: capture never silently overwrites
// evidence it cannot classify. Capture does NOT judge tightening (that is
// the checkRatchet/guard's job in H2) — it records facts and reports the
// lifecycle trio created/updated/unchanged, rewriting an equal-value
// baseline only when the rendered bytes differ.
//
// pruneBaselines deletes baseline files whose (target, metric) is no longer
// live, and NEVER THROWS: I/O faults are reported per-file in `unreadable`
// (distinct from `skipped`, which means readable-but-unparseable content —
// nothing is deleted that cannot be classified), and a scan that cannot
// start at all returns the zero outcome with `error` describing the fault.
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Op } from '../../kernel/types.js';
import { baselineRelPath, parseBaseline, renderBaseline } from './format.js';
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
  /** Repo-relative baseline path, e.g. 'baselines/typecheck--typecheck-count--f818e46f.json'. */
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
        error: `ratchet: metric '${input.metric}' source failed — ${(err as Error).message}`,
      };
    }
    let reading: MetricReading | null;
    try {
      reading = raw === null ? null : adapter.extract(raw);
    } catch (err) {
      return {
        status: 'failed',
        error: `ratchet: metric '${input.metric}' adapter failed — ${(err as Error).message}`,
      };
    }
    if (reading === null) {
      return {
        status: 'failed',
        error:
          `ratchet: metric '${input.metric}' has no metrics summary in '${input.ws}' ` +
          '(I5: non-passing evidence, never a pass) — baseline not captured',
      };
    }

    const relPath = baselineRelPath(input.target, input.metric);
    const absPath = join(input.ws, relPath);
    const bytes = renderBaseline({
      schemaVersion: 1,
      target: input.target,
      metric: input.metric,
      direction: adapter.direction,
      value: reading.value,
      unit: reading.unit,
      capturedAt: input.capturedAt ?? new Date().toISOString(),
    });

    let existingText: string | null = null;
    try {
      existingText = await readFile(absPath, 'utf8');
    } catch (err) {
      if (!isEnoent(err)) {
        return {
          status: 'indeterminate',
          detail: `ratchet: could not read existing baseline '${relPath}' — ${(err as Error).message}`,
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
            `${(err as Error).message}`,
        };
      }
      previous = existing.value;
      lifecycle = existing.value === reading.value ? 'unchanged' : 'updated';
      // Equal value AND identical bytes: the file is already exactly what this
      // capture would write — leave it untouched (no spurious mtime churn).
      if (lifecycle === 'unchanged' && bytes === existingText) {
        return { status: 'ok', value: { path: relPath, value: reading.value, previous, lifecycle } };
      }
    }

    try {
      await mkdir(join(input.ws, 'baselines'), { recursive: true });
      await writeFile(absPath, bytes, 'utf8');
    } catch (err) {
      return {
        status: 'indeterminate',
        detail: `ratchet: writing baseline '${relPath}' failed — ${(err as Error).message}`,
      };
    }
    return { status: 'ok', value: { path: relPath, value: reading.value, previous, lifecycle } };
  };
}

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
  /** Readable but unparseable content — never deleted, never conflated with I/O faults. */
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
  const baselinesDir = join(input.ws, 'baselines');
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
      error: `could not scan '${baselinesDir}' — ${(err as Error).message}`,
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
    if (liveKeys.has(baselineRelPath(parsed.target, parsed.metric))) {
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
