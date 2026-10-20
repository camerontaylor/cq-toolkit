// Analyze lane — the `cq.json` project config (Lane C, S1/S2): the one file
// `analyze.init` writes and `analyze.run` reads when the caller passes no
// checks. PURE module (zod + types + the gates family's pure input schema),
// so the analyze registry may import it eagerly for its input mirrors.
//
// Shape, version 1:
//   { "schemaVersion": 1,
//     "checks": [ { "adapter": "tsc-lines",
//                   "command": { "command": "node_modules/.bin/tsc",
//                                "args": ["--noEmit", "--pretty", "false"],
//                                "cwd": "." } } ] }
// Each check is exactly a `gates.checkRunner` input. Relative `cwd` values
// resolve against the config's project directory; a relative `command` that
// contains a path separator resolves against the check's cwd.
import { z } from 'zod';
import type { CheckRunnerInput } from '../gates/checkRunner.js';
import { CheckRunnerInputSchema } from '../gates/registry.js';

/** The config file name `analyze.init` writes and `analyze.run` reads. */
export const CQ_CONFIG_FILE = 'cq.json';

/** The only config schema version this toolkit reads or writes. */
export const CQ_CONFIG_SCHEMA_VERSION = 1;

/** The `cq.json` project config. */
export interface CqConfig {
  schemaVersion: typeof CQ_CONFIG_SCHEMA_VERSION;
  /** The checks `analyze.run` executes, in order. At least one. */
  checks: CheckRunnerInput[];
}

/** The strict zod form of {@link CqConfig}: unknown keys fail loudly. */
export const CqConfigSchema: z.ZodType<CqConfig> = z
  .object({
    schemaVersion: z.literal(CQ_CONFIG_SCHEMA_VERSION),
    checks: z.array(CheckRunnerInputSchema).min(1),
  })
  .strict();

/**
 * Parse `cq.json` text. Returns the config, or a one-line reason naming the
 * defect (invalid JSON, or the first schema issues) — never throws.
 */
export function parseCqConfig(
  text: string,
): { ok: true; config: CqConfig } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const parsed = CqConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: `does not match the cq.json schema (${issues})` };
  }
  return { ok: true, config: parsed.data };
}
