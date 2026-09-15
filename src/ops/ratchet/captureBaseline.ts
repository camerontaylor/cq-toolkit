// captureBaseline + pruneBaselines — lane H slice 2.
//
// captureBaseline is a kernel Op (data-in/data-out, OpResult taxonomy): it
// records ONE (target, metric) baseline into <ws>/baselines. The metric
// RUNNER arrives injected as `input.source` (a MetricSource — lane C's
// CheckRunner gets wired in later); this module never imports from
// src/gates or src/harness.
//
// Failure direction, named (I5): a null from the source or the adapter is
// NON-PASSING EVIDENCE — the op returns `failed` naming the metric, never a
// fabricated pass and never a fabricated baseline. A corrupt EXISTING
// baseline is likewise a failure: capture never silently overwrites evidence
// it cannot classify. Capture does NOT judge tightening (that is the
// checkRatchet/guard's job in H2) — it records facts and reports the
// lifecycle trio created/updated/unchanged, rewriting an equal-value
// baseline only when the rendered bytes differ.
//
// pruneBaselines deletes baseline files whose (target, metric) is no longer
// live. Unparseable files are SKIPPED, never deleted: nothing is removed
// that cannot be classified.
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Op } from '../../kernel/types.js';
import { baselineRelPath, parseBaseline, renderBaseline } from './format.js';
import type { BaselineFile } from './format.js';
import { getAdapter } from './registry.js';
import type { MetricSource } from './registry.js';

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** Capture one (target, metric) baseline in a workspace. */
export interface CaptureBaselineInput {
  ws: string;
  target: string;
  metric: string;
  source: MetricSource;
  /** Overrides the capture clock (ISO-8601); tests pin this for determinism. */
  capturedAt?: string;
}

export interface CaptureBaselineOutcome {
  /** Repo-relative baseline path, e.g. 'baselines/typecheck--typecheck-count.json'. */
  path: string;
  value: number;
  /** The previously recorded value; null when none existed. */
  previous: number | null;
  lifecycle: 'created' | 'updated' | 'unchanged';
}

export const captureBaseline: Op<CaptureBaselineInput, CaptureBaselineOutcome> = async (
  input,
) => {
  const adapter = getAdapter(input.metric);
  if (adapter === undefined) {
    return {
      status: 'failed',
      error: `ratchet: unknown metric '${input.metric}' — no registered adapter`,
    };
  }

  let raw: unknown;
  try {
    raw = await input.source(input.ws);
  } catch (err) {
    return {
      status: 'failed',
      error: `ratchet: metric '${input.metric}' source failed — ${(err as Error).message}`,
    };
  }
  const reading = raw === null ? null : adapter.extract(raw);
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
  /** Repo-relative paths that could not be classified — left untouched. */
  skipped: string[];
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
    if (isEnoent(err)) return { deleted: [], kept: 0, skipped: [] }; // no baselines yet
    throw err;
  }

  const deleted: string[] = [];
  const skipped: string[] = [];
  let kept = 0;
  // Sorted iteration → deterministic deleted/skipped order regardless of the
  // filesystem's readdir order.
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const relPath = `baselines/${name}`;
    let parsed: BaselineFile;
    try {
      parsed = parseBaseline(await readFile(join(baselinesDir, name), 'utf8'));
    } catch {
      skipped.push(relPath); // cannot classify → never delete
      continue;
    }
    if (liveKeys.has(baselineRelPath(parsed.target, parsed.metric))) {
      kept++;
      continue;
    }
    await unlink(join(baselinesDir, name));
    deleted.push(relPath);
  }
  return { deleted, kept, skipped };
}
