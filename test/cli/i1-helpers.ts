// Shared helpers for the split I1 CLI suites — moved verbatim from the
// test/cli/i1.test.ts preamble (pure move; each suite file imports this
// module so the afterEach tmp-dir cleanup registers per file, as before).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { runCli, type RunCliOptions } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/output.js';
import type { OpResult, RunReport } from '../../src/kernel/types.js';
export const opsRoot = fileURLToPath(new URL('../fixtures/cli-ops/', import.meta.url));

/** One captured CLI run: exit code plus the raw stdout/stderr strings. */
interface CapturedRun {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI over argv with a fake CliIo, returning {code, out, err}. */
export async function capture(argv: string[], opts?: RunCliOptions): Promise<CapturedRun> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io: CliIo = {
    stdout: (chunk) => outChunks.push(chunk),
    stderr: (chunk) => errChunks.push(chunk),
  };
  const code = await runCli(argv, io, opts);
  return { code, out: outChunks.join(''), err: errChunks.join('') };
}

/** All-six-states counts table, zeros included (frozen RunCounts shape). */
function countsFor(jobs: Array<OpResult<unknown>>): RunReport['counts'] {
  const counts: RunReport['counts'] = {
    queued: 0,
    running: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    'budget-exhausted': 0,
  };
  for (const result of jobs) {
    switch (result.status) {
      case 'ok':
        counts.done += 1;
        break;
      case 'needs-human':
        counts.blocked += 1;
        break;
      case 'budget-exhausted':
        counts['budget-exhausted'] += 1;
        break;
      case 'failed':
      case 'indeterminate':
      default:
        counts.failed += 1;
    }
  }
  return counts;
}

/** A minimal valid RunReport over the given row results. */
export function reportWith(...results: Array<OpResult<unknown>>): RunReport {
  return {
    runId: 'run-i1-unit',
    stoppedEarly: false,
    counts: countsFor(results),
    jobs: results.map((result, index) => ({ jobId: `j${index}`, op: `op-${index}`, result })),
  };
}

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

/** Fresh tmp dir (OS tmpdir — nothing in it needs module resolution), auto-cleaned. */
export async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Fresh tmp OPS ROOT under <repo>/node_modules (so a generated registry.js is
 * ESM via the repo's "type":"module" and can bare-import 'zod'), auto-cleaned.
 * Same pattern as test/cli/registry.test.ts.
 */
export async function makeTmpOpsRoot(prefix: string): Promise<string> {
  const parent = fileURLToPath(new URL('../../node_modules/', import.meta.url));
  const dir = await mkdtemp(join(parent, prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Write a plan file (and journal dir path) into a fresh tmp dir. */
export async function writePlanFile(
  plan: unknown,
): Promise<{ dir: string; planPath: string; journalDir: string }> {
  const dir = await makeTmpDir('cq-i1-plan-');
  const planPath = join(dir, 'plan.json');
  await writeFile(planPath, typeof plan === 'string' ? plan : JSON.stringify(plan));
  return { dir, planPath, journalDir: join(dir, 'journal') };
}

/** One single-job plan over the fixture ops. */
export function singleJobPlan(op: string): unknown {
  return { id: 'i1-plan', jobs: [{ id: 'a', op, input: op === 'echo' ? { msg: 'hi' } : {} }] };
}
