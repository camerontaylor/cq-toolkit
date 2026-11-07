// provenanceConfig — the resolved env config as recorded in run-start
// provenance (config contract C5; ADR-0008 `provenance.config?`).
//
// Only names whose source is 'env' are recorded (defaults are not journalled).
// Secret values (registry `secret: true`, by suffix) become the literal 'set';
// the listed foreign secret names are recorded as 'set' when present. Identity
// names are excluded: the correlation record already carries them. Warnings
// are recorded as message text (never a value).
import type { ProvenanceConfig } from '../kernel/types.js';
import type { CqEnv } from './env.js';
import { CQ_ENV_ENTRIES, FOREIGN_ENV_ENTRIES } from './env-registry.js';

export function provenanceConfig(
  cqEnv: CqEnv,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProvenanceConfig {
  const envValues: Record<string, unknown> = {};
  const sources: Record<string, 'env'> = {};
  for (const entry of CQ_ENV_ENTRIES) {
    if (entry.kind === 'identity' || entry.status !== 'live') continue;
    if (cqEnv.sources[entry.name] !== 'env') continue;
    envValues[entry.name] = entry.secret ? 'set' : cqEnv.values[entry.name];
    sources[entry.name] = 'env';
  }
  for (const foreign of FOREIGN_ENV_ENTRIES) {
    if (!foreign.secret) continue;
    const raw = env[foreign.name];
    if (raw === undefined || raw.trim() === '') continue;
    envValues[foreign.name] = 'set';
    sources[foreign.name] = 'env';
  }
  return {
    env: envValues as ProvenanceConfig['env'],
    sources,
    warnings: cqEnv.warnings.map((w) => w.message),
  };
}
