// cq.json v2: pure schema shared by config readers and op input mirrors.
// Commands are argv, never shell text; review this file like package.json scripts.
import { z } from 'zod';
import type { CheckRunnerInput } from '../gates/checkRunner.js';
import { CheckRunnerInputObject } from '../gates/registry.js';

export const CQ_CONFIG_FILE = 'cq.json';
export const CQ_CONFIG_SCHEMA_VERSION = 2;

/** Runaway wall guard shared by review.run and review.address. */
export const DEFAULT_REVIEW_WALL_MS = 6 * 60 * 60 * 1000;

const PositiveInteger = z.number().int().positive();
const NonNegativeInteger = z.number().int().nonnegative();
const SeveritySchema = z.enum(['critical', 'major', 'minor', 'trivial', 'info', 'none']);
const RoleSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict();

/** Documented review-session bounds; resolution fills omitted config fields. */
export const REVIEW_SESSION_DEFAULTS = {
  maxInputChars: 60_000,
  maxSteps: 15,
  /** Independent partition sessions in flight at once. */
  concurrency: 4,
} as const;

/** Documented size tiers; a medium threshold may equal its small counterpart, never undercut it. */
export const REVIEW_SIZE_DEFAULTS = {
  small: { maxChangedLines: 200, maxFiles: 5 },
  medium: { maxChangedLines: 800, maxFiles: 20 },
} as const;

const ReviewSizeTierSchema = z
  .object({
    maxChangedLines: NonNegativeInteger.exactOptional(),
    maxFiles: NonNegativeInteger.exactOptional(),
  })
  .strict();

// An omitted tier or field takes its documented default, so a partial override cannot
// silently invert the tiers (for example a low medium beside the default small threshold).
const ReviewSizeSchema = z
  .object({
    small: ReviewSizeTierSchema.exactOptional(),
    medium: ReviewSizeTierSchema.exactOptional(),
  })
  .strict()
  .superRefine((size, ctx) => {
    const small = { ...REVIEW_SIZE_DEFAULTS.small, ...size.small };
    const medium = { ...REVIEW_SIZE_DEFAULTS.medium, ...size.medium };
    for (const key of ['maxChangedLines', 'maxFiles'] as const) {
      if (medium[key] < small[key]) {
        ctx.addIssue({
          code: 'custom',
          path: ['medium', key],
          message: `must not be less than the effective small tier (${small[key]})`,
        });
      }
    }
  });

const ReviewExclusionSchema = z
  .object({ pattern: z.string().min(1), assuredBy: z.string().min(1).exactOptional() })
  .strict();

const ReviewReReviewSchema = z
  .object({ includePriorFindings: z.boolean().exactOptional() })
  .strict();

/** Config-only metadata is removed before dispatch to gates.checkRunner. */
export const CqCheckSchema = CheckRunnerInputObject.extend({
  kind: z.enum(['tests', 'static']).exactOptional(),
  // Requires review.address's explicit finding-file scope; repository consumers skip it.
  addressOnly: z.boolean().exactOptional(),
  // Each standalone {files} token expands to separate argv entries, not shell text.
  relatedArgs: z.array(z.string()).exactOptional(),
});

export const CqConfigSchema = z
  .object({
    schemaVersion: z.literal(CQ_CONFIG_SCHEMA_VERSION),
    checks: z.array(CqCheckSchema).min(1),
    harness: z.object({ logToolFailures: z.boolean().exactOptional() }).strict().exactOptional(),
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
        searchTools: z.boolean().exactOptional(),
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
        session: z
          .object({
            maxInputChars: PositiveInteger.exactOptional(),
            maxSteps: PositiveInteger.exactOptional(),
            stepCountdown: z.boolean().exactOptional(),
            concurrency: PositiveInteger.exactOptional(),
          })
          .strict()
          .exactOptional(),
        size: ReviewSizeSchema.exactOptional(),
        exclude: z.array(ReviewExclusionSchema).exactOptional(),
        reReview: ReviewReReviewSchema.exactOptional(),
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
  Pick<z.input<typeof CqCheckSchema>, 'kind' | 'relatedArgs' | 'addressOnly'>;
export type CqSeverity = z.output<typeof SeveritySchema>;

interface SchemaNode {
  _zod?: {
    def?: {
      type?: string;
      shape?: Record<string, SchemaNode>;
      element?: SchemaNode;
      innerType?: SchemaNode;
      in?: SchemaNode;
    };
  };
}

/** Peel optional/default/pipe wrappers; zod 4 keeps refinements on the same node. */
function unwrapSchema(node: SchemaNode | undefined): SchemaNode | undefined {
  let current = node;
  for (let depth = 0; depth < 16 && current?._zod?.def; depth++) {
    const def = current._zod.def;
    const next = def.innerType ?? (def.type === 'pipe' ? def.in : undefined);
    if (!next) return current;
    current = next;
  }
  return current;
}

/** Valid keys of the strict object at `path`, or [] when the path cannot be resolved. */
function validKeysAt(path: readonly PropertyKey[]): string[] {
  let node = unwrapSchema(CqConfigSchema as unknown as SchemaNode);
  for (const segment of path) {
    const def = node?._zod?.def;
    if (def?.type === 'array' && typeof segment === 'number') node = unwrapSchema(def.element);
    else if (def?.type === 'object' && typeof segment === 'string')
      node = unwrapSchema(def.shape?.[segment]);
    else return [];
  }
  const def = node?._zod?.def;
  return def?.type === 'object' && def.shape ? Object.keys(def.shape) : [];
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
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

const MAX_SUGGESTION_DISTANCE = 3;

function nearestKey(unknown: string, valid: readonly string[]): string | undefined {
  let best: string | undefined;
  // Short names tolerate fewer edits, otherwise "x" would match any 3-letter key.
  const limit = Math.min(MAX_SUGGESTION_DISTANCE, Math.max(1, Math.floor(unknown.length / 2)));
  let bestDistance = limit + 1;
  for (const candidate of valid) {
    const distance = editDistance(unknown.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.join('.') || '(root)';
  if (issue.code !== 'unrecognized_keys') return `${where}: ${issue.message}`;
  const valid = validKeysAt(issue.path);
  const parts = issue.keys.map((key) => {
    const near = nearestKey(key, valid);
    return near ? `"${key}" (did you mean \`${near}\`?)` : `"${key}"`;
  });
  return `${where}: unrecognized key${parts.length === 1 ? '' : 's'} ${parts.join(', ')}`;
}

/** Every issue is reported: cq.json is small and a capped list forces repeated fix-and-rerun. */
function schemaReason(error: z.ZodError): string {
  const issues = error.issues.map(describeIssue).join('; ');
  return `does not match the cq.json schema (${issues})`.replace(/\s+/g, ' ');
}

/** Parse without migration or filesystem effects; unknown keys fail at every level. */
export function parseCqConfig(
  text: string,
  dir = '.',
  configPath?: string,
): { ok: true; config: CqConfig } | { ok: false; reason: string; migrationRequired?: true } {
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
      migrationRequired: true,
      reason: `cq.json schemaVersion 1 is unsupported; run \`cq analyze.init --migrate --dir='${dir.replace(/'/g, "'\\''")}'${configPath === undefined ? '' : ` --configPath='${configPath.replace(/'/g, "'\\''")}'`}\` to upgrade to schemaVersion 2`,
    };
  }
  const parsed = CqConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: schemaReason(parsed.error) };
  return { ok: true, config: parsed.data };
}

/** Validate and preserve raw JSON without injecting defaults; v2 is already migrated. */
export function migrateCqConfig(
  text: string,
): { ok: true; config: CqConfig; changed: boolean } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (CqConfigSchema.safeParse(raw).success) {
    return { ok: true, config: raw as CqConfig, changed: false };
  }
  const legacy = z
    .object({ schemaVersion: z.literal(1), checks: z.array(CheckRunnerInputObject).min(1) })
    .strict()
    .safeParse(raw);
  if (!legacy.success) return { ok: false, reason: schemaReason(legacy.error) };
  // Use the raw checks: parsing adds timeoutMs, which migration must not invent.
  const original = raw as { schemaVersion: 1; checks: CqCheck[] };
  const config: CqConfig = { ...original, schemaVersion: CQ_CONFIG_SCHEMA_VERSION };
  const validated = CqConfigSchema.safeParse(config);
  if (!validated.success) return { ok: false, reason: schemaReason(validated.error) };
  return { ok: true, config, changed: true };
}
