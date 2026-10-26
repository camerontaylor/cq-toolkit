// Pure policy resolution: no provider/model defaults, filesystem, env or driver imports.
import type { OpResult } from '../../kernel/types.js';
import type { CqConfig, CqSeverity } from './cqConfig.js';

/** Flags use the same nested policy shape; packageName is supplied from package.json by the caller. */
export type CqConfigFlags = Partial<Omit<CqConfig, 'schemaVersion' | 'checks'>> & {
  packageName: string;
  /** Direct CLI override for budgets.run.maxTokens. */
  maxTokens?: number;
};

/** Flags override individual fields, then config, then the documented numeric policy. */
export function resolveCqConfigDefaults(config: CqConfig, flags: CqConfigFlags) {
  const c = config;
  const f = flags;
  const maxTokens = f.maxTokens ?? f.budgets?.run?.maxTokens ?? c.budgets?.run?.maxTokens;
  return {
    packages: f.packages ?? c.packages ?? [{ name: f.packageName, path: '.' }],
    checks: c.checks.map((check) => ({
      ...check,
      kind:
        check.kind ?? (check.adapter === 'vitest-json' ? ('tests' as const) : ('static' as const)),
    })),
    roles: { ...c.roles, ...f.roles },
    budgets: {
      run: {
        ...(maxTokens === undefined ? {} : { maxTokens }),
        wallMs: f.budgets?.run?.wallMs ?? c.budgets?.run?.wallMs ?? 1_200_000,
      },
      unit: { wallMs: f.budgets?.unit?.wallMs ?? c.budgets?.unit?.wallMs ?? 3_600_000 },
      step: { wallMs: f.budgets?.step?.wallMs ?? c.budgets?.step?.wallMs ?? 1_200_000 },
    },
    review: {
      rounds: f.review?.rounds ?? c.review?.rounds ?? 3,
      searchTools: f.review?.searchTools ?? c.review?.searchTools ?? true,
      blockingSeverities:
        f.review?.blockingSeverities ??
        c.review?.blockingSeverities ??
        (['critical', 'major'] satisfies CqSeverity[]),
      agentSeverityMap: {
        high: 'major' as const,
        medium: 'minor' as const,
        ...c.review?.agentSeverityMap,
        ...f.review?.agentSeverityMap,
      },
      reviewers:
        f.review?.reviewers ??
        c.review?.reviewers ??
        (['coderabbit', 'agent'] satisfies NonNullable<
          NonNullable<CqConfig['review']>['reviewers']
        >),
      addressConcurrency: f.review?.addressConcurrency ?? c.review?.addressConcurrency ?? 2,
      ...((f.review?.denylistPatternsFile ?? c.review?.denylistPatternsFile) === undefined
        ? {}
        : {
            denylistPatternsFile: f.review?.denylistPatternsFile ?? c.review?.denylistPatternsFile,
          }),
      // Query is computed at runtime by the forge consumer; do not guess an account here.
      bulk: {
        ...c.review?.bulk,
        ...f.review?.bulk,
        concurrency: f.review?.bulk?.concurrency ?? c.review?.bulk?.concurrency ?? 3,
      },
    },
    escalation: {
      workerAttempts: f.escalation?.workerAttempts ?? c.escalation?.workerAttempts ?? 2,
      rescueBase: f.escalation?.rescueBase ?? c.escalation?.rescueBase ?? 20,
      rescuePerFixed: f.escalation?.rescuePerFixed ?? c.escalation?.rescuePerFixed ?? 10,
      rescuePerPackageCap:
        f.escalation?.rescuePerPackageCap ?? c.escalation?.rescuePerPackageCap ?? 10,
    },
  };
}

export type EffectiveCqPolicy = ReturnType<typeof resolveCqConfigDefaults>;

/** Agentic callers return this stop before constructing a driver or doing any work. */
export function requireAgenticTokenBudget(
  policy: EffectiveCqPolicy,
  agentic = true,
): Extract<OpResult<never>, { status: 'needs-human' }> | undefined {
  if (agentic && policy.budgets.run.maxTokens === undefined) {
    return {
      status: 'needs-human',
      reason:
        'Agentic runs require budgets.run.maxTokens in cq.json or an explicit flag; no default token budget is supplied.',
    };
  }
  return undefined;
}
