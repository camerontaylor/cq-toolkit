// Dev family registry slice (strategy §8 lane 1) — the `dev.check`,
// `dev.review`, `dev.disposition`, and `dev.ready` op entries, typed against
// the FROZEN OpRegistryEntry (src/kernel/types.ts). THE LAZY RULE (the
// pr/merge precedent): module scope imports only zod, type-only imports, and
// the pure reviewer-name constant — loading this registry never loads an op
// module, the subprocess effects, or the denylist parser; every op is
// reached through its entry's dynamic import at dispatch. The ops parse
// their input with these schemas at their own boundary (effects.ts
// guardDevOp), so the SDK and the CLI validate identically.
//
// DRIFT PINNING: every mirror is annotated `z.ZodType<T>` against the op's
// hand-written input type (type-only import) — a schema whose output drifts
// from the type fails typecheck.
//
// EFFECTS ARE BOUND PER DISPATCH (the pr family importer precedent): each
// entry's importer dynamically imports the op module AND effects.js (and,
// for dev.review, denylist.js), binding the subprocess effects from the
// INPUT's plain-JSON repoRoot — the registry entry carries no repo state.
// The construction is inert (closure-only; a process spawns only when an
// effect is CALLED), so resolving an entry never touches env, the network,
// the host lock, or the filesystem.
//
// BUILT-IN DEFAULTS (strategy §5): the target default and the reviewer
// choice vocabulary are the built-in constants from record.js/coderabbit.js
// until the protected policy/dev-protocol.json consumer batch lands; no
// provider or model names appear here — agent reviews select a configured
// role with the explicit `agent:<role>` flag value.
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import { CODERABBIT_REVIEWER } from './coderabbit.js';
import type { DevCheckInput } from './check.js';
import type { DevDispositionInput } from './disposition.js';
import type { DevIdentity } from './record.js';
import type { DevReadyInput } from './ready.js';
import type { DevCycleInput, DevReviewInput } from './review.js';

/** The reviewer choice: the shipped CLI reviewer, or a configured `agent:` role. */
const REVIEWER_PATTERN = new RegExp(
  `^(${CODERABBIT_REVIEWER}|agent:[A-Za-z0-9][A-Za-z0-9._/@-]*)$`,
);

// Defaults are applied by the OPS (`target ?? DEFAULT_DEV_TARGET`), not the
// schemas — the drift pins mirror the hand-written optional input types, so
// every optional field is `.exactOptional()` (exactOptionalPropertyTypes).
export const DevCheckInputSchema: z.ZodType<DevCheckInput> = z
  .object({
    repoRoot: z.string().min(1),
    target: z.string().min(1).exactOptional(),
    range: z
      .string()
      .regex(/^[^-\s.][^\s]*\.\.[^-\s.][^\s]*$/, "range must be '<ref>..<ref>'")
      .exactOptional(),
  })
  .strict();

export const DevCycleInputSchema: z.ZodType<DevCycleInput> = z
  .object({
    repoRoot: z.string().min(1),
    action: z.literal('cycle').exactOptional(),
    target: z.string().min(1).exactOptional(),
    base: z
      .string()
      .regex(/^[0-9a-fA-F]{7,64}$/, 'base must be a commit sha (an immutable pin)')
      .exactOptional(),
    reviewer: z.string().regex(REVIEWER_PATTERN).exactOptional(),
    uncommitted: z.boolean().exactOptional(),
  })
  .strict();

/**
 * The author-admission branch of the `dev.review` union (the worker
 * transport's wire shape from the merged worker-transport PR — the crq-side
 * invocation `cq dev.review --action=enroll --head=…` keeps working
 * byte-for-byte). P5 adds `tree` as the alternative to `head`: exactly one.
 */
export const DevTransportInputSchema = z
  .object({
    action: z.enum(['enroll', 'status', 'fallback']),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
    base: z.string().regex(/^[0-9a-f]{40}$/),
    head: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    tree: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    target: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/),
    cycle: z.number().int().min(1).max(2),
  })
  .strict()
  .refine(
    (i) => [i.requestId, i.base, i.head ?? i.tree ?? '', i.target].every((v) => v.trim() === v),
    'binding must not contain whitespace or controls',
  )
  .refine((i) => Boolean(i.head) !== Boolean(i.tree), 'provide exactly one of head or tree')
  .refine((i) => i.base !== i.head, 'base and head must differ')
  // Published as JSON Schema too: a refinement alone is invisible to schema consumers.
  .meta({ oneOf: [{ required: ['head'] }, { required: ['tree'] }] });

export type DevTransportInput = z.infer<typeof DevTransportInputSchema>;

/**
 * The ONE `dev.review` op's input: the CodeRabbit review cycle (no action,
 * or `action: 'cycle'`) or the author-admission transport
 * (`enroll | status | fallback`). Both branches are strict objects, so the
 * union is unambiguous — an unknown key or an unknown action spelling fails
 * every branch and the schema refuses.
 */
export const DevReviewInputSchema: z.ZodType<DevReviewInput> = z.union([
  DevCycleInputSchema,
  DevTransportInputSchema,
]);

export const DevDispositionInputSchema: z.ZodType<DevDispositionInput> = z
  .object({
    repoRoot: z.string().min(1),
    findingId: z.string().min(1),
    action: z.enum(['fixed', 'rejected', 'deferred']),
    why: z
      .string()
      .regex(/\S/, 'why must name the fix, the false-positive mechanism, or the tracking issue'),
  })
  .strict();

export const DevReadyInputSchema: z.ZodType<DevReadyInput> = z
  .object({
    repoRoot: z.string().min(1),
    target: z.string().min(1).exactOptional(),
  })
  .strict();

/**
 * The family's identity-contract drift pin: every dev record carries this
 * (base, head, dirty-diff) triple, and dev.review pins review evidence
 * against it. Owned here at the registry boundary — the same move as the
 * gates family's FingerprintConfigSchema — so SDK consumers composing dev
 * inputs validate the identity against ONE drift-pinned shape. Type-only
 * helper import (the lazy rule: the registry never loads record.js at
 * module scope).
 */
export const DevIdentitySchema: z.ZodType<DevIdentity> = z
  .object({
    base: z.string().min(1),
    head: z.string().min(1),
    dirtySha256: z.string().min(1),
  })
  .strict();

/** Dev family op registry (strategy §8 lane 1: the pre-PR cycle as commands). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'dev.check',
    inputSchema: DevCheckInputSchema,
    importer: () =>
      import('./check.js').then(
        (m) =>
          (async (input: DevCheckInput) => {
            const [effects, denylist, cqConfig, fs] = await Promise.all([
              import('./effects.js'),
              import('./denylist.js'),
              import('../analyze/cqConfig.js'),
              import('node:fs/promises'),
            ]);
            const dev = effects.makeSubprocessDevEffects(input.repoRoot);
            const configText = await fs
              .readFile(`${input.repoRoot}/cq.json`, 'utf8')
              .catch(() => null);
            const packageText = await fs
              .readFile(`${input.repoRoot}/package.json`, 'utf8')
              .catch(() => '{}');
            let packageName = '';
            try {
              const data: unknown = JSON.parse(packageText);
              if (
                typeof data === 'object' &&
                data !== null &&
                'name' in data &&
                typeof data.name === 'string'
              )
                packageName = data.name;
            } catch {
              /* malformed package metadata retains legacy behavior */
            }
            let scanSecrets;
            if (configText !== null && packageName !== '@camerontaylor/cq-toolkit') {
              const parsed = cqConfig.parseCqConfig(configText, input.repoRoot);
              if (parsed.ok && parsed.config.checks.length > 0) {
                scanSecrets = denylist.makePortableReviewScanner(
                  input.repoRoot,
                  dev,
                  configText,
                  packageName,
                );
              }
            }
            return m.makeDevCheck(dev, scanSecrets)(input);
          }) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'dev.review',
    inputSchema: DevReviewInputSchema,
    // ONE ENTRY, TWO BRANCHES (the composition ruling): an admission action
    // binds only the ambient SSH alias (#332's adapter, unchanged — the
    // transport input carries no repoRoot); the cycle branch binds the
    // subprocess effects and the two-layer secret scanner from the
    // dispatched repoRoot.
    importer: () =>
      Promise.all([
        import('./review.js'),
        import('./review-transport.js'),
        import('./effects.js'),
        import('./denylist.js'),
        import('../../driver/factory.js'),
        import('../analyze/cqConfig.js'),
        import('../analyze/cqConfigDefaults.js'),
        import('../review/agentReviewer.js'),
        import('node:fs/promises'),
      ]).then(
        ([
          m,
          admission,
          effects,
          denylist,
          driverFactory,
          cqConfig,
          cqDefaults,
          agentReviewer,
          fs,
        ]) =>
          (async (input: DevReviewInput) => {
            if (m.isAdmissionInput(input)) return admission.envAuthorAdmission(input);
            const { repoRoot } = input as DevCycleInput;
            const dev = effects.makeSubprocessDevEffects(repoRoot);
            // Portable default: gitleaks' built-in rules apply everywhere.
            // A repo-specific scanner is added only when cq.json configures
            // its optional patterns file; missing toolkit policy is never a
            // prerequisite for an adopter review.
            const configText = await fs.readFile(`${repoRoot}/cq.json`, 'utf8').catch(() => null);
            const packageText = await fs
              .readFile(`${repoRoot}/package.json`, 'utf8')
              .catch(() => '{}');
            let packageName = 'repository';
            try {
              const data: unknown = JSON.parse(packageText);
              if (
                typeof data === 'object' &&
                data !== null &&
                'name' in data &&
                typeof data.name === 'string'
              )
                packageName = data.name;
            } catch {
              /* descriptive fallback only */
            }
            const scanSecrets = denylist.makePortableReviewScanner(
              repoRoot,
              dev,
              configText,
              packageName,
            );
            let patternsFile: string | undefined;
            if (configText !== null) {
              const parsed = cqConfig.parseCqConfig(configText, repoRoot);
              if (parsed.ok) {
                patternsFile = cqDefaults.resolveCqConfigDefaults(parsed.config, {
                  packageName,
                }).review.denylistPatternsFile;
              }
            }
            const drivers = driverFactory.createDriverFactory();
            return m.makeDevReview({
              effects: dev,
              scanSecrets,
              ...(patternsFile === undefined ? {} : { patternsFile }),
              runAgentReviewer: async ({ role, ...reviewInput }) => {
                if (role !== 'reviewer')
                  return {
                    status: 'needs-human',
                    reason: `unsupported configured reviewer role '${role}'`,
                  };
                const configText = await fs
                  .readFile(`${repoRoot}/cq.json`, 'utf8')
                  .catch(() => null);
                if (configText === null)
                  return { status: 'needs-human', reason: 'agent reviewer requires cq.json' };
                const parsed = cqConfig.parseCqConfig(configText, repoRoot);
                if (!parsed.ok)
                  return {
                    status: 'needs-human',
                    reason: `agent reviewer config: ${parsed.reason}`,
                  };
                const packageText = await fs
                  .readFile(`${repoRoot}/package.json`, 'utf8')
                  .catch(() => '{}');
                let packageName = 'repository';
                try {
                  const data: unknown = JSON.parse(packageText);
                  if (
                    typeof data === 'object' &&
                    data !== null &&
                    'name' in data &&
                    typeof data.name === 'string'
                  )
                    packageName = data.name;
                } catch {
                  /* descriptive fallback only */
                }
                const policy = cqDefaults.resolveCqConfigDefaults(parsed.config, { packageName });
                const roleSpec = policy.roles.reviewer;
                if (roleSpec === undefined)
                  return {
                    status: 'needs-human',
                    reason: 'cq.json roles.reviewer is required for an agent review',
                  };
                const budgetStop = cqDefaults.requireAgenticTokenBudget(policy);
                if (budgetStop !== undefined) return budgetStop;
                return agentReviewer.runAgentReviewer(drivers, {
                  ...reviewInput,
                  scanSecrets,
                  role: roleSpec,
                  maxTokens: policy.budgets.run.maxTokens!,
                  wallMs: policy.budgets.run.wallMs,
                  severityMap: policy.review.agentSeverityMap,
                });
              },
            })(input);
          }) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'dev.disposition',
    inputSchema: DevDispositionInputSchema,
    importer: () =>
      import('./disposition.js').then(
        (m) =>
          (async (input: DevDispositionInput) =>
            m.makeDevDisposition(
              (await import('./effects.js')).makeSubprocessDevEffects(input.repoRoot),
            )(input)) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'dev.ready',
    inputSchema: DevReadyInputSchema,
    importer: () =>
      import('./ready.js').then(
        (m) =>
          (async (input: DevReadyInput) =>
            m.makeDevReady((await import('./effects.js')).makeSubprocessDevEffects(input.repoRoot))(
              input,
            )) as Op<unknown, unknown>,
      ),
  },
];
