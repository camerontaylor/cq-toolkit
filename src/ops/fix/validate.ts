import type { FailureSet } from '../gates/checkRunner.js';
import { regressionGate } from '../gates/regressionGate.js';
import { hackDetector } from '../gates/hackDetector.js';
import { commitGate } from '../gates/commitGate.js';
import { classifyStagePaths } from '../sweep/stagePaths.js';

export type FixGate = 'related' | 'broader' | 'paths' | 'tamper' | 'commit';
export interface FixGateRecord {
  gate: FixGate;
  verdict: 'pass' | 'fail' | 'needs-human';
  wallMs: number;
  detail?: string;
}
export interface ValidationVerdict {
  verdict: 'pass' | 'fail' | 'needs-human';
  gates: FixGateRecord[];
  final?: FailureSet;
}
export interface ValidationInput {
  baseline: FailureSet;
  related: () => Promise<FailureSet>;
  /** Must check the exact staged tree in a base-owned checkout. */
  broader: () => Promise<FailureSet>;
  stagedPaths: readonly string[];
  diff: string;
  message: string;
  protectTests?: boolean;
  proposeOnly?: boolean;
  allowlist?: { patterns: string[] };
  /** Engine tasks require progress; review findings may preserve the failure count. */
  requireProgress?: boolean;
}

/** Shared protocol. Every verdict includes collected evidence; this function never commits. */
export async function validateFix(input: ValidationInput): Promise<ValidationVerdict> {
  const gates: FixGateRecord[] = [];
  let final: FailureSet | undefined;
  const finish = (verdict: ValidationVerdict['verdict']): ValidationVerdict => ({
    verdict,
    gates,
    ...(final === undefined ? {} : { final }),
  });
  const step = async (gate: FixGate, run: () => Promise<string | undefined>, human = false) => {
    const start = Date.now();
    try {
      const detail = await run();
      gates.push({
        gate,
        verdict: detail === undefined ? 'pass' : human ? 'needs-human' : 'fail',
        wallMs: Date.now() - start,
        ...(detail === undefined ? {} : { detail }),
      });
      return detail === undefined;
    } catch (error) {
      gates.push({ gate, verdict: 'fail', wallMs: Date.now() - start, detail: String(error) });
      return false;
    }
  };
  if (
    !(await step('related', async () => {
      const related = await input.related();
      return related.exitCode === 0 && related.failures.length === 0
        ? undefined
        : 'related check did not pass';
    }))
  )
    return finish('fail');
  if (
    !(await step('broader', async () => {
      final = await input.broader();
      const compared = await regressionGate({ base: input.baseline, final });
      if (compared.status !== 'ok') return `regression gate: ${compared.status}`;
      if (compared.value.verdict === 'regression') return 'novel failures or test-total regression';
      if (final.failures.length > input.baseline.failures.length) return 'failure count increased';
      if (input.requireProgress && final.failures.length >= input.baseline.failures.length)
        return 'no failure count reduction';
      return undefined;
    }))
  )
    return finish('fail');
  const paths = classifyStagePaths(
    input.stagedPaths,
    input.allowlist,
    input.proposeOnly,
    input.protectTests ?? false,
  );
  if (
    !(await step(
      'paths',
      async () => paths.message ?? undefined,
      paths.kind === 'protected' || paths.kind === 'propose-only',
    ))
  ) {
    return finish(
      paths.kind === 'protected' || paths.kind === 'propose-only' ? 'needs-human' : 'fail',
    );
  }
  if (
    !(await step('tamper', async () => {
      const result = await hackDetector({ diff: input.diff });
      return result.status !== 'ok'
        ? `tamper detector: ${result.status}`
        : result.value.length > 0
          ? JSON.stringify(result.value)
          : undefined;
    }))
  )
    return finish('fail');
  if (
    !(await step('commit', async () => {
      const result = await commitGate({ message: input.message });
      return result.status !== 'ok'
        ? `commit gate: ${result.status}`
        : result.value.ok
          ? undefined
          : JSON.stringify(result.value.violations);
    }))
  )
    return finish('fail');
  return finish('pass');
}
