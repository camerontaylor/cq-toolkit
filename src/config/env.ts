// readCqEnv — resolve the toolkit's `CQ_*` environment once into a deeply
// frozen snapshot (config contract C2; "names warn, values fail").
//
//   - Blank (unset, empty or whitespace) means unset.
//   - A known name with an invalid value is an error; every error is
//     collected, never only the first.
//   - An unknown `CQ_*` name is a warning with the nearest known name.
//   - A reserved name that is set is a warning ("set but not honoured yet").
//   - A denied name (`CQ_APPROVAL_KEY*`) is an error.
//   - Secret values stay in `values` for use but never appear in diagnostics.
//
// This slice does not wire the function into entry points; slice C3 does.
import { deepFreeze } from '../shared/deepFreeze.js';
import { CQ_ENV_REGISTRY, type CqEnvEntry, type CqEnvRegistry } from './env-registry.js';

export type CqEnvSource = 'default' | 'env';

export interface CqEnvDiagnostic {
  /** The env name concerned (never a value). */
  readonly name: string;
  readonly message: string;
}

export interface CqEnv {
  /** Parsed value per live key; `undefined` when the key is unset. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly sources: Readonly<Record<string, CqEnvSource>>;
  readonly warnings: readonly CqEnvDiagnostic[];
  readonly errors: readonly CqEnvDiagnostic[];
}

const MAX_SUGGEST_DISTANCE = 3;

/** Levenshtein distance (small inputs; no dependency). */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * The nearest live or reserved name, or undefined. Distance is measured on the
 * part after `CQ_` and capped by length (`min(3, max(1, floor(len / 2)))`) so
 * short names do not get far-fetched suggestions.
 */
function nearestName(name: string, entries: readonly CqEnvEntry[]): string | undefined {
  const stem = (n: string): string => (n.startsWith('CQ_') ? n.slice(3) : n);
  const own = stem(name);
  const limit = Math.min(MAX_SUGGEST_DISTANCE, Math.max(1, Math.floor(own.length / 2)));
  let best: { name: string; distance: number } | undefined;
  for (const candidate of entries) {
    if (candidate.status === 'denied') continue;
    const distance = editDistance(own, stem(candidate.name));
    if (distance <= limit && (best === undefined || distance < best.distance)) {
      best = { name: candidate.name, distance };
    }
  }
  return best?.name;
}

const isBlank = (raw: string | undefined): raw is undefined =>
  raw === undefined || raw.trim() === '';

export function readCqEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  registry: CqEnvRegistry = CQ_ENV_REGISTRY,
): CqEnv {
  const values: Record<string, unknown> = {};
  const sources: Record<string, CqEnvSource> = {};
  const warnings: CqEnvDiagnostic[] = [];
  const errors: CqEnvDiagnostic[] = [];
  const known = new Map(registry.entries.map((e) => [e.name, e]));

  for (const entry of registry.entries) {
    if (entry.status !== 'live') continue;
    values[entry.name] = undefined;
    sources[entry.name] = 'default';
  }

  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith('CQ_')) continue;
    const raw = env[name];
    if (isBlank(raw)) continue;
    const denied = registry.denied.find((d) => name.startsWith(d.prefix));
    if (denied !== undefined) {
      errors.push({
        name,
        message: `${name} is not accepted from the environment: ${denied.description}`,
      });
      continue;
    }
    const entry = known.get(name);
    if (entry === undefined) {
      const near = nearestName(name, registry.entries);
      warnings.push({
        name,
        message: `unknown name ${name}${near === undefined ? '' : ` (did you mean ${near}?)`}`,
      });
      continue;
    }
    if (entry.status === 'reserved') {
      warnings.push({ name, message: `${name} is set but not honoured yet` });
      continue;
    }
    try {
      values[name] = entry.parse(raw);
      sources[name] = 'env';
    } catch (err) {
      // A parser message may quote the value; never let that reach a secret.
      const detail = entry.secret
        ? 'invalid value (not shown)'
        : err instanceof Error
          ? err.message
          : String(err);
      errors.push({ name, message: `${name}: ${detail}` });
    }
  }

  return deepFreeze({ values, sources, warnings, errors });
}

/** `cq: warning: …` / `cq: error: …` lines, errors first; never contains a value. */
export function formatCqEnvDiagnostics(env: Pick<CqEnv, 'warnings' | 'errors'>): string[] {
  const flat = (text: string): string => text.replace(/\r\n|\r|\n/g, '\\n');
  return [
    ...env.errors.map((d) => `cq: error: ${flat(d.message)}`),
    ...env.warnings.map((d) => `cq: warning: ${flat(d.message)}`),
  ];
}
