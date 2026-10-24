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
import { DEV_LEDGER_VERSION } from '../dev/record.js';
import {
  makeGitleaksDefaultsScanner,
  makeRepoDiffScanner,
  composeScanners,
} from '../dev/denylist.js';
import { readWorkState } from '../dev/internal/workState.js';
import { runAgentReviewer } from './agentReviewer.js';
import { FindingsRecordSchema, merge, type FindingsRecord, type ReviewSource } from './findings.js';

export interface ReviewRunInput {
  repoRoot: string;
  uncommitted?: boolean;
}
export interface ReviewRunDeps {
  drivers: DriverFactory;
  effectsFactory?: (repoRoot: string) => DevEffects;
  scannerFactory?: (
    repoRoot: string,
    effects: DevEffects,
    patternsFile?: string,
  ) => DiffSecretScanner;
}

function blocked(kind: ReviewSource['kind'], reason: string): FindingsRecord {
  return {
    schemaVersion: 1,
    branch: '',
    head: '',
    sources: [{ kind, status: 'blocked', reason }],
    findings: [],
  };
}

/** Produce a single normalized record from the configured sources. */
export function makeReviewRun(deps: ReviewRunDeps): Op<ReviewRunInput, FindingsRecord> {
  return async (input): Promise<OpResult<FindingsRecord>> => {
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
    const policy = resolveCqConfigDefaults(parsedConfig.config, { packageName });
    const read = await readWorkState(effects, { target: 'merge-queue' });
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
      const result = await makeDevReview({ effects, scanSecrets: scanner })({
        repoRoot: input.repoRoot,
        reviewer: 'coderabbit',
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
        records.push({
          ...blocked(
            'coderabbit',
            result.status === 'needs-human'
              ? result.reason
              : 'CodeRabbit cycle did not produce a terminal record',
          ),
          branch: state.branch,
          head: state.head,
        });
      }
    }
    if (agentConfigured) {
      const budgetStop = requireAgenticTokenBudget(policy);
      if (budgetStop !== undefined) records.push(blocked('agent', budgetStop.reason));
      else {
        const diff = await effects.runCommand(
          'git',
          ['diff', '--no-ext-diff', ...(input.uncommitted ? [] : [state.base])],
          { timeoutMs: 60_000 },
        );
        if (diff.exitCode !== 0)
          records.push(
            blocked('agent', `could not collect review diff (exit ${String(diff.exitCode)})`),
          );
        else {
          const components = [{ component: 'review-diff', path: '.', text: diff.stdout }];
          for (const path of state.untracked) {
            const content = await effects.readWorktreeFile(path, 4 * 1024 * 1024);
            if (!content.ok)
              return {
                status: 'needs-human',
                reason: `review.run: untracked file '${path}' cannot be scanned — ${content.reason}`,
              };
            components.push({ component: `untracked:${path}`, path, text: content.text });
          }
          const check = await scanner(components);
          if (check.some((scan) => scan.hits.length > 0))
            return {
              status: 'needs-human',
              reason: 'review.run: denylist scan found protected content; refusing reviewer upload',
            };
          const current = await readWorkState(effects, { target: 'merge-queue' });
          if (
            !current.ok ||
            current.state.base !== state.base ||
            current.state.head !== state.head ||
            current.state.dirtySha256 !== state.dirtySha256
          ) {
            return {
              status: 'needs-human',
              reason: 'review.run: repository state changed after the scan; retry on a stable tree',
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
              diff: diff.stdout,
              role,
              maxTokens: policy.budgets.run.maxTokens!,
              severityMap: policy.review.agentSeverityMap,
            });
            if (agent.status === 'ok') {
              const at = effects.nowIso();
              const logPath = await effects.writeReviewLog(
                state.branch,
                `agent-${Date.now()}`,
                `agent reviewer: reviewer\nhead: ${state.head}\nfindings: ${agent.value.findings.length}\n`,
              );
              const terminal = await effects.openLedger(state.branch).mutate((ledger) => {
                const count = ledger.records.filter((entry) => entry.kind === 'cycle').length;
                const cycleId = `c${String(count + 1).padStart(3, '0')}-${state.head.slice(0, 8)}`;
                const entry = {
                  kind: 'cycle' as const,
                  cycleId,
                  reviewer: 'agent:reviewer',
                  scope: input.uncommitted ? ('uncommitted' as const) : ('full' as const),
                  target: 'merge-queue',
                  base: state.base,
                  head: state.head,
                  dirtySha256: state.dirtySha256,
                  completion: { kind: 'terminal' as const },
                  findings: agent.value.findings.map((finding, index) => ({
                    id: `${cycleId}#f${String(index + 1)}`,
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
                  value: cycleId,
                };
              });
              records.push({
                schemaVersion: 1,
                branch: state.branch,
                head: state.head,
                sources: [{ kind: 'agent', status: 'terminal', cycleId: terminal }],
                findings: agent.value.findings,
              });
            } else
              records.push(
                blocked(
                  'agent',
                  agent.status === 'needs-human'
                    ? agent.reason
                    : agent.status === 'failed'
                      ? agent.error
                      : agent.status,
                ),
              );
          }
        }
      }
    }
    const boundRecords = records.map((record) => ({
      ...record,
      branch: record.branch || state.branch,
      head: record.head || state.head,
    }));
    let record = merge(boundRecords);
    record = FindingsRecordSchema.parse(record);
    const folder = join(input.repoRoot, '.cq', 'review', encodeURIComponent(state.branch));
    await mkdir(folder, { recursive: true });
    const names = await readdir(folder);
    const indexes = names
      .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    const next = Math.max(0, ...indexes) + 1;
    const path = join(folder, `${next}.json`);
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { status: 'ok', value: record };
  };
}
