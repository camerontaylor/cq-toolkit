// Ratchet family OP registry — phase-4 T4.2 closure.
//
// The family's `registry.ts` was the interim metric-ADAPTER registry (lane H
// slice 1); that moved to `./metricRegistry.ts` so this module can carry the
// central scanner's conventional `export const registry: OpRegistryEntry[]`
// and every ratchet op gets a CLI subcommand (`ratchet.captureBaseline`,
// `ratchet.checkRatchet`, `ratchet.monotonicGuard`,
// `ratchet.proposeBaselineUpdate`).
//
// LAZY RULE (the family convention): module scope imports only zod, node
// builtins, type-only imports, and the two deliberate helper re-exports at
// the bottom (the sweep registry's GitMutexConfig precedent) — loading this
// registry never loads an op module. Every op is reached through its entry's
// dynamic importer at dispatch.
//
// THE METRIC RUNNER IS BOUND AT IMPORTER TIME (the CODEX-P1 seam, kept): the
// op inputs carry only ids/plain JSON, so a capture/check input carries a
// {@link MetricSourceSpec} and the importer binds lane C's CheckRunner
// (`subprocessRunCheck`) through `./sources.js` at dispatch. The metric
// adapter registry itself still imports nothing from src/gates.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import type { CaptureBaselineOutcome } from './captureBaseline.js';
import type { CheckRatchetOutcome } from './checkRatchet.js';
import type { DiffVerdict } from './monotonicGuard.js';
// The op module's declared Propose* types pin the mirror at compile time.
import type { ProposeInput, ProposeOutcome } from './proposeBaselineUpdate.js';

/**
 * Registry-time description of how to obtain the raw data one metric adapter
 * parses. A discriminated union, all plain JSON (functions cannot survive
 * the kernel's structuredClone, so the runner is never carried here — see
 * ./sources.js):
 *   - `command` — run through lane C's CheckRunner; `parse` picks the raw
 *     shape the adapter reads (`text`, `json`, or `tsc-text` for the tsc
 *     evidence classification).
 *   - `file` — read a path (absolute or workspace-relative) and parse it.
 *   - `raw` — the raw value verbatim.
 */
export const MetricSourceSpecSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('command'),
      command: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().min(1).exactOptional(),
      timeoutMs: z.number().int().positive().exactOptional(),
      parse: z.enum(['text', 'json', 'tsc-text']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      path: z.string().min(1),
      parse: z.enum(['text', 'json']),
    })
    .strict(),
  z.object({ kind: z.literal('raw'), raw: z.unknown() }).strict(),
]);

/** The `ratchet.checkRatchet` registry input (op input + a JSON source spec). */
export const CheckRatchetCommandInputSchema = z
  .object({
    ws: z.string().min(1),
    target: z.string().min(1),
    metric: z.string().min(1),
    source: MetricSourceSpecSchema,
  })
  .strict();

/** The `ratchet.captureBaseline` registry input (the check shape + an optional pinned clock). */
export const CaptureBaselineCommandInputSchema = z
  .object({
    ws: z.string().min(1),
    target: z.string().min(1),
    metric: z.string().min(1),
    source: MetricSourceSpecSchema,
    capturedAt: z.string().min(1).exactOptional(),
  })
  .strict();

/**
 * The `ratchet.monotonicGuard` registry input: exactly one of an inline diff
 * or a path to one (the workflow writes `git diff` to a file to keep the diff
 * out of argv). Strict + refined, so a typo'd key or a doubled source fails
 * at the CLI arg boundary (exit 2), never silently.
 */
export const MonotonicGuardCommandInputSchema = z
  .object({
    diff: z.string().exactOptional(),
    diffPath: z.string().min(1).exactOptional(),
  })
  .strict()
  .refine((input) => (input.diff !== undefined) !== (input.diffPath !== undefined), {
    message: 'provide exactly one of diff or diffPath',
  });

/** The `ratchet.proposeBaselineUpdate` registry input (the op's own JSON input). */
export const ProposeBaselineUpdateCommandInputSchema: z.ZodType<ProposeInput> = z
  .object({
    ws: z.string().min(1),
    base: z.string().min(1),
    headPrefix: z.string().min(1).exactOptional(),
    improvements: z.array(
      z
        .object({
          target: z.string().min(1),
          metric: z.string().min(1),
          value: z.number(),
          capturedAt: z.string().min(1).exactOptional(),
        })
        .strict(),
    ),
  })
  .strict();

type CheckRatchetCommandInput = z.infer<typeof CheckRatchetCommandInputSchema>;
type CaptureBaselineCommandInput = z.infer<typeof CaptureBaselineCommandInputSchema>;
type MonotonicGuardCommandInput = z.infer<typeof MonotonicGuardCommandInputSchema>;

/** Ratchet-family op registry (the four H1–H3 ops; the metric adapters are not ops). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'ratchet.checkRatchet',
    inputSchema: CheckRatchetCommandInputSchema,
    // Lane C's CheckRunner is bound per dispatch from the input's source spec
    // (CODEX P1: the runner never travels in the op input). The dispatch seam
    // re-validates input through inputSchema.parseAsync, so the erased op
    // typing is safe here.
    importer: () =>
      Promise.all([
        import('./checkRatchet.js'),
        import('./sources.js'),
        import('../gates/checkRunner.js'),
      ]).then(([m, sources, runner]) => {
        const op: Op<CheckRatchetCommandInput, CheckRatchetOutcome> = async (input) =>
          m.createCheckRatchet(
            new Map([
              [input.metric, sources.makeMetricSource(runner.subprocessRunCheck, input.source)],
            ]),
          )({
            ws: input.ws,
            target: input.target,
            metric: input.metric,
            sourceId: input.metric,
          });
        return op as Op<unknown, unknown>;
      }),
  },
  {
    name: 'ratchet.captureBaseline',
    inputSchema: CaptureBaselineCommandInputSchema,
    // Same seam: the subprocess CheckRunner is bound per dispatch, and the
    // catalog key is the metric id (the source runs once, for this metric).
    importer: () =>
      Promise.all([
        import('./captureBaseline.js'),
        import('./sources.js'),
        import('../gates/checkRunner.js'),
      ]).then(([m, sources, runner]) => {
        const op: Op<CaptureBaselineCommandInput, CaptureBaselineOutcome> = async (input) =>
          m.createCaptureBaseline(
            new Map([
              [input.metric, sources.makeMetricSource(runner.subprocessRunCheck, input.source)],
            ]),
          )({
            ws: input.ws,
            target: input.target,
            metric: input.metric,
            sourceId: input.metric,
            ...(input.capturedAt !== undefined ? { capturedAt: input.capturedAt } : {}),
          });
        return op as Op<unknown, unknown>;
      }),
  },
  {
    name: 'ratchet.monotonicGuard',
    inputSchema: MonotonicGuardCommandInputSchema,
    // Pure guard; the only I/O is reading a diff FILE when the caller hands a
    // path (keeping a large diff out of argv). An unreadable file is an
    // honest `failed`, never a fabricated pass.
    importer: () =>
      import('./monotonicGuard.js').then((m) => {
        const op: Op<MonotonicGuardCommandInput, DiffVerdict> = async (input) => {
          let diff: string;
          if (input.diff !== undefined) {
            diff = input.diff;
          } else {
            const diffPath = input.diffPath;
            if (diffPath === undefined) {
              return { status: 'failed', error: 'ratchet: no diff or diffPath supplied' };
            }
            try {
              diff = await readFile(resolve(diffPath), 'utf8');
            } catch (err) {
              return {
                status: 'failed',
                error:
                  `ratchet: could not read diff '${diffPath}' — ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
          return { status: 'ok', value: m.checkDiffMonotonicity(diff) };
        };
        return op as Op<unknown, unknown>;
      }),
  },
  {
    name: 'ratchet.proposeBaselineUpdate',
    inputSchema: ProposeBaselineUpdateCommandInputSchema,
    // The gh/git effects seam is constructed per dispatch from the input's
    // plain-JSON workspace (the sweep/merge input-driven binding): nothing is
    // wired at registry module scope and construction is closure-only.
    importer: () =>
      Promise.all([import('./proposeBaselineUpdate.js'), import('./effects.js')]).then(
        ([m, effects]) => {
          const op: Op<ProposeInput, ProposeOutcome> = async (input) =>
            m.createProposeBaselineUpdate(effects.makeSubprocessBaselinePrEffects(input.ws))(input);
          return op as Op<unknown, unknown>;
        },
      ),
  },
];

// Helper-reference excusals (the sweep registry's `export type { GitMutexConfig }`
// precedent): `format.ts` and `metricRegistry.ts` are family LIBRARY modules,
// never ops — a registered op's module is routed through an entry, so these
// type-only re-exports mark them as registry-referenced without inventing a
// dead subcommand. `sources.ts`/`effects.ts` are referenced by the dynamic
// importers above.
export type { Direction } from './format.js';
export type { MetricAdapter, MetricReading, MetricSource } from './metricRegistry.js';
