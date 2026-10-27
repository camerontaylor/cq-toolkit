// The dev.review agent-reviewer binding: reads cq.json policy for the
// configured `reviewer` role and hands the review to the session engine. Split
// from the registry importer so the config/refusal branches are unit-testable
// with fakes; the registry loads it lazily at dispatch.
import type { DriverFactory } from '../../driver/factory.js';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { requireAgenticTokenBudget, resolveCqConfigDefaults } from '../analyze/cqConfigDefaults.js';
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
    const configText = await deps.readFile(`${deps.repoRoot}/cq.json`).catch(() => null);
    if (configText === null)
      return { status: 'needs-human', reason: 'agent reviewer requires cq.json' };
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
    return deps.run(deps.drivers, {
      ...reviewInput,
      scanSecrets: deps.scanSecrets,
      role: roleSpec,
      maxTokens: policy.budgets.run.maxTokens!,
      wallMs: policy.budgets.run.wallMs,
      stepWallMs: Math.min(policy.budgets.step.wallMs, policy.budgets.run.wallMs),
      severityMap: policy.review.agentSeverityMap,
      searchTools: policy.review.searchTools,
      session: policy.review.session,
      size: policy.review.size,
      exclude: policy.review.exclude,
    });
  };
}
