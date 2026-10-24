import { z } from 'zod';
import type { OpRegistryEntry } from '../../kernel/types.js';
import { PlanSweepSelectorSchema } from '../sweep/registry.js';
import type { FixRunInput } from './runFix.js';
// Shared validation protocol companions: './validate.js', './escalation.js'.
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
    base: z.string().min(1).default('HEAD'),
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
      const drivers = createDriverFactory(
        wiring?.onDeprecatedAlias === undefined
          ? {}
          : { onDeprecatedAlias: wiring.onDeprecatedAlias },
      );
      return async (raw) => makeFixRun({ drivers })(raw as FixRunInput);
    },
  },
];
