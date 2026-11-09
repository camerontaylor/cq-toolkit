// Committed run manifest — T1.2 (plans-as-data, serializable, stable ids).
//
// A manifest is the run's contract with reality: the plan's jobs flattened
// into plain, JSON-serializable rows, each carrying a content hash over
// {op, input}. The hash is what makes replay/resume honest — a job-finished
// journal event (src/kernel/types.ts) records the same `inputsHash`, so a
// resumed run can prove a journaled outcome belongs to the exact op input it
// is about to skip.
//
// Plain-data invariant: RunManifest/ManifestJob hold no functions and no
// references into the source plan (dependsOn is copied and normalized), so
// JSON round-trips are lossless by construction.
//
// Hash canonicalization: key order in input objects must not change the
// hash, so hashing goes through `canonicalJson`, which recursively sorts
// object keys (code-unit order — locale-independent and stable across
// runtimes). Array order is significant and preserved: `[1,2]` and `[2,1]`
// hash differently, as they should.
import { createHash } from 'node:crypto';
import type { Plan } from './types.js';

/** One job of a committed run manifest: plan data plus its content hash. */
export interface ManifestJob {
  id: string;
  op: string;
  input: unknown;
  /** sha256 over canonicalJson({op, input}) — see {@link hashInputs}. */
  inputsHash: string;
  /** Normalized: always present (empty when the plan job had no dependsOn). */
  dependsOn: string[];
}

/** The committed, serializable form of a plan for one run. */
export interface RunManifest {
  planId: string;
  jobs: ManifestJob[];
}

/**
 * Canonical JSON serialization of a JSON-serializable value: object keys are
 * recursively sorted in code-unit order; arrays keep their order; `undefined`
 * object values are dropped (matching JSON.stringify semantics) and serialize
 * as `null` in arrays. Defined over plain JSON data only — Dates, Maps, and
 * other exotic objects are outside the op-input contract.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify returns `undefined` for undefined/function — normalize to null.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    // Index-based, not value.map: map skips sparse-array holes, so
    // `new Array(1)` would hash like `[]`. A hole reads as undefined, which
    // canonicalizes to `null` (the documented array form) — the hash then
    // distinguishes `[null]` from `[]`.
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) parts.push(canonicalJson(value[i]));
    return `[${parts.join(',')}]`;
  }
  const entries = Object.entries(value)
    // Drop explicit-undefined values so {a: 1, b: undefined} hashes like {a: 1}.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Content hash for one job dispatch: sha256 over the canonical JSON of
 * `{op, input}` (the wrapper keys sort under canonicalization, so only the
 * content matters). Shared by the manifest builder and the runner, so a
 * journal's `job-finished.inputsHash` is comparable to the manifest's
 * `ManifestJob.inputsHash` byte for byte.
 */
export function hashInputs(op: string, input: unknown): string {
  return createHash('sha256').update(canonicalJson({ input, op })).digest('hex');
}

/**
 * Snapshot and validate each input member in one traversal, naming the
 * job that owns invalid input. A non-finite number (`1e400` parses to
 * `Infinity`) survives the `structuredClone` snapshot but hashes as `null`,
 * so a resume could reuse a result for a different input; non-plain objects
 * (Date, Map, class instances) are outside the op-input contract and would
 * hash by their enumerable members alone. `undefined` object values (dropped)
 * and sparse-array holes (read as `undefined`) stay allowed — both are
 * documented canonical forms.
 */
function snapshotHashableInput(
  jobId: string,
  value: unknown,
  path = 'input',
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (value === null) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`manifest: job '${jobId}' ${path} is a non-finite number (${String(value)})`);
    }
    return value;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const snapshot: unknown[] = new Array(value.length);
    seen.set(value, snapshot);
    for (const [key, member] of Object.entries(value)) {
      Object.defineProperty(snapshot, key, {
        value: snapshotHashableInput(jobId, member, `${path}[${key}]`, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return snapshot;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`manifest: job '${jobId}' ${path} is not plain JSON data`);
  }
  const snapshot: Record<string, unknown> = {};
  seen.set(value, snapshot);
  for (const [key, member] of Object.entries(value)) {
    Object.defineProperty(snapshot, key, {
      value: snapshotHashableInput(jobId, member, `${path}.${key}`, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return snapshot;
}

/**
 * Commit a plan to its manifest: same jobs, same order, with `dependsOn`
 * normalized to `[]` when absent and each job's `inputsHash` computed over
 * its {op, input}. The manifest never aliases plan-owned data — `dependsOn`
 * is copied AND `input` is deep-copied (inputs are contractually plain JSON,
 * so a structuredClone snapshot is lossless) — meaning a committed run cannot
 * be changed by mutating the plan afterwards, and the hash committed at
 * manifest time stays the hash of the input that will be dispatched. Inputs
 * the canonical hash cannot represent losslessly are rejected here (see
 * {@link snapshotHashableInput}).
 *
 * Input prototypes are validated while each member is read once into a
 * snapshot. The committed `input` and `inputsHash` use that same snapshot —
 * never the
 * plan-owned object again. Otherwise an accessor could answer differently on
 * each read, so the validated data, the stored input, and the hash could
 * disagree.
 */
export function makeManifest(plan: Plan): RunManifest {
  return {
    planId: plan.id,
    jobs: plan.jobs.map((job) => {
      const input: unknown = structuredClone(snapshotHashableInput(job.id, job.input));
      return {
        id: job.id,
        op: job.op,
        input,
        inputsHash: hashInputs(job.op, input),
        dependsOn: [...(job.dependsOn ?? [])],
      };
    }),
  };
}

/**
 * Topological order of jobs as waves: waves[i] holds the job ids whose
 * dependencies are all settled by waves[0..i-1]. Within a wave, input order
 * is preserved (the runner executes waves through its concurrency pool).
 *
 * Throws a clear Error when a job depends on an id that does not exist, on a
 * duplicate job id, or when the dependency graph has a cycle (including a
 * self-dependency).
 *
 * Structural parameter: accepts anything with `{id, dependsOn?}` — both
 * `Job[]` and `ManifestJob[]` fit.
 */
export function topoOrder(
  jobs: ReadonlyArray<{ id: string; dependsOn?: readonly string[] }>,
): string[][] {
  const byId = new Map<string, readonly string[]>();
  for (const job of jobs) {
    if (byId.has(job.id)) {
      throw new Error(`topoOrder: duplicate job id '${job.id}'`);
    }
    byId.set(job.id, job.dependsOn ?? []);
  }
  for (const [id, deps] of byId) {
    for (const dep of deps) {
      if (!byId.has(dep)) {
        throw new Error(`topoOrder: job '${id}' depends on unknown job '${dep}'`);
      }
    }
  }

  const waves: string[][] = [];
  const settled = new Set<string>();
  let pending = [...byId.entries()];
  while (pending.length > 0) {
    const wave: string[] = [];
    for (const [id, deps] of pending) {
      if (deps.every((dep) => settled.has(dep))) {
        wave.push(id);
      }
    }
    if (wave.length === 0) {
      const stuck = pending.map(([id]) => id).join(', ');
      throw new Error(`topoOrder: dependency cycle among jobs: ${stuck}`);
    }
    const waveIds = new Set(wave);
    pending = pending.filter(([id]) => !waveIds.has(id));
    for (const id of wave) settled.add(id);
    waves.push(wave);
  }
  return waves;
}
