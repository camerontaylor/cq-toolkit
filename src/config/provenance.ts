// provenanceConfig — the resolved env config as recorded in run-start
// provenance (config contract C5; ADR-0008 `provenance.config?`).
//
// Built from the run's validated CqEnv only; it never reads the ambient
// environment (resolve once, ADR-0009).
//
// Only names whose source is 'env' are recorded: a name that is absent means
// the built-in default applied (defaults are not journalled). Secret values
// (registry `secret: true`, by suffix) become the literal 'set'; the
// registered foreign secret names are recorded as 'set' when present.
// Identity names are excluded: the correlation record already carries them.
// Warnings are recorded as message text (never a value). Parse errors are not
// recorded: runPlan refuses a run whose env has errors (assertCqEnv).
//
// Every recorded value is a STRING, whatever the registry parser returned
// (model spec, list, number, boolean), so it always satisfies the strict
// ProvenanceConfigSchema. Non-secret values are capped at MAX_VALUE_CHARS so
// a long value cannot bloat a journal.
import type { ProvenanceConfig } from '../kernel/types.js';
import type { CqEnv } from './env.js';
import { CQ_ENV_ENTRIES } from './env-registry.js';

const MAX_VALUE_CHARS = 200;

/** A parsed value as text, in the grammar of the env value itself. */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(render).join(',');
  if (typeof value === 'object' && value !== null) {
    const spec = value as { provider?: unknown; model?: unknown };
    if (typeof spec.provider === 'string' && typeof spec.model === 'string') {
      return `${spec.provider}/${spec.model}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function cap(text: string): string {
  return text.length <= MAX_VALUE_CHARS
    ? text
    : `${text.slice(0, MAX_VALUE_CHARS)}… (${text.length} chars)`;
}

export function provenanceConfig(cqEnv: CqEnv): ProvenanceConfig {
  const env: Record<string, string> = {};
  const sources: Record<string, 'env'> = {};
  for (const entry of CQ_ENV_ENTRIES) {
    if (entry.kind === 'identity' || entry.status !== 'live') continue;
    if (cqEnv.sources[entry.name] !== 'env') continue;
    env[entry.name] = entry.secret ? 'set' : cap(render(cqEnv.values[entry.name]));
    sources[entry.name] = 'env';
  }
  for (const name of cqEnv.foreignSecretsPresent) {
    env[name] = 'set';
    sources[name] = 'env';
  }
  return { env, sources, warnings: cqEnv.warnings.map((w) => w.message) };
}
