// cq.json v2: pure schema shared by config readers and op input mirrors.
// Commands are argv, never shell text; review this file like package.json scripts.
import { z } from 'zod';
import type { CheckRunnerInput } from '../gates/checkRunner.js';
import { CheckRunnerInputObject } from '../gates/registry.js';

export const CQ_CONFIG_FILE = 'cq.json';
export const CQ_CONFIG_SCHEMA_VERSION = 2;

const PositiveInteger = z.number().int().positive();
const SeveritySchema = z.enum(['critical', 'major', 'minor', 'trivial', 'info', 'none']);
const RoleSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict();

/** Config-only metadata is removed before dispatch to gates.checkRunner. */
export const CqCheckSchema = CheckRunnerInputObject.extend({
  kind: z.enum(['tests', 'static']).exactOptional(),
  // Each standalone {files} token expands to separate argv entries, not shell text.
  relatedArgs: z.array(z.string()).exactOptional(),
});

export const CqConfigSchema = z
  .object({
    schemaVersion: z.literal(CQ_CONFIG_SCHEMA_VERSION),
    checks: z.array(CqCheckSchema).min(1),
    packages: z
      .array(z.object({ name: z.string().min(1), path: z.string().min(1) }).strict())
      .min(1)
      .exactOptional(),
    roles: z
      .object({
        worker: RoleSchema.exactOptional(),
        rescue: RoleSchema.exactOptional(),
        reviewer: RoleSchema.exactOptional(),
      })
      .strict()
      .exactOptional(),
    budgets: z
      .object({
        run: z
          .object({
            maxTokens: PositiveInteger.exactOptional(),
            wallMs: PositiveInteger.exactOptional(),
          })
          .strict()
          .exactOptional(),
        unit: z.object({ wallMs: PositiveInteger.exactOptional() }).strict().exactOptional(),
        step: z.object({ wallMs: PositiveInteger.exactOptional() }).strict().exactOptional(),
      })
      .strict()
      .exactOptional(),
    review: z
      .object({
        rounds: PositiveInteger.exactOptional(),
        blockingSeverities: z.array(SeveritySchema).exactOptional(),
        agentSeverityMap: z
          .object({
            high: SeveritySchema.exactOptional(),
            medium: SeveritySchema.exactOptional(),
            low: SeveritySchema.exactOptional(),
          })
          .strict()
          .exactOptional(),
        reviewers: z
          .array(z.enum(['coderabbit', 'agent']))
          .min(1)
          .exactOptional(),
        addressConcurrency: PositiveInteger.exactOptional(),
        denylistPatternsFile: z.string().min(1).exactOptional(),
        bulk: z
          .object({
            concurrency: PositiveInteger.exactOptional(),
            query: z.string().min(1).exactOptional(),
          })
          .strict()
          .exactOptional(),
      })
      .strict()
      .exactOptional(),
    escalation: z
      .object({
        workerAttempts: PositiveInteger.exactOptional(),
        rescueBase: z.number().int().nonnegative().exactOptional(),
        rescuePerFixed: PositiveInteger.exactOptional(),
        rescuePerPackageCap: z.number().int().nonnegative().exactOptional(),
      })
      .strict()
      .exactOptional(),
  })
  .strict();

/** Library callers may omit the check command's boundary timeout default. */
export type CqConfig = Omit<z.input<typeof CqConfigSchema>, 'checks'> & { checks: CqCheck[] };
export type CqCheck = CheckRunnerInput &
  Pick<z.input<typeof CqCheckSchema>, 'kind' | 'relatedArgs'>;
export type CqSeverity = z.output<typeof SeveritySchema>;

function schemaReason(error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return `does not match the cq.json schema (${issues})`.replace(/\s+/g, ' ');
}

/** Parse without migration or filesystem effects; unknown keys fail at every level. */
export function parseCqConfig(
  text: string,
): { ok: true; config: CqConfig } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: `not valid JSON (${err instanceof Error ? err.message : String(err)})`.replace(
        /\s+/g,
        ' ',
      ),
    };
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'schemaVersion' in raw &&
    raw.schemaVersion === 1
  ) {
    return {
      ok: false,
      reason:
        'cq.json schemaVersion 1 is unsupported; run `cq analyze.init --migrate` to upgrade to schemaVersion 2',
    };
  }
  const parsed = CqConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: schemaReason(parsed.error) };
  return { ok: true, config: parsed.data };
}

/** Validate the original v1 shape, then preserve its JSON data without injecting defaults. */
export function migrateCqConfig(
  text: string,
): { ok: true; config: CqConfig } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  const legacy = z
    .object({ schemaVersion: z.literal(1), checks: z.array(CheckRunnerInputObject).min(1) })
    .strict()
    .safeParse(raw);
  if (!legacy.success) return { ok: false, reason: schemaReason(legacy.error) };
  // Use the raw checks: parsing adds timeoutMs, which migration must not invent.
  const original = raw as { schemaVersion: 1; checks: CqCheck[] };
  return { ok: true, config: { ...original, schemaVersion: CQ_CONFIG_SCHEMA_VERSION } };
}
