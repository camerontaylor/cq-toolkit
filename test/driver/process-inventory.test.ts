import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { allTestFiles, documentedProcessTestFiles } from '../../scripts/lib/test-lanes.mjs';

/**
 * Known process entry points only. This guard cannot discover a new helper
 * that launches a process transitively; the inventory is a conscious review
 * list, not a complete dynamic process detector.
 */
const PROCESS_ENTRY_POINTS = [
  /^import(?!\s+type\b)[^;]*from ['"](node:)?child_process['"]/m,
  /\bspawnAcpProcess\s*\(/,
  /\bspawnManaged\s*\(/,
  // The src spawn-effect factories (git, gh, check probes), and the merge
  // op's real effects over makeGhRunner.
  /\bmakeSubprocess\w*(?:Effects|Deps)\s*\(/,
  /\bmakeGhRunner\s*\(/,
  /\bmakeCheckRunner\s*\(/,
  /\brealMergeEffects\s*\(/,
  // The harness tool set, whose `run` tool executes through the shell, and
  // the in-process drivers that hand it to the model.
  /\bbuildTools\s*\(/,
  /\bnew (?:ClaudeAgentDriver|AiSdkDriver)\s*\(/,
  /\bgenerateScratchRepo\s*\(/,
  /\bcreateGitTemplate\s*\(/,
  /\brunSweepPlan\s*\(/,
] as const;

/**
 * Process-backed files a SPAWN TRACE found that no entry-point pattern can
 * name without also catching files that never spawn. Each needs its reason;
 * the documented inventory is the scan plus this list.
 */
const TRACED_PROCESS_FILES: Readonly<Record<string, string>> = {
  // The analyze registry's default importers run an ast-grep shim and a
  // node verifier through the real runner.
  'test/ops/analyze/registry.test.ts': 'analyze registry default runner',
};

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every discovered test file (the lanes' universe) that calls a known entry point. */
async function processBackedTestFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const file of allTestFiles(REPOSITORY_ROOT)) {
    const source = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
    if (PROCESS_ENTRY_POINTS.some((pattern) => pattern.test(source))) files.push(file);
  }
  return files;
}

describe('real-process inventory', () => {
  test('the documented process-backed test list matches the known entry points plus the traced files', async () => {
    const scanned = await processBackedTestFiles();
    const traced = Object.keys(TRACED_PROCESS_FILES);
    // A traced file the scan already names is a stale entry — drop it.
    expect(traced.filter((file) => scanned.includes(file))).toEqual([]);
    expect([...scanned, ...traced].sort()).toEqual(documentedProcessTestFiles(REPOSITORY_ROOT));
  });
});
