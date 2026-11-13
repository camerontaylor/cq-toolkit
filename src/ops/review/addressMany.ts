import {
  isAddressCheckoutIncomplete,
  withAddressManyCheckout,
} from './internal/addressCheckoutOwnership.js';
import { checkoutWriterContext } from '../../shared/checkoutWriterContext.js';
import { checkoutWriterCommand } from '../../shared/checkoutWriterCommand.js';
import { processEnv } from '../../config/process-env.js';
import { z } from 'zod';
import { mkdtemp, symlink, access, readFile, mkdir, rm, realpath, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeQueueOps } from './queue.js';
import type { QueueEnqueueInput } from './internal/queueProtocol.js';
import { resolve, dirname, basename } from 'node:path';
import { makeGhRunner, type GhFn } from '../../adapters/forge-github/gh.js';
import { ReviewAddressManyInputSchema } from './registry.js';
import type { OpResult } from '../../kernel/types.js';
import {
  createKnownUsageLedger,
  normalizeUsageObservation,
  type KnownUsageSummary,
  type UsageObservation,
} from '../../shared/knownUsage.js';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { makeReviewAddress, type ReviewAddressInput, type ReviewAddressResult } from './address.js';
import type { DriverFactory } from '../../driver/factory.js';
import {
  selectAddressMany,
  resolveAddressManyConcurrency,
  type AddressManyEnrollment,
  initialAddressManyBudget,
  admitAddressMany,
  settleAddressMany,
  aggregateAddressMany,
  type AddressManyPrFacts,
  type AddressManyAggregate,
  type AddressManyOutcomeInput,
} from './internal/addressManyPlan.js';

const PullMetadata = z.object({
  number: z.number().int().positive(),
  merged: z.boolean(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  user: z.object({ login: z.string(), type: z.enum(['User', 'Organization', 'Bot']) }).nullable(),
  base: z.object({ ref: z.string().min(1) }),
  head: z.object({
    sha: z.string(),
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});
const RepositoryMetadata = z.object({ nameWithOwner: z.string() });

export interface ReviewAddressManyInput {
  repoRoot: string;
  repo: string;
  /** Prepared dependency checkout per PR number, relative to repoRoot or absolute. */
  dependencyRoots?: Record<string, string>;
  pulls?: number[];
  query?: string;
  concurrency?: number;
  cloneRoot?: string;
  enrollments?: Array<{ number: number; request: QueueEnqueueInput }>;
  owner: string;
  maxTokens: number;
  tokensPerPr: number;
  rounds?: number;
  wallMs?: number;
  push?: boolean;
}
export type ReviewAddressManyResult = OpResult<
  AddressManyAggregate & { usageSummary: KnownUsageSummary }
> & {
  report?: AddressManyAggregate & { usageSummary: KnownUsageSummary };
  /** Top-level envelope for report-less exits, per the I1 usage-summary carrier. */
  usageSummary?: KnownUsageSummary;
};

class IsolationRefusal extends Error {}

/**
 * The caller's effective `core.sshCommand` (system, global, local and, when
 * enabled, worktree scopes) or none: setting GIT_SSH_COMMAND would otherwise
 * override it and silently discard its options when batch mode is enforced.
 */
const resolveCoreSshCommand = async (repoRoot: string): Promise<string | undefined> => {
  const run = promisify(execFile);
  try {
    const configured = await run('git', ['-C', repoRoot, 'config', '--get', 'core.sshCommand'], {
      timeout: 300_000,
      env: { ...processEnv(), GIT_TERMINAL_PROMPT: '0' },
    });
    const command = configured.stdout.trim();
    return command ? command : undefined;
  } catch {
    // Unset (exit 1) or unreadable configuration resolves to no configured
    // command; a real git failure surfaces on the next work invocation.
    return undefined;
  }
};

/**
 * Bounded, non-interactive options for clone-setup Git calls. Git asks for
 * credentials through `/dev/tty`, not stdin, so a private remote without a
 * usable credential would otherwise stall the worker (and its reservation)
 * forever; the timeout bounds hangs that no prompt explains.
 */
const gitSubprocess = (
  configuredSshCommand?: string,
): { timeout: number; env: NodeJS.ProcessEnv } => {
  const env: NodeJS.ProcessEnv = { ...processEnv(), GIT_TERMINAL_PROMPT: '0' };
  // GIT_TERMINAL_PROMPT=0 covers git's own credential prompts, but OpenSSH
  // reads /dev/tty directly for passphrase/host-key prompts and ignores it.
  // BatchMode makes ssh non-interactive (it refuses instead of prompting)
  // without discarding caller-configured SSH commands or settings; an ssh
  // variant that does not know BatchMode would only fail earlier, which the
  // timeout below bounds anyway. With no env vars set, the caller's resolved
  // core.sshCommand stays the base command so its options survive; plain ssh
  // applies only when nothing is configured.
  if (env['GIT_SSH'] === undefined && env['GIT_SSH_COMMAND'] === undefined) {
    const base = configuredSshCommand?.trim() || 'ssh';
    env['GIT_SSH_COMMAND'] = /(^|[\s"'])-oBatchMode=yes([\s"']|$)/.test(base)
      ? base
      : `${base} -oBatchMode=yes`;
  } else if (
    env['GIT_SSH_COMMAND'] !== undefined &&
    !/(^|[\s"'])-oBatchMode=yes([\s"']|$)/.test(env['GIT_SSH_COMMAND'])
  ) {
    env['GIT_SSH_COMMAND'] = `${env['GIT_SSH_COMMAND']} -oBatchMode=yes`;
  }
  return { timeout: 300_000, env };
};

/** Independent object store and common directory; caller receipts remain durable. */
export async function isolateAddressMany(
  repoRoot: string,
  number: number,
  options: { cloneRoot: string; target?: string; onPartial?: (path: string) => void },
): Promise<string> {
  const run = promisify(execFile);
  const sshCommand = await resolveCoreSshCommand(repoRoot);
  const git = checkoutWriterContext()
    ? (file: string, args: string[]) => checkoutWriterCommand(file, args, gitSubprocess(sshCommand))
    : (file: string, args: string[]) => run(file, args, gitSubprocess(sshCommand));
  // Inspect key names only: helpers, HTTP headers and signing values may contain credentials.
  const scopes = ['--local'];
  try {
    const extension = await git('git', [
      '-C',
      repoRoot,
      'config',
      '--bool',
      '--get',
      'extensions.worktreeConfig',
    ]);
    if (extension.stdout.trim() === 'true') scopes.push('--worktree');
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1)
      throw new IsolationRefusal('Cannot inspect worktree configuration capability');
  }
  for (const scope of scopes) {
    try {
      const local = await git('git', [
        '-C',
        repoRoot,
        'config',
        scope,
        '--name-only',
        '--get-regexp',
        '^(http\\..*extraheader|credential\\..*helper|commit\\.gpgsign|gpg\\.format|user\\.signingkey)$',
      ]);
      if (local.stdout.trim())
        throw new IsolationRefusal(
          'Repository-local or worktree credential-helper, HTTP header or signing settings require plain review.address; bulk isolation refuses to copy sensitive configuration',
        );
    } catch (error) {
      if (error instanceof IsolationRefusal) throw error;
      if ((error as { code?: unknown }).code !== 1)
        throw new IsolationRefusal(
          'Cannot inspect repository-local or worktree credential and signing configuration',
        );
    }
  }
  await mkdir(options.cloneRoot, { recursive: true });
  const parent = await mkdtemp(resolve(options.cloneRoot, `pr-${number}-`));
  const root = resolve(parent, 'repo');
  options.onPartial?.(root);
  try {
    const origin = await git('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']);
    await git('git', ['clone', '--no-hardlinks', '--', repoRoot, root]);
    await git('git', ['-C', root, 'remote', 'set-url', 'origin', origin.stdout.trim()]);
    for (const role of ['author', 'committer']) {
      let ident: string;
      try {
        ident = (
          await git('git', ['-C', repoRoot, 'var', `GIT_${role.toUpperCase()}_IDENT`])
        ).stdout.trim();
      } catch {
        throw new IsolationRefusal(
          `Cannot resolve caller ${role} identity; configure Git identity before bulk addressing`,
        );
      }
      const parsed = /^(.*) <([^<>]+)> [0-9]+ [+-][0-9]{4}$/.exec(ident);
      if (!parsed) throw new IsolationRefusal(`Cannot resolve caller ${role} identity`);
      await git('git', ['-C', root, 'config', `${role}.name`, parsed[1]!]);
      await git('git', ['-C', root, 'config', `${role}.email`, parsed[2]!]);
    }
    const target = options.target ?? 'main';
    await git('git', [
      '-C',
      root,
      'fetch',
      'origin',
      `+refs/heads/${target}:refs/remotes/origin/${target}`,
    ]);
    const modules = resolve(repoRoot, 'node_modules');
    try {
      await access(modules);
    } catch {
      return root;
    }
    await symlink(modules, resolve(root, 'node_modules'), 'dir');
    return root;
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}
/**
 * Retain exit spend across every terminal result that carries a report, plus
 * `ok`. Each admitted leg's settled usage is recorded exactly once: a valid,
 * normalized measurement (with derived cost when priced) from its report, or
 * an explicit unknown observation whenever the leg has no valid measurement —
 * including a dispatched leg whose report omitted usage, a leg that settled
 * without dispatching, and a malformed measurement. Not-admitted legs are
 * never recorded. The folded summary is attached to that result, so failure,
 * budget exhaustion, thrown and unknown legs never lose spend already paid;
 * a report-less refusal exits before any dispatch and carries the summary on
 * the I1 top-level envelope instead.
 */
export function makeReviewAddressMany(
  deps: {
    gh?: GhFn;
    isolate?: typeof isolateAddressMany;
    coordinationRoot?: string;
    enqueue?: ReturnType<typeof makeQueueOps>['enqueue'];
    address?: (input: ReviewAddressInput) => Promise<ReviewAddressResult>;
    /** Driver factory for the default address; carries the alias sink wiring. */
    drivers?: DriverFactory;
    managedSubmit?: import('../dev/managedReview.js').ManagedReviewSubmit;
  } = {},
) {
  return async (input: ReviewAddressManyInput): Promise<ReviewAddressManyResult> => {
    // A fresh ledger per invocation: the operation can be called repeatedly,
    // and one run's observations must never leak into another's summary.
    const ledger = createKnownUsageLedger();
    const run = makeReviewAddressManyCore(deps, (id, observation) =>
      ledger.record(id, observation),
    );
    const result = await run(input);
    const usageSummary = ledger.snapshot();
    if (result.status === 'ok')
      return { status: 'ok' as const, value: { ...result.value, usageSummary } };
    // A report-less exit (schema refusal, pre-dispatch refusal, or the op-level
    // catch) still carries its spend on the I1 top-level usageSummary envelope.
    if (result.report === undefined) return { ...result, usageSummary } as ReviewAddressManyResult;
    return {
      status: result.status,
      ...('error' in result ? { error: result.error } : {}),
      ...('reason' in result ? { reason: result.reason } : {}),
      ...('detail' in result ? { detail: result.detail } : {}),
      report: { ...result.report, usageSummary },
    } as ReviewAddressManyResult;
  };
}

/** The aggregate the core returns; the wrapper stamps the retained usage summary. */
type ReviewAddressManyCoreResult = OpResult<AddressManyAggregate> & {
  report?: AddressManyAggregate;
};

function makeReviewAddressManyCore(
  deps: {
    gh?: GhFn;
    isolate?: typeof isolateAddressMany;
    coordinationRoot?: string;
    enqueue?: ReturnType<typeof makeQueueOps>['enqueue'];
    address?: (input: ReviewAddressInput) => Promise<ReviewAddressResult>;
    /** Driver factory for the default address; carries the alias sink wiring. */
    drivers?: DriverFactory;
    managedSubmit?: import('../dev/managedReview.js').ManagedReviewSubmit;
  } = {},
  record: (id: string, observation: UsageObservation) => void = () => {},
) {
  return async (input: ReviewAddressManyInput): Promise<ReviewAddressManyCoreResult> => {
    const valid = ReviewAddressManyInputSchema.safeParse(input);
    if (!valid.success) return { status: 'failed', error: valid.error.message };
    const gh =
      deps.gh ?? makeGhRunner({ cwd: input.repoRoot, unsetEnv: ['GH_REPO'], timeoutMs: 30_000 });
    const facts = async (number: number): Promise<AddressManyPrFacts & { baseRefName: string }> => {
      const response = await gh(['api', `repos/${input.repo}/pulls/${number}`]);
      if (response.code !== 0) throw new Error(`cannot read PR #${number}: ${response.stderr}`);
      const pr = PullMetadata.parse(JSON.parse(response.stdout) as unknown);
      return {
        repo: input.repo,
        number: pr.number,
        state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
        isDraft: pr.draft,
        author: { login: pr.user?.login ?? '', type: pr.user?.type ?? 'User' },
        headRepository: pr.head.repo?.full_name ?? '',
        headRefName: pr.head.ref,
        headOid: pr.head.sha,
        baseRefName: pr.base.ref,
      };
    };
    try {
      const repository = await gh(['repo', 'view', '--json', 'nameWithOwner']);
      if (
        repository.code !== 0 ||
        RepositoryMetadata.parse(
          JSON.parse(repository.stdout) as unknown,
        ).nameWithOwner.toLowerCase() !== input.repo.toLowerCase()
      )
        return { status: 'needs-human', reason: 'repoRoot remote does not match requested repo' };
      let numbers = input.pulls ?? [];
      if (input.query !== undefined) {
        try {
          numbers = [];
          const response = await gh([
            'api',
            '--paginate',
            '--slurp',
            '-X',
            'GET',
            'search/issues',
            '-f',
            `q=repo:${input.repo} is:pr ${input.query}`,
            '-f',
            'per_page=100',
          ]);
          if (response.code !== 0) return { status: 'needs-human', reason: 'PR discovery failed' };
          const parsed = z
            .array(
              z.object({
                total_count: z.number().int().nonnegative(),
                incomplete_results: z.boolean(),
                items: z.array(
                  z.object({
                    number: z.number().int().positive(),
                    repository_url: z.string(),
                    pull_request: z.object({ url: z.string() }),
                  }),
                ),
              }),
            )
            .min(1)
            .safeParse(JSON.parse(response.stdout) as unknown);
          if (!parsed.success)
            return { status: 'needs-human', reason: 'Invalid PR discovery response' };
          const total = parsed.data[0]!.total_count;
          for (const data of parsed.data) {
            if (data.incomplete_results || data.total_count > 1000 || data.total_count !== total)
              return { status: 'needs-human', reason: 'Incomplete or truncated PR discovery' };
            if (
              data.items.some(
                (item) =>
                  item.repository_url.toLowerCase() !==
                  `https://api.github.com/repos/${input.repo}`.toLowerCase(),
              )
            )
              return { status: 'needs-human', reason: 'Query returned another repository' };
            numbers.push(...data.items.map((item) => item.number));
          }
          if (numbers.length !== total || new Set(numbers).size !== total)
            return { status: 'needs-human', reason: 'Incomplete PR discovery pagination' };
        } catch (error) {
          return { status: 'needs-human', reason: `PR discovery failed: ${String(error)}` };
        }
      }
      if (input.enrollments?.some((row) => !numbers.includes(row.number)))
        return { status: 'needs-human', reason: 'Enrollment outside selection' };
      if (
        Object.keys(input.dependencyRoots ?? {}).some((number) => !numbers.includes(Number(number)))
      )
        return { status: 'needs-human', reason: 'Prepared dependency root outside PR selection' };
      const listed: Array<AddressManyPrFacts & { baseRefName: string }> = [];
      let cursor = 0;
      const reads = await Promise.allSettled(
        Array.from({ length: Math.min(8, numbers.length) }, async () => {
          while (cursor < numbers.length) listed.push(await facts(numbers[cursor++]!));
        }),
      );
      if (reads.some((r) => r.status === 'rejected'))
        return { status: 'needs-human', reason: 'PR facts enumeration failed; no legs dispatched' };
      const selection = selectAddressMany(
        { repo: input.repo, complete: true, pulls: listed },
        { repo: input.repo, owner: input.owner },
      );
      if (!selection.ok)
        return { status: 'needs-human', reason: JSON.stringify(selection.refusal) };
      if (!selection.candidates.length)
        return { status: 'needs-human', reason: 'No eligible PRs in selection' };
      const run = promisify(execFile);
      const sshCommand = await resolveCoreSshCommand(input.repoRoot);
      const git = (file: string, args: string[]) => run(file, args, gitSubprocess(sshCommand));
      const coordinationRoot =
        deps.coordinationRoot ??
        (await realpath(
          (
            await git('git', [
              '-C',
              input.repoRoot,
              'rev-parse',
              '--path-format=absolute',
              '--git-common-dir',
            ])
          ).stdout.trim(),
        ));
      const cloneRoot = input.cloneRoot ?? resolve(coordinationRoot, 'cq-address-many-clones');
      let address = deps.address;
      if (!address) {
        const parsed = parseCqConfig(
          await readFile(resolve(input.repoRoot, 'cq.json'), 'utf8'),
          input.repoRoot,
        );
        if (!parsed.ok) return { status: 'needs-human', reason: parsed.reason };
        const config = parsed.config;
        // Bulk fixes use agent review and existing threads; vendor debt is advisory.
        config.review = { ...config.review, reviewers: ['agent'] };
        address = makeReviewAddress({
          config,
          coordinationRoot,
          ...(deps.managedSubmit ? { managedSubmit: deps.managedSubmit } : {}),
          ...(deps.drivers === undefined ? {} : { drivers: deps.drivers }),
        });
      }
      let budget = initialAddressManyBudget({ limitTokens: input.maxTokens });
      const outcomes: AddressManyOutcomeInput[] = [];
      const pending = [...selection.candidates];
      const faults: string[] = [];
      const preservedClones: Array<{ number: number; path: string }> = [];
      const forgetPreservedClone = (path: string) => {
        const index = preservedClones.findIndex((entry) => entry.path === path);
        if (index >= 0) preservedClones.splice(index, 1);
      };
      const requestedEnrollment = (number: number): AddressManyEnrollment =>
        input.enrollments?.some((r) => r.number === number)
          ? { state: 'unavailable', reason: 'Requested but leg not dispatched' }
          : { state: 'not-requested' };
      const worker = async () => {
        while (pending.length) {
          const candidate = pending.shift()!;
          const baseRefName = listed.find((item) => item.number === candidate.number)!.baseRefName;
          const identity = {
            id: String(candidate.number),
            repo: input.repo,
            number: candidate.number,
            headOid: candidate.headOid,
          };
          const admission = admitAddressMany(budget, { ...identity, tokens: input.tokensPerPr });
          if (admission.kind !== 'admitted') {
            if (admission.reason === 'over-limit' && budget.outstanding.length > 0) {
              pending.unshift(candidate);
              return;
            }
            outcomes.push({
              number: candidate.number,
              headOid: candidate.headOid,
              notAdmitted: 'budget',
              enrollment: requestedEnrollment(candidate.number),
            });
            continue;
          }
          budget = admission.state;
          let enteredCheckout = false;
          try {
            await withAddressManyCheckout(
              { commonDir: coordinationRoot, pr: candidate.number },
              async (lifetime) => {
                enteredCheckout = true;
                let result: ReviewAddressResult | undefined;
                let dispatched = false;
                let enrollment: AddressManyEnrollment = requestedEnrollment(candidate.number);
                let isolatedRoot: string | undefined;
                try {
                  const root = deps.isolate
                    ? await deps.isolate(input.repoRoot, candidate.number, {
                        cloneRoot,
                        target: baseRefName,
                      })
                    : await isolateAddressMany(input.repoRoot, candidate.number, {
                        cloneRoot,
                        target: baseRefName,
                        onPartial: (path) => {
                          isolatedRoot = path;
                          preservedClones.push({ number: candidate.number, path });
                        },
                      });
                  isolatedRoot = root;
                  if (!preservedClones.some((entry) => entry.path === root))
                    preservedClones.push({ number: candidate.number, path: root });
                  if (!deps.isolate) {
                    const checked = await makeGhRunner({
                      cwd: root,
                      unsetEnv: ['GH_REPO'],
                      timeoutMs: 30_000,
                    })(['repo', 'view', '--json', 'nameWithOwner']);
                    if (
                      checked.code !== 0 ||
                      RepositoryMetadata.parse(
                        JSON.parse(checked.stdout) as unknown,
                      ).nameWithOwner.toLowerCase() !== input.repo.toLowerCase()
                    )
                      throw new Error('Isolated repository does not match requested repo');
                  }
                  const current = await facts(candidate.number);
                  const revalidated = selectAddressMany(
                    { repo: input.repo, complete: true, pulls: [current] },
                    { repo: input.repo, owner: input.owner },
                  );
                  if (
                    !revalidated.ok ||
                    !revalidated.candidates.length ||
                    current.headOid !== candidate.headOid ||
                    current.headRepository !== candidate.headRepository ||
                    current.headRefName !== candidate.headRefName ||
                    current.baseRefName !== baseRefName
                  ) {
                    result = {
                      status: 'needs-human',
                      reason: 'PR eligibility, head or base changed before dispatch',
                    };
                  } else {
                    const request = input.enrollments?.find(
                      (row) => row.number === candidate.number,
                    )?.request;
                    if (request) {
                      try {
                        if (request.action && request.action !== 'enqueue')
                          throw new Error('Enrollment requires enqueue action');
                        if (
                          request.binding.kind !== 'deferred-author' ||
                          request.binding.repo.toLowerCase() !== input.repo.toLowerCase() ||
                          request.binding.head !== candidate.headOid
                        )
                          throw new Error('Enrollment binding does not match admitted PR head');
                        const queued = await (deps.enqueue ?? makeQueueOps().enqueue)(request);
                        enrollment =
                          queued.status === 'ok' &&
                          queued.value.state !== 'unsupported' &&
                          queued.value.enqueued === true
                            ? { state: 'enrolled' }
                            : { state: 'unavailable', reason: JSON.stringify(queued) };
                      } catch (error) {
                        enrollment = { state: 'unavailable', reason: String(error) };
                      }
                    }
                    dispatched = true;
                    result = await address({
                      repoRoot: root,
                      source: `pr:${candidate.number}`,
                      target: baseRefName,
                      ...(input.dependencyRoots?.[String(candidate.number)] === undefined
                        ? {}
                        : {
                            dependencyRoot: resolve(
                              input.repoRoot,
                              input.dependencyRoots[String(candidate.number)]!,
                            ),
                          }),
                      expectedHead: candidate.headOid,
                      maxTokens: input.tokensPerPr,
                      ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
                      ...(input.wallMs === undefined ? {} : { wallMs: input.wallMs }),
                      ...(input.push === undefined ? {} : { push: input.push }),
                      journalDir: resolve(
                        coordinationRoot,
                        'cq-address-many-reports',
                        basename(dirname(root)),
                        String(candidate.number),
                      ),
                    });
                  }
                  outcomes.push({
                    number: candidate.number,
                    headOid: candidate.headOid,
                    result,
                    enrollment,
                  });
                } catch (error) {
                  if (error instanceof IsolationRefusal)
                    result = { status: 'needs-human', reason: error.message };
                  outcomes.push({
                    number: candidate.number,
                    headOid: candidate.headOid,
                    ...(result ? { result } : { exception: String(error) }),
                    enrollment,
                  });
                }
                const report = result?.status === 'ok' ? result.value : result?.report;
                const usage = report?.usage;
                // A measurement only counts as KNOWN when it survives normalization;
                // a malformed one (negative or non-integer tokens) is unmeasurable
                // telemetry, so the leg settles through the SAME unknown-usage path
                // as a dispatched leg without a measurement. The held reservation
                // settles as unresolved and is retained in outstanding at its full
                // allocation (never released, never refunded), the sticky
                // unknown-usage stop is set, and the raw value can never leak into
                // the ledger as a token total.
                const observation = usage
                  ? normalizeUsageObservation({
                      usage,
                      ...(report?.costUSD === undefined ? {} : { costUSD: report.costUSD }),
                    })
                  : undefined;
                const known = observation?.usage !== undefined && usage !== undefined;
                // Exit spend is recorded EXACTLY ONCE per admitted leg, at its
                // settlement point: the normalized observation when the settled
                // report carried a valid measurement, an explicit unknown observation
                // otherwise. A leg that settled without dispatching is also unknown:
                // it is not an invocation, so counting it as measured zero would
                // inflate knownCount. Not-admitted legs are never recorded, so a
                // refusal cannot invent spend. A telemetry failure degrades to
                // unknown and never replaces the leg's settlement.
                try {
                  record(identity.id, observation ?? {});
                } catch {
                  try {
                    record(identity.id, {});
                  } catch {
                    // The dispatch was already recorded; retain the first observation.
                  }
                }
                // A thrown settlement (ledger arithmetic leaving the safe range) is
                // folded into the same unknown-usage settlement path: the held
                // reservation settles as unresolved and is retained in outstanding
                // at its full allocation, the sticky stop is set, and
                // the fault is named — the leg can never skip settlement, and the
                // aggregate can never spuriously flip on a held allocation.
                // A thrown settlement and a refused known settlement are handled
                // DIFFERENTLY, deliberately: a refusal (individually safe
                // measurement whose honest total exceeds MAX_SAFE_INTEGER) leaves
                // the reservation `reserved` with stop: null, which holds only
                // while the ledger is not already stopped — the refused path
                // returns state unchanged, so a ledger already carrying a sticky
                // stop keeps it (state.stop ?? 'unknown-usage') — while a thrown
                // total becomes `unresolved` with the sticky unknown-usage stop. Do NOT
                // fold these paths; that would change behavior outside this lane.
                let settled: ReturnType<typeof settleAddressMany>;
                try {
                  settled = known
                    ? settleAddressMany(budget, {
                        ...identity,
                        usage: {
                          kind: 'known',
                          tokens:
                            usage.input +
                            usage.output +
                            usage.cacheRead +
                            usage.cacheWrite +
                            (usage.reasoning ?? 0),
                        },
                      })
                    : dispatched
                      ? settleAddressMany(budget, { ...identity, usage: { kind: 'unknown' } })
                      : // A leg refused before dispatch provably spent nothing through
                        // the provider, so its BUDGET settlement is measured zero (the
                        // ledger stays clean, needs-human stays needs-human); its
                        // ledger OBSERVATION above stays explicit unknown because a
                        // non-dispatch is not an invocation.
                        settleAddressMany(budget, {
                          ...identity,
                          usage: { kind: 'known', tokens: 0 },
                        });
                } catch (error) {
                  settled = settleAddressMany(budget, { ...identity, usage: { kind: 'unknown' } });
                  faults.push(
                    `PR #${candidate.number} settlement threw and was settled as unknown: ${String(error)}`,
                  );
                }
                budget = settled.state;
                if (settled.kind === 'refused')
                  faults.push(
                    `PR #${candidate.number} settlement refused: ${JSON.stringify(settled)}`,
                  );
                if (
                  isolatedRoot &&
                  !deps.isolate &&
                  (!dispatched || (result?.status === 'ok' && result.value.fixes.length === 0))
                ) {
                  try {
                    try {
                      await lstat(isolatedRoot);
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                      forgetPreservedClone(isolatedRoot);
                      return;
                    }
                    if (!(await lifetime.canRemove()))
                      throw new Error(`incomplete clone retained: ${isolatedRoot}`);
                    const metadata = await lifetime.metadata();
                    const target =
                      metadata?.state === 'bound' ? metadata.checkoutPath : isolatedRoot;
                    for (const root of new Set([isolatedRoot, target])) {
                      const clean = await checkoutWriterCommand('git', [
                        '-C',
                        root,
                        'status',
                        '--porcelain=v1',
                        '-z',
                        '--ignored',
                        '--untracked-files=all',
                      ]);
                      for (const entry of clean.stdout.split('\0').filter(Boolean)) {
                        if (
                          root === isolatedRoot &&
                          entry.slice(3).replace(/\/$/, '') === 'node_modules' &&
                          (await lstat(resolve(root, 'node_modules'))).isSymbolicLink() &&
                          (await realpath(resolve(root, 'node_modules'))) ===
                            (await realpath(resolve(input.repoRoot, 'node_modules')))
                        )
                          continue;
                        throw new Error(`dirty clone retained: ${root}`);
                      }
                    }
                    if (dispatched) {
                      const ahead = await checkoutWriterCommand('git', [
                        '-C',
                        target,
                        'rev-list',
                        '--count',
                        `refs/cq-review/pr-${candidate.number}..HEAD`,
                      ]);
                      if (ahead.stdout.trim() !== '0')
                        throw new Error(`unpublished clone work retained: ${target}`);
                    }
                    const refs = await checkoutWriterCommand('git', [
                      '-C',
                      isolatedRoot,
                      'for-each-ref',
                      '--format=%(refname)',
                      'refs/heads',
                    ]);
                    if (refs.stdout.split('\n').some((ref) => ref.includes('/failed/')))
                      throw new Error(`dirty or failed-attempt clone retained: ${isolatedRoot}`);
                    await lifetime.beforeRemove();
                    const canonicalRoot = await realpath(isolatedRoot);
                    await rm(dirname(canonicalRoot), { recursive: true, force: true });
                    await lifetime.removed(canonicalRoot);
                    forgetPreservedClone(isolatedRoot);
                  } catch (error) {
                    lifetime.retainIncomplete();
                    faults.push(`PR #${candidate.number} cleanup failed: ${String(error)}`);
                  }
                }
              },
            );
          } catch (error) {
            if (!enteredCheckout) {
              // A refused slot never dispatched a provider. Release its reserved
              // allocation so an unrelated PR can use the same sweep budget.
              budget = settleAddressMany(budget, {
                ...identity,
                usage: { kind: 'known', tokens: 0 },
              }).state;
            }
            const legacyRefusal = isAddressCheckoutIncomplete(error);
            if (!legacyRefusal)
              faults.push(`PR #${candidate.number} slot lifetime refused: ${String(error)}`);
            if (!outcomes.some((row) => row.number === candidate.number))
              outcomes.push({
                number: candidate.number,
                headOid: candidate.headOid,
                ...(legacyRefusal && error instanceof Error
                  ? { result: { status: 'needs-human' as const, reason: error.message } }
                  : { exception: String(error) }),
                enrollment: requestedEnrollment(candidate.number),
              });
          }
        }
      };
      const workers = await Promise.allSettled(
        Array.from(
          {
            length: Math.min(
              selection.candidates.length,
              resolveAddressManyConcurrency(input.concurrency),
            ),
          },
          worker,
        ),
      );
      for (const item of workers)
        if (item.status === 'rejected') faults.push(`Worker rejected: ${String(item.reason)}`);
      for (const candidate of selection.candidates) {
        if (!outcomes.some((row) => row.number === candidate.number))
          outcomes.push({
            number: candidate.number,
            headOid: candidate.headOid,
            exception: faults.length
              ? `Not dispatched after worker failure: ${faults.join('; ')}`
              : 'Worker failed before producing outcome',
            enrollment: requestedEnrollment(candidate.number),
          });
      }
      const rolled = aggregateAddressMany({
        repo: input.repo,
        budget,
        candidates: selection.candidates,
        outcomes,
      });
      if (!rolled.ok) return { status: 'failed', error: JSON.stringify(rolled.refusal) };
      const report = {
        ...rolled.aggregate,
        preservedClones,
        rows: rolled.aggregate.rows.map((row) =>
          row.status === 'not-admitted' && faults.length
            ? { ...row, detail: `Runtime faults: ${faults.join('; ')}` }
            : row,
        ),
        excluded: selection.excluded.map((row) => ({
          number: row.number,
          reason: row.exclusion.reason,
          enrollment: requestedEnrollment(row.number),
        })),
        ...(faults.length && rolled.aggregate.status === 'ok'
          ? { status: 'needs-human' as const }
          : {}),
        reasons: [
          ...rolled.aggregate.reasons,
          ...faults,
          ...rolled.aggregate.rows
            .filter((row) => row.status !== 'settled-ok')
            .map((row) => {
              const leg = row.result;
              let detail = row.reason ?? row.status;
              if (leg?.status === 'needs-human') detail = leg.reason;
              else if (leg?.status === 'failed') detail = leg.error;
              else if (leg?.status === 'indeterminate') detail = leg.detail;
              return `PR #${row.scope.number}: ${detail}`;
            }),
        ],
      };
      if (report.status === 'ok') return { status: 'ok' as const, value: report };
      if (report.status === 'failed')
        return { status: 'failed' as const, error: report.reasons.join('; '), report };
      if (report.status === 'indeterminate')
        return { status: 'indeterminate' as const, detail: report.reasons.join('; '), report };
      if (report.status === 'budget-exhausted')
        return { status: 'budget-exhausted' as const, report };
      return { status: 'needs-human' as const, reason: report.reasons.join('; '), report };
    } catch (error) {
      return { status: 'failed' as const, error: String(error) };
    }
  };
}
