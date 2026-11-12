// The dev.review agent-reviewer binding: reads cq.json policy for the
// configured `reviewer` role and hands the review to the session engine. Split
// from the registry importer so the config/refusal branches are unit-testable
// with fakes; the registry loads it lazily at dispatch.
import type { DriverFactory } from '../../driver/factory.js';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { requireAgenticTokenBudget, resolveCqConfigDefaults } from '../analyze/cqConfigDefaults.js';
import { cqConfigFaultText, readCqConfigText } from '../../shared/readCqConfigText.js';
import type { runAgentReviewer } from '../review/agentReviewer.js';
import type { DiffSecretScanner } from './denylist.js';
import type { DevReviewDeps } from './review.js';

type ReadFile = (path: string) => Promise<string>;

/** The package name is descriptive context only; any failure falls back. */
export async function readPackageName(readFile: ReadFile, repoRoot: string): Promise<string> {
  const text = await readFile(`${repoRoot}/package.json`).catch(() => '{}');
  try {
    const data: unknown = JSON.parse(text);
    if (
      typeof data === 'object' &&
      data !== null &&
      'name' in data &&
      typeof data.name === 'string'
    )
      return data.name;
  } catch {
    /* descriptive fallback only */
  }
  return 'repository';
}

export function makeAgentReviewRunner(deps: {
  repoRoot: string;
  readFile: ReadFile;
  drivers: DriverFactory;
  scanSecrets: DiffSecretScanner;
  run: typeof runAgentReviewer;
}): NonNullable<DevReviewDeps['runAgentReviewer']> {
  return async ({ role, ...reviewInput }) => {
    if (role !== 'reviewer')
      return { status: 'needs-human', reason: `unsupported configured reviewer role '${role}'` };
    const { signal, remainingWallMs, ...engineInput } = reviewInput;
    // The injected readFile seam stays injectable; only ENOENT reads as "no
    // config" and any other fault names cq.json and the errno.
    const configRead = await readCqConfigText(deps.repoRoot, deps.readFile);
    if (configRead.outcome === 'fault')
      return {
        status: 'needs-human',
        reason: `agent reviewer: ${cqConfigFaultText(configRead.error)}`,
      };
    if (configRead.outcome === 'absent')
      return { status: 'needs-human', reason: 'agent reviewer requires cq.json' };
    const configText = configRead.text;
    const parsed = parseCqConfig(configText, deps.repoRoot);
    if (!parsed.ok)
      return { status: 'needs-human', reason: `agent reviewer config: ${parsed.reason}` };
    const packageName = await readPackageName(deps.readFile, deps.repoRoot);
    const policy = resolveCqConfigDefaults(parsed.config, { packageName });
    const roleSpec = policy.roles.reviewer;
    if (roleSpec === undefined)
      return {
        status: 'needs-human',
        reason: 'cq.json roles.reviewer is required for an agent review',
      };
    const budgetStop = requireAgenticTokenBudget(policy);
    if (budgetStop !== undefined) return budgetStop;
    // The cycle wall budget bounds the engine: a cycle abort or expiry
    // reaches the run through the relayed signal and the capped wallMs /
    // stepWallMs, so the run cannot outlive the cycle that dispatched it.
    const remaining = remainingWallMs?.() ?? Infinity;
    if (!(remaining > 0))
      return {
        status: 'needs-human',
        reason: 'review wall budget exhausted before agent dispatch',
      };
    return deps.run(deps.drivers, {
      ...engineInput,
      ...(signal ? { signal } : {}),
      scanSecrets: deps.scanSecrets,
      role: roleSpec,
      maxTokens: policy.budgets.run.maxTokens!,
      wallMs: Math.min(policy.budgets.run.wallMs, remaining),
      stepWallMs: Math.min(policy.budgets.step.wallMs, policy.budgets.run.wallMs, remaining),
      severityMap: policy.review.agentSeverityMap,
      searchTools: policy.review.searchTools,
      session: policy.review.session,
      size: policy.review.size,
      exclude: policy.review.exclude,
    });
  };
}
