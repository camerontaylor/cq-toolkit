// readCqEnv — resolve the toolkit's `CQ_*` environment once into a deeply
// frozen snapshot (config contract C2; "names warn, values fail").
//
//   - Blank (unset, empty or whitespace) means unset.
//   - A known name with an invalid value is an error; every error is
//     collected, never only the first.
//   - An unknown `CQ_*` name is a warning with the nearest known name.
//   - A reserved name that is set is a warning ("set but not honoured yet").
//   - A denied name (a registry entry with status 'denied', or any name with a
//     denied prefix such as `CQ_APPROVAL_KEY*`) is an error, even when blank:
//     the denial is a name rule, so an exported-but-empty denied name fails too.
//   - Secret values stay in `values` for use but never appear in diagnostics.
//
// Entry points call it once through src/config/entry.ts.
import {
  isUrlEnvName,
  redactUrlUserinfo,
  showUrl,
  stripCredentialText,
} from '../shared/urlRedact.js';
import { nearestKey } from '../shared/nearest.js';
import { deepFreeze } from '../shared/deepFreeze.js';
import {
  CQ_ENV_REGISTRY,
  FOREIGN_ENV_ENTRIES,
  type CqEnvEntry,
  type CqEnvRegistry,
} from './env-registry.js';

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
  /**
   * Every `CQ_*` name the environment carries with a non-undefined value, blank
   * ones included (sorted). Lets a caller ask whether a knob was EXPRESSED at
   * all, which `values`/`sources` cannot say once blank means unset.
   */
  readonly present: readonly string[];
  /**
   * Registered foreign secret names (vendor/forge keys and tokens) the environment carries with a
   * non-blank value (sorted). Presence only, never a value; resolved once with the rest.
   */
  readonly foreignSecretsPresent: readonly string[];
  /**
   * Registered non-secret foreign URL names that are set, with the value already
   * passed through the one shared redactor (userinfo, query, fragment stripped).
   * The raw value never enters the snapshot.
   */
  readonly foreignUrls: Readonly<Record<string, string>>;
  readonly warnings: readonly CqEnvDiagnostic[];
  readonly errors: readonly CqEnvDiagnostic[];
}

/**
 * The nearest live or reserved name, or undefined. Measured on the part after
 * `CQ_`, with the length-scaled cap of the cq.json helper (`nearestKey`).
 */
function nearestName(name: string, entries: readonly CqEnvEntry[]): string | undefined {
  const stem = (n: string): string => (n.startsWith('CQ_') ? n.slice(3) : n);
  const candidates = entries.filter((e) => e.status !== 'denied').map((e) => stem(e.name));
  const near = nearestKey(stem(name), candidates);
  return near === undefined ? undefined : `CQ_${near}`;
}

const isBlank = (raw: string | undefined): boolean => raw === undefined || raw.trim() === '';

export function readCqEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  registry: CqEnvRegistry = CQ_ENV_REGISTRY,
): CqEnv {
  const values: Record<string, unknown> = {};
  const sources: Record<string, CqEnvSource> = {};
  const warnings: CqEnvDiagnostic[] = [];
  const errors: CqEnvDiagnostic[] = [];
  const present: string[] = [];
  const known = new Map(registry.entries.map((e) => [e.name, e]));

  for (const entry of registry.entries) {
    if (entry.status !== 'live') continue;
    values[entry.name] = undefined;
    sources[entry.name] = 'default';
  }

  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith('CQ_')) continue;
    const raw = env[name];
    if (raw === undefined) continue;
    present.push(name);
    const entry = known.get(name);
    const denied = registry.denied.find((d) => name.startsWith(d.prefix));
    if (denied !== undefined || entry?.status === 'denied') {
      errors.push({
        name,
        message: `${name} is not accepted from the environment: ${denied?.description ?? entry?.description ?? 'denied'}`,
      });
      continue;
    }
    if (isBlank(raw)) continue;
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
      // A parser message may quote a URL value: show it through the one redactor.
      errors.push({ name, message: `${name}: ${stripCredentialText(redactUrlUserinfo(detail))}` });
    }
  }

  const foreignSecretsPresent = FOREIGN_ENV_ENTRIES.filter((f) => f.secret && !isBlank(env[f.name]))
    .map((f) => f.name)
    .sort();

  const foreignUrls: Record<string, string> = {};
  for (const f of FOREIGN_ENV_ENTRIES) {
    const raw = env[f.name];
    if (f.secret || !isUrlEnvName(f.name) || raw === undefined || isBlank(raw)) continue;
    foreignUrls[f.name] = showUrl(raw);
  }

  return deepFreeze({
    values,
    sources,
    present,
    foreignSecretsPresent,
    foreignUrls,
    warnings,
    errors,
  });
}

/** `cq: warning: …` / `cq: error: …` lines, errors first; never contains a value. */
export function formatCqEnvDiagnostics(env: Pick<CqEnv, 'warnings' | 'errors'>): string[] {
  const flat = (text: string): string => text.replace(/\r\n|\r|\n/g, '\\n');
  return [
    ...env.errors.map((d) => `cq: error: ${flat(d.message)}`),
    ...env.warnings.map((d) => `cq: warning: ${flat(d.message)}`),
  ];
}
