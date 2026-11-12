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
import { FindingFingerprintSchema } from '../../kernel/schema.js';
import { CODERABBIT_REVIEWER } from './coderabbit.js';
import type { DevCheckInput } from './check.js';
import type { DevCycleCompositionInput } from './cycle.js';
import type { DevDispositionInput } from './disposition.js';
import type { DevIdentity } from './record.js';
import type { DevReadyInput } from './ready.js';
import type { DevCycleInput, DevReviewInput } from './review.js';
import type { DevEffects } from './effects.js';
import { currentCqEnv } from '../../config/run-env.js';
import { QueueConfigurationError } from '../review/internal/queueClient.js';

/**
 * S2b-i: read the queue SSH alias lazily (at submit, never at registry
 * resolution, keeping entry construction inert). Missing configuration is a
 * construction-time QueueConfigurationError only when the managed path
 * actually submits. An explicit dispatch snapshot takes precedence; otherwise
 * resolve the enclosing run snapshot (or ambient fallback) at that time.
 */
function reviewAlias(cqEnv = currentCqEnv()): string {
  const alias = cqEnv.values['CQ_QUEUE_SSH_ALIAS'];
  if (typeof alias !== 'string' || alias === '')
    throw new QueueConfigurationError('Configure CQ_QUEUE_SSH_ALIAS for review-v1');
  return alias;
}

/**
 * S2b-i: resolve the forge `owner/repo` for the managed queue route via the
 * bound dev effects. The server re-derives every hashed fact and refuses a
 * mismatch (plan D2), so this is a routing hint, never authority. A forge
 * read failure is a refusal (the submission cannot be routed), surfaced by
 * the managed leg — never a silent fallback.
 */
async function resolveForgeRepo(dev: DevEffects): Promise<string> {
  const result = await dev.runCommand(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    {
      timeoutMs: 30_000,
    },
  );
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error('cannot verify deferred forge identity');
  const repo = result.stdout.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error(`forge returned an unparseable repository identity '${repo}'`);
  return repo;
}

/** The reviewer choice: the shipped CLI reviewer, or a configured `agent:` role. */
const REVIEWER_PATTERN = new RegExp(
  `^(${CODERABBIT_REVIEWER}|agent:[A-Za-z0-9][A-Za-z0-9._/@-]*)$`,
);

/**
 * One testFiles entry. The dev protocol's invariant — a dash-leading segment
 * is an option-shaped token (`-x`, `--flag`, the literal `--`) and is refused
 * BEFORE any gate runs — is encoded here so the shared boundary schemas
 * (dev.check, the dev.review cycle branch, dev.cycle composition) reject it
 * at the entry point, instead of failing per-leg after a run has started.
 */
const TEST_FILE_SEGMENT_SCHEMA = z
  .string()
  .min(1)
  .regex(/^[^-]/, 'testFiles entries are file paths and must not begin with "-"');

// Defaults are applied by the OPS (`target ?? DEFAULT_DEV_TARGET`), not the
// schemas — the drift pins mirror the hand-written optional input types, so
// every optional field is `.exactOptional()` (exactOptionalPropertyTypes).
export const DevCheckInputSchema: z.ZodType<DevCheckInput> = z
  .object({
    repoRoot: z.string().min(1),
    uncommitted: z.boolean().exactOptional(),
    target: z.string().min(1).exactOptional(),
    range: z
      .string()
      .regex(/^[^-\s.][^\s]*\.\.[^-\s.][^\s]*$/, "range must be '<ref>..<ref>'")
      .exactOptional(),
    includeIntegration: z.boolean().exactOptional(),
    testFiles: z.array(TEST_FILE_SEGMENT_SCHEMA).min(1).exactOptional(),
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
    includeIntegration: z.boolean().exactOptional(),
    testFiles: z.array(TEST_FILE_SEGMENT_SCHEMA).min(1).exactOptional(),
  })
  .strict();

/**
 * The `dev.review` op's input: the CodeRabbit review cycle (no action, or
 * `action: 'cycle'`). S2b-ii retired the author-admission branch and its
 * `enroll | status | fallback` actions; unknown actions still refuse.
 */
export const DevReviewInputSchema: z.ZodType<DevReviewInput> = DevCycleInputSchema;

// Defaults are applied by the OPS (`target ?? DEFAULT_DEV_TARGET`), not the
// schemas — the drift pins mirror the hand-written optional input types, so
// every optional field is `.exactOptional()` (exactOptionalPropertyTypes).
// The disposition schema below follows the same rule; its deferred refine
// mirrors the ledger record's own v3 rule (record.ts).
export const DevDispositionInputSchema: z.ZodType<DevDispositionInput> = z
  .object({
    repoRoot: z.string().min(1),
    findingId: z.string().min(1),
    action: z.enum(['fixed', 'rejected', 'deferred']),
    why: z
      .string()
      .regex(/\S/, 'why must name the fix, the false-positive mechanism, or the tracking issue'),
    owner: z.string().regex(/\S/, 'owner must name who made the adjudication'),
    evidence: z.array(z.string().min(1)),
    reviewTrigger: z
      .string()
      .regex(/\S/, 'reviewTrigger must name when the disposition is re-reviewed')
      .nullable()
      .exactOptional(),
    fingerprint: FindingFingerprintSchema.exactOptional(),
    acceptedRisk: z.string().nullable().exactOptional(),
  })
  .strict()
  .refine(
    (input) =>
      input.action !== 'deferred' ||
      (input.reviewTrigger !== null && input.reviewTrigger !== undefined),
    'a deferred disposition requires a nonempty reviewTrigger',
  );

export const DevReadyInputSchema: z.ZodType<DevReadyInput> = z
  .object({
    repoRoot: z.string().min(1),
    target: z.string().min(1).exactOptional(),
  })
  .strict();

/** The pre-PR composition's input: the whole cycle runs in one repo. */
export const DevCycleCompositionInputSchema: z.ZodType<DevCycleCompositionInput> = z
  .object({
    repoRoot: z.string().min(1),
    target: z.string().min(1).exactOptional(),
    push: z.boolean().exactOptional(),
    title: z.string().min(1).exactOptional(),
    includeIntegration: z.boolean().exactOptional(),
    testFiles: z.array(TEST_FILE_SEGMENT_SCHEMA).min(1).exactOptional(),
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
            const [effects, denylist, fs] = await Promise.all([
              import('./effects.js'),
              import('./denylist.js'),
              import('node:fs/promises'),
            ]);
            const dev = effects.makeSubprocessDevEffects(input.repoRoot);
            const scanSecrets = await denylist.checkScannerFor(input.repoRoot, dev, (path) =>
              fs.readFile(path, 'utf8'),
            );
            return m.makeDevCheck(dev, scanSecrets)(input);
          }) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'dev.review',
    inputSchema: DevReviewInputSchema,
    // ONE ENTRY, ONE BRANCH: S2b-ii retired the author-admission branch, so
    // the frozen DevCycleInputSchema below is the whole input. The cycle binds
    // the subprocess effects and the two-layer secret scanner from the
    // dispatched repoRoot. S2b-i: the cycle's `coderabbit` path rides the
    // managed queue route (review-v1 on the queue identity); the binding is
    // inert at construction (closures only — no spawn, no env read), so
    // resolving the entry still touches nothing.
    importer: (wiring) =>
      Promise.all([
        import('./review.js'),
        import('./effects.js'),
        import('./denylist.js'),
        import('../../driver/factory.js'),
        import('../analyze/cqConfig.js'),
        import('../analyze/cqConfigDefaults.js'),
        import('../review/agentReviewer.js'),
        import('./agentReview.js'),
        import('node:fs/promises'),
        import('../../shared/readCqConfigText.js'),
        import('./managedReview.js'),
        import('../review/internal/queueClient.js'),
      ]).then(
        ([
          m,
          effects,
          denylist,
          driverFactory,
          cqConfig,
          cqDefaults,
          agentReviewer,
          agentReview,
          fs,
          sharedRead,
          managed,
          queueClient,
        ]) =>
          (async (raw: unknown) => {
            // The per-dispatch bindings run BEFORE input validation (#1185 +
            // S2b-i): even a schema-bypassing dispatch binds its driver
            // factory and its managed-route submission (the driver-cqenv
            // probes dispatch a schema-invalid dummy and still expect both
            // lines to have run). Every construction here is inert:
            // closure-only effects, and the queue alias is read only when
            // the managed path actually submits.
            const { repoRoot: rawRoot } = raw as DevCycleInput;
            const dev = effects.makeSubprocessDevEffects(rawRoot);
            const drivers = driverFactory.createDriverFactory({
              // The dispatch wiring's snapshot wins when supplied (a direct
              // importer call with explicit wiring outside a run); inside a
              // run the wiring IS the run snapshot, so this is identical to
              // the run-context fallback. Absent = the library default. The
              // narration sink rides the same way (the CLI's `--json` mode
              // keeps stderr empty through it).
              ...(wiring?.cqEnv !== undefined ? { cqEnv: wiring.cqEnv } : {}),
              ...(wiring?.onDeprecatedAlias !== undefined
                ? { onDeprecatedAlias: wiring.onDeprecatedAlias }
                : {}),
            });
            const managedSubmit = managed.makeManagedReviewSubmit(
              () => queueClient.sshQueueTransport(reviewAlias(wiring?.cqEnv), 'review-v1'),
              () => resolveForgeRepo(dev),
            );
            // The guarded body runs INSIDE the family boundary: a
            // schema-bypassing input keeps the `failed` taxonomy of
            // guardDevOp (never a rejected promise, never a read fault
            // masquerading as one), and the cq.json read fault below refuses
            // only a schema-valid dispatch.
            return effects.guardDevOp(
              'dev.review',
              DevReviewInputSchema,
              async (valid: DevReviewInput) => {
                const { repoRoot } = valid;
                // `dev` is the per-dispatch effects bound BEFORE validation;
                // for a schema-valid dispatch it binds this same repoRoot.
                // Portable default: gitleaks' built-in rules apply everywhere.
                // A repo-specific scanner is added only when cq.json configures
                // its optional patterns file; missing toolkit policy is never a
                // prerequisite for an adopter review.
                const readFile = (path: string) => fs.readFile(path, 'utf8');
                // Only an ABSENT cq.json means "no config"; any other read fault
                // refuses the review under needs-human instead of silently
                // binding the default scanner and reviewer policy.
                const configRead = await sharedRead.readCqConfigText(repoRoot, readFile);
                if (configRead.outcome === 'fault')
                  return {
                    status: 'needs-human',
                    reason: `dev.review: ${sharedRead.cqConfigFaultText(configRead.error)}`,
                  };
                const configText = configRead.outcome === 'text' ? configRead.text : null;
                const packageName = await agentReview.readPackageName(readFile, repoRoot);
                const scanSecrets = denylist.makePortableReviewScanner(
                  repoRoot,
                  dev,
                  configText,
                  packageName,
                );
                let patternsFile: string | undefined;
                let configuredReviewers: readonly string[] | undefined;
                if (configText !== null) {
                  const parsed = cqConfig.parseCqConfig(configText, repoRoot);
                  if (parsed.ok) {
                    const policy = cqDefaults.resolveCqConfigDefaults(parsed.config, {
                      packageName,
                    }).review;
                    patternsFile = policy.denylistPatternsFile;
                    configuredReviewers = policy.reviewers;
                  }
                }
                return m.makeDevReview({
                  effects: dev,
                  scanSecrets,
                  ...(patternsFile === undefined ? {} : { patternsFile }),
                  ...(configuredReviewers === undefined ? {} : { configuredReviewers }),
                  runAgentReviewer: agentReview.makeAgentReviewRunner({
                    repoRoot,
                    readFile,
                    drivers,
                    scanSecrets,
                    run: agentReviewer.runAgentReviewer,
                  }),
                  // S2b-i managed route: review-v1 on the existing queue SSH
                  // identity (plan D1), bound per dispatch before validation.
                  managedSubmit,
                })(valid);
              },
            )(raw);
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
  {
    name: 'dev.cycle',
    inputSchema: DevCycleCompositionInputSchema,
    // The composition binds the production legs AT DISPATCH from the
    // dispatched repoRoot: subprocess dev effects, the gh effects for the
    // publication leg, the real git transport for the verified push, and
    // the driver factory the review/address legs resolve roles through.
    // Every construction is inert (closure-only; processes spawn only when
    // an effect is CALLED), so resolving the entry never touches env, the
    // network, or the filesystem.
    importer: (wiring) =>
      Promise.all([
        import('./cycle.js'),
        import('../../driver/factory.js'),
        import('./managedReview.js'),
        import('./effects.js'),
        import('../../adapters/forge-github/ghEffects.js'),
        import('../dev/denylist.js'),
        import('../pr/registry.js'),
        import('node:fs/promises'),
      ]).then(
        ([m, driverFactory, managed, effects, ghEffects, denylist, prRegistry, fs]) =>
          (async (input: DevCycleCompositionInput) => {
            const dev = effects.makeSubprocessDevEffects(input.repoRoot);
            // The secret scanner a check leg binds: the SAME two-layer
            // portable composition the dev.check entry carries (gitleaks
            // defaults; the repo's optional cq.json patterns file rides
            // makePortableReviewScanner) — built for one checkout ROOT, so the
            // #536 probe worktree gets its own, from its own configuration.
            const readFile = (path: string) => fs.readFile(path, 'utf8');
            const scannerFor = async (root: string, rootEffects: typeof dev) =>
              denylist.checkScannerFor(root, rootEffects, readFile);
            const scanSecrets = await scannerFor(input.repoRoot, dev);
            // The publication scanner the default pr.open legs bind (the
            // pr.open importer's mandatory gate): built for one checkout
            // ROOT, so the #536 probe worktree binds its own from its own
            // configuration. An unreadable author cq.json refuses the op
            // outright (the pr.open fail-closed shape); an unbindable probe
            // root fails the probe publication (never another tree's rules).
            const publicationLoaded = await prRegistry.loadPublicationScanner(
              input.repoRoot,
              'dev.cycle',
            );
            if ('status' in publicationLoaded) return publicationLoaded;
            // #536: the red-final-gate fallback's probe worktree binds its own
            // effects (same construction as `dev`). Its dependency install is
            // wired ONLY for a pnpm-locked repository: an offline, frozen
            // install from the existing store — bounded, abortable, no
            // network and no fallback. Without a lockfile the fallback is off.
            const pnpmLocked = await fs
              .access(`${input.repoRoot}/pnpm-lock.yaml`)
              .then(() => true)
              .catch(() => false);
            return m.makeDevCycle({
              managedSubmit: managed.makeConfiguredManagedReviewSubmit(wiring?.cqEnv),
              effects: dev,
              gh: ghEffects.makeSubprocessPrEffects(input.repoRoot),
              // The dispatch wiring's snapshot, when explicitly supplied: the
              // default factory the review/address legs resolve roles through
              // reads it instead of the ambient environment. Absent, no
              // drivers key is bound and the cycle's library default
              // (deps.drivers ?? createDriverFactory()) stands.
              ...(wiring?.cqEnv !== undefined
                ? {
                    drivers: driverFactory.createDriverFactory({
                      cqEnv: wiring.cqEnv,
                      ...(wiring.onDeprecatedAlias !== undefined
                        ? { onDeprecatedAlias: wiring.onDeprecatedAlias }
                        : {}),
                    }),
                  }
                : {}),
              ...(scanSecrets === undefined ? {} : { scanSecrets }),
              publicationScanner: publicationLoaded.scanner,
              effectsFor: (root: string) => effects.makeSubprocessDevEffects(root),
              scanSecretsFor: scannerFor,
              publicationScannerFor: async (root: string, _rootEffects: typeof dev) => {
                const probeLoaded = await prRegistry.loadPublicationScanner(root, 'dev.cycle');
                return 'status' in probeLoaded ? undefined : probeLoaded.scanner;
              },
              ...(pnpmLocked
                ? {
                    installDeps: async (root: string, signal: AbortSignal) => {
                      const installed = await effects
                        .makeSubprocessDevEffects(root)
                        .runCommand('pnpm', ['install', '--offline', '--frozen-lockfile'], {
                          timeoutMs: m.GREEN_PREFIX_INSTALL_TIMEOUT_MS,
                          signal,
                        });
                      if (installed.exitCode !== 0)
                        throw new Error(
                          `pnpm install --offline --frozen-lockfile ${installed.timedOut ? 'timed out' : `exited ${String(installed.exitCode)}`}: ${installed.stderr.trim().slice(-300)}`,
                        );
                    },
                  }
                : {}),
            })(input);
          }) as Op<unknown, unknown>,
      ),
  },
];
