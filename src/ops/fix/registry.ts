import { z } from 'zod';
import type { OpRegistryEntry } from '../../kernel/types.js';
import { PlanSweepSelectorSchema } from '../sweep/registry.js';
import type { FixRunInput } from './runFix.js';
// Shared validation protocol companions: './validate.js', './escalation.js',
// './attemptRecord.js' (ADR-0008 T12 sanitizer and attempt normalizer; not a registered op),
// './report.js' (fix-run report accounting helpers over the run's results),
// './measurement.js' (ADR-0008 T34 run metric helper; not a registered op —
// pure functions over the fix-run report, referenced here to keep the
// family's registry coverage explicit), './correlation.js' (ADR-0008 T05
// run-correlation helper; not a registered op — pure allocation/adoption
// over the correlation record, referenced here to keep the family's
// registry coverage explicit). './reportFold.js' (ADR-0008 T36 report-v2
// fold; not a registered op — read-only assembly over the composition
// observation stream, referenced here to keep the family's registry
// coverage explicit).
const SweepInstallSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    timeoutMs: z.number().int().min(1).exactOptional(),
  })
  .strict();
export const FixRunInputSchema = z
  .object({
    repoRoot: z.string().min(1),
    source: z.enum(['tests', 'static']),
    checks: z
      .union([
        z.enum(['tsc', 'eslint', 'vitest']),
        z.array(z.enum(['tsc', 'eslint', 'vitest'])).min(1),
      ])
      .exactOptional(),
    selector: PlanSweepSelectorSchema,
    push: z.boolean().default(false),
    pushFailed: z.boolean().default(false),
    pr: z.boolean().default(false),
    proposeOnly: z.boolean().default(false),
    protectTests: z.boolean().default(false),
    concurrency: z.number().int().positive().default(1),
    runPrefix: z.string().min(1).exactOptional(),
    base: z.string().min(1).exactOptional(),
    install: SweepInstallSchema.exactOptional(),
    journalDir: z.string().min(1).exactOptional(),
    maxTokens: z.number().int().positive().exactOptional(),
  })
  .strict();
export const registry: OpRegistryEntry[] = [
  {
    name: 'fix.run',
    inputSchema: FixRunInputSchema,
    importer: async (wiring) => {
      const { makeFixRun } = await import('./runFix.js');
      const { createDriverFactory } = await import('../../driver/factory.js');
      const drivers = createDriverFactory({
        ...(wiring?.onDeprecatedAlias !== undefined
          ? { onDeprecatedAlias: wiring.onDeprecatedAlias }
          : {}),
        ...(wiring?.cqEnv !== undefined ? { cqEnv: wiring.cqEnv } : {}),
      });
      return async (raw) =>
        makeFixRun({
          drivers,
          // The dispatch wiring's snapshot wins when supplied (a direct
          // importer call with explicit wiring outside a run); inside a run
          // the wiring IS the run snapshot. Absent, the composition resolves
          // the enclosing run snapshot at entry.
          ...(wiring?.cqEnv !== undefined ? { cqEnv: wiring.cqEnv } : {}),
        })(raw as FixRunInput);
    },
  },
];
