import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriverFactory } from '../../driver/factory.js';
import type { Op, OpResult } from '../../kernel/types.js';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults, requireAgenticTokenBudget } from '../analyze/cqConfigDefaults.js';
import { makeDevReview } from '../dev/review.js';
import { makeSubprocessDevEffects } from '../dev/effects.js';
import type { DevEffects } from '../dev/effects.js';
import type { DiffSecretScanner } from '../dev/denylist.js';
import { DEV_LEDGER_VERSION, type DevCycleRecord } from '../dev/record.js';
import {
  makeGitleaksDefaultsScanner,
  makeRepoDiffScanner,
  composeScanners,
} from '../dev/denylist.js';
import { currentJobContext } from '../../kernel/governor.js';
import { startFixerDeadline } from '../sweep/internal/fixerBudget.js';
import { CLEAN_TREE, driftSince, readWorkState } from '../dev/internal/workState.js';
import { HARDENED_DIFF_FLAGS } from '../../shared/gitHarden.js';
import { runAgentReviewer } from './agentReviewer.js';
import {
  FindingsRecordSchema,
  isComplete,
  merge,
  type FindingsRecord,
  type ReviewSource,
} from './findings.js';

export interface ReviewRunInput {
  repoRoot: string;
  uncommitted?: boolean;
  target?: string;
  base?: string;
  maxTokens?: number;
  wallMs?: number;
  reviewers?: ('agent' | 'coderabbit')[];
}
export interface ReviewRunDeps {
  drivers: DriverFactory;
  parentSignal?: AbortSignal;
  effectsFactory?: (repoRoot: string) => DevEffects;
  writeFindingsRecord?: (path: string, content: string) => Promise<void>;
  /**
   * Observe a completed engine-owned ledger write inside this run, so the
   * caller can register the new bytes even when the review outcome is
   * blocked/failed (the write itself already succeeded under its own mutex).
   */
  noteLedgerWrite?: (branch: string, repoRoot: string) => Promise<void>;
  scannerFactory?: (
    repoRoot: string,
    effects: DevEffects,
    patternsFile?: string,
  ) => DiffSecretScanner;
}

function blocked(kind: ReviewSource['kind'], reason: string, cycleId?: string): FindingsRecord {
  return {
    schemaVersion: 1,
    branch: '',
    head: '',
    sources: [{ kind, status: 'blocked', reason, ...(cycleId ? { cycleId } : {}) }],
    findings: [],
  };
}

/** The review-log line naming extra finding keys the agent reviewer stripped (none → empty). */
function strippedLine(stripped: Readonly<Record<string, number>> | undefined): string {
  const entries = Object.entries(stripped ?? {});
  return entries.length === 0
    ? ''
    : `stripped extra finding keys: ${entries.map(([key, count]) => `${key}×${String(count)}`).join(', ')}\n`;
}

/** Produce a single normalized record from the configured sources. */
export function makeReviewRun(deps: ReviewRunDeps): Op<ReviewRunInput, FindingsRecord> {
  return async (input): Promise<OpResult<FindingsRecord>> => {
    const started = Date.now();
    const effects =
      deps.effectsFactory?.(input.repoRoot) ?? makeSubprocessDevEffects(input.repoRoot);
    const configText = await readFile(join(input.repoRoot, 'cq.json'), 'utf8').catch(() => null);
    if (configText === null)
      return { status: 'needs-human', reason: 'review.run: cq.json is required' };
    const parsedConfig = parseCqConfig(configText, input.repoRoot);
    if (!parsedConfig.ok)
      return { status: 'needs-human', reason: `review.run: ${parsedConfig.reason}` };
    const packageText = await readFile(join(input.repoRoot, 'package.json'), 'utf8').catch(
      () => '{}',
    );
    let packageName = 'repository';
    try {
      const value: unknown = JSON.parse(packageText);
      if (
        typeof value === 'object' &&
        value !== null &&
        'name' in value &&
        typeof value.name === 'string'
      )
        packageName = value.name;
    } catch {
      /* fallback is descriptive only */
    }
    const policy = resolveCqConfigDefaults(parsedConfig.config, {
      packageName,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.reviewers === undefined ? {} : { review: { reviewers: input.reviewers } }),
    });
    const wallMs = Math.min(policy.budgets.run.wallMs, input.wallMs ?? Infinity);
    const deadline = startFixerDeadline(
      deps.parentSignal ?? currentJobContext()?.signal,
      Math.max(0, wallMs - (Date.now() - started)),
    );
    const remainingWallMs = () => wallMs - (Date.now() - started);
    try {
      const target = input.target ?? 'merge-queue';
      const read = await readWorkState(effects, {
        target,
        ...(input.base ? { base: input.base } : {}),
      });
      if (!read.ok) return { status: 'needs-human', reason: `review.run: ${read.reason}` };
      const { state } = read;
      const scanner =
        deps.scannerFactory?.(input.repoRoot, effects, policy.review.denylistPatternsFile) ??
        (policy.review.denylistPatternsFile === undefined
          ? composeScanners(makeGitleaksDefaultsScanner(effects))
          : composeScanners(
              makeGitleaksDefaultsScanner(effects),
              makeRepoDiffScanner(input.repoRoot, policy.review.denylistPatternsFile),
            ));
      const coderabbitConfigured = policy.review.reviewers.includes('coderabbit');
      const agentConfigured = policy.review.reviewers.includes('agent');
      const records: FindingsRecord[] = [];
      if (coderabbitConfigured) {
        const result = await makeDevReview({
          effects,
          ...(deadline.signal ? { signal: deadline.signal } : {}),
          remainingWallMs,
          scanSecrets: scanner,
          ...(policy.review.denylistPatternsFile === undefined
            ? {}
            : { patternsFile: policy.review.denylistPatternsFile }),
        })({
          repoRoot: input.repoRoot,
          reviewer: 'coderabbit',
          target,
          base: state.base,
          ...(input.uncommitted === undefined ? {} : { uncommitted: input.uncommitted }),
        });
        if (result.status === 'ok') {
          const value = result.value as {
            cycleId: string;
            findings: Array<{ id: string; severity: string; fileName?: string; excerpt?: string }>;
          };
          records.push({
            schemaVersion: 1,
            branch: state.branch,
            head: state.head,
            sources: [{ kind: 'coderabbit', status: 'terminal', cycleId: value.cycleId }],
            findings: value.findings.map((item) => ({
              id: item.id,
              source: 'coderabbit',
              ...(item.fileName ? { file: item.fileName } : {}),
              severity: item.severity,
              text: item.excerpt ?? '',
              status: 'open',
            })),
          });
        } else {
          const reason =
            result.status === 'needs-human'
              ? result.reason
              : result.status === 'failed'
                ? result.error
                : result.status === 'indeterminate'
                  ? result.detail
                  : `CodeRabbit cycle did not produce a terminal record (${result.status})`;
          const cycleId = /review cycle (c\d+-[a-f0-9]+)/.exec(reason)?.[1];
          let cycle: DevCycleRecord | undefined;
          if (cycleId !== undefined) {
            try {
              cycle = effects
                .openLedger(state.branch)
                .load()
                .records.find(
                  (entry): entry is DevCycleRecord =>
                    entry.kind === 'cycle' &&
                    entry.cycleId === cycleId &&
                    entry.reviewer === 'coderabbit',
                );
            } catch (error) {
              return {
                status: 'indeterminate',
                detail: `review.run: blocked CodeRabbit cycle ${cycleId} was recorded but its findings could not be read — ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            // The blocked cycle's ledger bytes were still written by the
            // engine: let the caller register them before the refusal.
            try {
              await deps.noteLedgerWrite?.(state.branch, input.repoRoot);
            } catch {
              /* the review outcome below carries the block reason */
            }
          }
          records.push({
            schemaVersion: 1,
            branch: state.branch,
            head: state.head,
            sources: [
              {
                kind: 'coderabbit',
                status: 'blocked',
                reason,
                ...(cycle?.kind === 'cycle' ? { cycleId: cycle.cycleId } : {}),
              },
            ],
            findings:
              cycle?.kind === 'cycle'
                ? cycle.findings.map((item) => ({
                    id: item.id,
                    source: 'coderabbit',
                    ...(item.fileName ? { file: item.fileName } : {}),
                    severity: item.severity,
                    text: item.excerpt ?? '',
                    status: 'open' as const,
                  }))
                : [],
          });
        }
      }
      if (agentConfigured && (deadline.signal?.aborted || remainingWallMs() <= 0)) {
        records.push(blocked('agent', 'review cancelled or wall budget exhausted'));
      } else if (agentConfigured) {
        const budgetStop = requireAgenticTokenBudget(policy);
        if (budgetStop !== undefined) records.push(blocked('agent', budgetStop.reason));
        else {
          const comparison = input.uncommitted ? 'HEAD' : state.base;
          let listing;
          try {
            listing = await effects.runCommand(
              'git',
              ['diff', '--name-only', '-z', ...HARDENED_DIFF_FLAGS, comparison],
              {
                timeoutMs: Math.max(1, Math.min(60_000, remainingWallMs())),
                ...(deadline.signal ? { signal: deadline.signal } : {}),
              },
            );
          } catch (error) {
            return {
              status: 'failed',
              error: `review.run: could not collect review diff — ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          if (listing.exitCode !== 0)
            records.push(
              blocked(
                'agent',
                `could not list review diff paths (exit ${String(listing.exitCode)})`,
              ),
            );
          else {
            const components: { component: string; path: string; text: string }[] = [];
            let collectionFailure: string | undefined;
            for (const path of listing.stdout.split('\0').filter(Boolean)) {
              let patch;
              try {
                patch = await effects.runCommand(
                  'git',
                  ['diff', ...HARDENED_DIFF_FLAGS, comparison, '--', path],
                  {
                    timeoutMs: Math.max(1, Math.min(60_000, remainingWallMs())),
                    ...(deadline.signal ? { signal: deadline.signal } : {}),
                  },
                );
              } catch (error) {
                return {
                  status: 'failed',
                  error: `review.run: could not collect diff for '${path}' — ${error instanceof Error ? error.message : String(error)}`,
                };
              }
              if (patch.exitCode !== 0) {
                collectionFailure = `could not collect diff for '${path}' (exit ${String(patch.exitCode)})`;
                break;
              }
              components.push({ component: `tracked:${path}`, path, text: patch.stdout });
            }
            if (collectionFailure !== undefined) {
              records.push(blocked('agent', collectionFailure));
            } else {
              for (const path of state.untracked) {
                let content: Awaited<ReturnType<DevEffects['readWorktreeFile']>>;
                try {
                  content = await effects.readWorktreeFile(path, 4 * 1024 * 1024);
                } catch (error) {
                  return {
                    status: 'failed',
                    error: `review.run: could not read untracked file '${path}' for scanning — ${error instanceof Error ? error.message : String(error)}`,
                  };
                }
                if (!content.ok)
                  return {
                    status: 'needs-human',
                    reason: `review.run: untracked file '${path}' cannot be scanned — ${content.reason}`,
                  };
                components.push({ component: `untracked:${path}`, path, text: content.text });
              }
              let check;
              try {
                check = await scanner(components);
              } catch (error) {
                return {
                  status: 'needs-human',
                  reason: `review.run: denylist scan failed closed — ${error instanceof Error ? error.message : String(error)}`,
                };
              }
              if (check.some((scan) => scan.hits.length > 0))
                return {
                  status: 'needs-human',
                  reason:
                    'review.run: denylist scan found protected content; refusing reviewer upload',
                };
              const current = await readWorkState(effects, {
                target,
                ...(input.base ? { base: input.base } : {}),
              });
              if (
                !current.ok ||
                current.state.base !== state.base ||
                current.state.head !== state.head ||
                current.state.dirtySha256 !== state.dirtySha256
              ) {
                return {
                  status: 'needs-human',
                  reason:
                    'review.run: repository state changed after the scan; retry on a stable tree',
                };
              }
              const role = policy.roles.reviewer;
              if (role === undefined) {
                records.push(
                  blocked('agent', 'cq.json roles.reviewer is required for an agent review'),
                );
              } else {
                const agent = await runAgentReviewer(deps.drivers, {
                  repoRoot: input.repoRoot,
                  head: state.head,
                  branch: state.branch,
                  diff: components
                    .map((component) => `--- ${component.path} ---\n${component.text}`)
                    .join('\n'),
                  components,
                  base: input.uncommitted ? state.head : state.base,
                  scope: input.uncommitted ? 'uncommitted' : 'full',
                  scanSecrets: scanner,
                  role,
                  maxTokens: policy.budgets.run.maxTokens!,
                  wallMs: Math.max(1, remainingWallMs()),
                  stepWallMs: policy.budgets.step.wallMs,
                  ...(deadline.signal ? { signal: deadline.signal } : {}),
                  severityMap: policy.review.agentSeverityMap,
                });
                let blockedReason =
                  agent.status === 'needs-human'
                    ? agent.reason
                    : agent.status === 'failed'
                      ? agent.error
                      : agent.status === 'ok'
                        ? undefined
                        : `agent review did not complete (${agent.status})`;
                if ((await driftSince(effects, state)).length > 0)
                  blockedReason = 'repository state changed during agent review';
                const at = effects.nowIso();
                const report = agent.status === 'ok' ? agent.value : agent.report;
                const agentFindings = report?.findings ?? [];
                let logPath: string;
                try {
                  logPath = await effects.writeReviewLog(
                    state.branch,
                    `agent-${Date.now()}`,
                    `agent reviewer: reviewer\nhead: ${state.head}\ncompletion: ${blockedReason === undefined ? 'terminal' : `blocked — ${blockedReason}`}\nfindings: ${agentFindings.length}\ncoverage: ${JSON.stringify(report?.coverage)}\nusage: ${report?.usage ?? 0}\n${strippedLine(report?.strippedKeys)}`,
                  );
                } catch (error) {
                  return {
                    status: 'indeterminate',
                    detail: `review.run: agent review attempt was dispatched but its log outcome is uncertain — ${error instanceof Error ? error.message : String(error)}`,
                  };
                }
                let cycleId: string;
                try {
                  cycleId = await effects.openLedger(state.branch).mutate((ledger) => {
                    const count = ledger.records.filter((entry) => entry.kind === 'cycle').length;
                    const id = `c${String(count + 1).padStart(3, '0')}-${state.head.slice(0, 8)}`;
                    const entry: DevCycleRecord = {
                      kind: 'cycle',
                      cycleId: id,
                      reviewer: 'agent:reviewer',
                      scope: input.uncommitted ? 'uncommitted' : 'full',
                      target,
                      base: state.base,
                      head: state.head,
                      dirtySha256: state.dirtySha256,
                      completion:
                        blockedReason === undefined
                          ? { kind: 'terminal' }
                          : { kind: 'blocked', reason: blockedReason },
                      findings: agentFindings.map((finding, index) => ({
                        id: `${id}#f${String(index + 1)}`,
                        severity: finding.severity,
                        ...(finding.file ? { fileName: finding.file } : {}),
                        excerpt: finding.text,
                      })),
                      logPath,
                      untracked: state.untracked,
                      at,
                    };
                    return {
                      ledger: {
                        version: DEV_LEDGER_VERSION,
                        branch: ledger.branch,
                        records: [...ledger.records, entry],
                      },
                      value: id,
                    };
                  });
                  await deps.noteLedgerWrite?.(state.branch, input.repoRoot);
                } catch (error) {
                  return {
                    status: 'indeterminate',
                    detail: `review.run: agent review attempt was dispatched but its dev ledger outcome is uncertain — ${error instanceof Error ? error.message : String(error)}`,
                  };
                }
                if (agent.status === 'ok' && blockedReason === undefined) {
                  records.push({
                    schemaVersion: 1,
                    branch: state.branch,
                    head: state.head,
                    sources: [
                      {
                        kind: 'agent',
                        status: 'terminal',
                        cycleId,
                        coverage: agent.value.coverage,
                      },
                    ],
                    findings: agent.value.findings.map((finding, index) => ({
                      ...finding,
                      id: `${cycleId}#f${String(index + 1)}`,
                    })),
                  });
                } else {
                  const partial = blocked(
                    'agent',
                    blockedReason ?? 'agent review did not complete',
                    cycleId,
                  );
                  if (report) {
                    partial.findings = report.findings;
                    partial.sources[0]!.coverage = report.coverage;
                  }
                  records.push(partial);
                }
              }
            }
          }
        }
      }
      const stopped = () => deadline.signal?.aborted || remainingWallMs() <= 0;
      if (stopped()) {
        for (const item of records)
          item.sources = item.sources.map((source) => ({
            ...source,
            status: 'blocked',
            reason: 'review cancelled or wall budget exhausted',
          }));
      }
      // A full review can see uncommitted repairs. Restoring those bytes later
      // must not turn that review into clean proof about the unchanged HEAD.
      const reusableCleanProof =
        !stopped() &&
        state.dirtySha256 === CLEAN_TREE &&
        (await driftSince(effects, state)).length === 0;
      const boundRecords = records.map((record) => ({
        ...record,
        ...(reusableCleanProof
          ? {
              reviewed: {
                base: input.uncommitted ? state.head : state.base,
                scope: input.uncommitted ? ('uncommitted' as const) : ('full' as const),
              },
            }
          : {}),
        branch: record.branch || state.branch,
        head: record.head || state.head,
      }));
      let record: FindingsRecord;
      try {
        record = FindingsRecordSchema.parse(merge(boundRecords));
      } catch (error) {
        return {
          status: 'failed',
          error: `review.run: normalized findings record failed validation — ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const folder = join(input.repoRoot, '.cq', 'review', encodeURIComponent(state.branch));
      let names: string[];
      try {
        await mkdir(folder, { recursive: true });
        names = await readdir(folder);
      } catch (error) {
        return {
          status: 'failed',
          error: `review.run: could not prepare findings record storage — ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const indexes = names
        .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number);
      const next = Math.max(0, ...indexes) + 1;
      const path = join(folder, `${next}.json`);
      try {
        const content = `${JSON.stringify(record, null, 2)}\n`;
        if (deps.writeFindingsRecord !== undefined) await deps.writeFindingsRecord(path, content);
        else await writeFile(path, content, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        return {
          status: 'indeterminate',
          detail: `review.run: findings record write outcome is uncertain at '${path}' — ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (stopped() || !isComplete(record, policy.review.reviewers)) {
        return {
          status: 'needs-human',
          reason:
            'review.run: not every configured reviewer completed a terminal cycle; the findings record, including partial findings, was persisted',
        };
      }
      return { status: 'ok', value: record };
    } finally {
      deadline.dispose();
    }
  };
}
