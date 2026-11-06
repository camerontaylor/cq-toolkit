// config.show — print what the toolkit's CQ_* environment resolves to.
//
// Read-only: resolves `readCqEnv(process.env)` and reports each live key with
// its value (`set` for secrets) and source layer, then the warnings. Errors
// fail the op; `strict` also fails on warnings. The CLI maps `failed` to
// exit 1 (an op result cannot carry exit 2; slice C3 wires the dedicated
// entry-point handling).
import {
  readCqEnv,
  formatCqEnvDiagnostics,
  type CqEnvDiagnostic,
  type CqEnvSource,
} from '../../config/env.js';
import { CQ_ENV_ENTRIES } from '../../config/env-registry.js';
import type { Op } from '../../kernel/types.js';

export interface ConfigShowInput {
  /** Fail (not just report) when there are warnings. */
  strict?: boolean;
}

export interface ConfigShowKey {
  name: string;
  /** `null` when unset; the string `set` for a secret; otherwise the parsed value. */
  value: unknown;
  source: CqEnvSource;
}

export interface ConfigShowReport {
  keys: ConfigShowKey[];
  warnings: CqEnvDiagnostic[];
  errors: CqEnvDiagnostic[];
}

/** Build the report from an environment (exported for tests). */
export function buildConfigShowReport(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigShowReport {
  const snapshot = readCqEnv(env);
  const keys = CQ_ENV_ENTRIES.filter((e) => e.status === 'live').map((e) => {
    const value = snapshot.values[e.name];
    return {
      name: e.name,
      value: value === undefined ? null : e.secret ? 'set' : value,
      source: snapshot.sources[e.name] ?? 'default',
    };
  });
  return { keys, warnings: [...snapshot.warnings], errors: [...snapshot.errors] };
}

const configShow: Op<ConfigShowInput, ConfigShowReport> = async (input) => {
  const report = buildConfigShowReport();
  const lines = formatCqEnvDiagnostics(report);
  if (report.errors.length > 0 || (input.strict === true && report.warnings.length > 0)) {
    return { status: 'failed', error: lines.join('\n') };
  }
  return { status: 'ok', value: report };
};

export default configShow;
