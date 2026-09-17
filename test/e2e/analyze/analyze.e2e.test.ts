// G3 slice 3 — THE FLAGSHIP END-TO-END: the acceptance check run on a real
// fixture repo. A temp directory is seeded so REAL tsc reports three
// HOMOGENEOUS type errors (TS2551, same message shape, three files); then
// the full analyze chain runs with real binaries where they exist:
//
//   gates.checkRunner (real tsc, 'tsc-lines' adapter) → real FailureSet
//   → analyze.collectFailures → analyze.clusterErrors → ONE high-confidence
//   cluster → analyze.renderAnalysisReport (real sidecar on disk, parsed
//   back) → analyze.applyRemediation (cluster id + approved + the consumer
//   rule) → re-run tsc (clean) → gates.regressionGate → 'no-regression'.
//
// HONESTY ABOUT BINARIES (the acceptance contract): tsc always runs for
// real — via the typescript devDependency's own bin (no PATH dependence).
// The codemod leg runs on the REAL `ast-grep` binary when one is on PATH
// (vitest runIf; it exists on the dev machine, CI may lack it) and on a
// SCRIPTED runner otherwise that returns the correct ast-grep wire shape
// (match objects with byte `replacementOffsets`) for the SAME rule, reading
// the SAME bytes the engine reads. Both legs log which mode ran, and the
// scripted leg also runs deterministically everywhere as a second chain.
//
// The QUARANTINE lane runs in miniature at the end: a playbook whose
// verifier command fails gets quarantined at dispatch, and the second
// dispatch is refused before anything runs.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { CheckCommand, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import {
  makeCheckRunner,
  parseCheckOutput,
  subprocessRunCheck,
} from '../../../src/ops/gates/checkRunner.js';
import { tscLinesAdapter } from '../../../src/ops/gates/adapters/tsc.js';
import { regressionGate } from '../../../src/ops/gates/regressionGate.js';
import { pathAnalysisFileStore } from '../../../src/ops/analyze/analysisStore.js';
import { makeApplyRemediation } from '../../../src/ops/analyze/applyRemediation.js';
import { clusterErrorsOp } from '../../../src/ops/analyze/clusterErrors.js';
import { collectFailuresOp } from '../../../src/ops/analyze/collectFailures.js';
import {
  makeRenderAnalysisReport,
  parseAnalysisSidecar,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { Playbook } from '../../../src/ops/analyze/playbooks/format.js';
import {
  makePlaybookDispatchOp,
  makePlaybookRegistry,
} from '../../../src/ops/analyze/playbooks/registry.js';
import { makeQuarantineLedger } from '../../../src/ops/analyze/playbooks/quarantine.js';

/** The repo root (three levels up from this file) — for the vendored tsc bin. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The typescript devDependency's real compiler entry (no PATH dependence). */
const TSC_BIN = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** True when a real ast-grep binary answers on PATH (the real-binary leg). */
const AST_GREP_AVAILABLE = spawnSync('ast-grep', ['--version'], { stdio: 'ignore' }).status === 0;

/** The consumer's ast-grep rule (the seeded error shape's mechanical fix). */
const FIX_RULE = {
  id: 'fix-retry-typo',
  language: 'ts',
  rule: { pattern: 'config.retrles' },
  fix: 'config.retries',
};

/** The seeded fixture: three homogeneous TS2551 diagnostics, three files. */
const SEEDED_FILE = `interface RetryConfig {
  retries: number;
}

export function attempt(config: RetryConfig): number {
  return config.retrles;
}
`;

const SEEDED_FILES = ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts'];

/** The probe command: the REAL compiler over the fixture, pretty off (the tsc-lines wire). */
function tscCommand(dir: string): CheckCommand {
  return {
    command: process.execPath,
    args: [TSC_BIN, '--noEmit', '--pretty', 'false'],
    cwd: dir,
    timeoutMs: 120_000,
  };
}

/** Seed a temp fixture repo: one tsconfig plus the three seeded sources. */
async function seedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-e2e-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2020',
        module: 'commonjs',
        types: [],
      },
      include: ['src'],
    }),
    'utf8',
  );
  for (const file of SEEDED_FILES) {
    await writeFile(join(dir, file), SEEDED_FILE, 'utf8');
  }
  return dir;
}

/**
 * The scripted ast-grep runner: answers the engine's documented scan
 * command with the correct wire shape for the SAME rule (the rule text is
 * read out of the argv, not assumed), computing byte offsets against the
 * CURRENT bytes on disk. Exit 0, empty stderr, matches present — the exact
 * completed-scan shape the engine accepts.
 */
const scriptedAstGrepRunner: RunCheck = async (cmd) => {
  if (cmd.command !== 'ast-grep') {
    return subprocessRunCheck(cmd);
  }
  const ruleText = cmd.args[3] ?? '';
  const rule = JSON.parse(ruleText) as { rule?: { pattern?: string }; fix?: string };
  const pattern = rule.rule?.pattern ?? '';
  const replacement = rule.fix ?? '';
  const separator = cmd.args.indexOf('--');
  const targets = cmd.args.slice(separator + 1);
  const matches: object[] = [];
  for (const file of targets) {
    const bytes = await readFile(join(cmd.cwd ?? '.', file));
    let index = bytes.indexOf(Buffer.from(pattern, 'utf8'));
    while (index !== -1) {
      matches.push({
        file,
        ruleId: ruleText,
        severity: 'hint',
        replacement,
        replacementOffsets: { start: index, end: index + pattern.length },
      });
      index = bytes.indexOf(Buffer.from(pattern, 'utf8'), index + 1);
    }
  }
  return { stdout: JSON.stringify(matches), stderr: '', exitCode: 0 };
};

/** The runner a chain's codemod leg uses: real ast-grep when available. */
function codemodRunner(mode: 'real' | 'scripted'): RunCheck {
  if (mode === 'scripted') return scriptedAstGrepRunner;
  return subprocessRunCheck;
}

/**
 * The full acceptance chain over one seeded fixture, on the given codemod
 * leg. Asserts every stage; returns nothing (the assertions ARE the point).
 */
async function runAnalyzeChain(mode: 'real' | 'scripted'): Promise<void> {
  const engine =
    AST_GREP_AVAILABLE && mode === 'real'
      ? 'the REAL ast-grep binary'
      : 'the SCRIPTED ast-grep wire runner';
  console.log(`[e2e analyze:${mode}] codemod leg running on ${engine}`);
  const dir = await seedRepo();
  try {
    // 1. The probe: REAL tsc through the gates check runner → real FailureSet.
    const probe = makeCheckRunner(subprocessRunCheck);
    const baseline = await probe({ adapter: 'tsc-lines', command: tscCommand(dir) });
    expect(baseline.status).toBe('ok');
    if (baseline.status !== 'ok') return;
    expect(baseline.value.tool).toBe('tsc');
    expect(baseline.value.exitCode).not.toBe(0);
    expect(baseline.value.failures).toHaveLength(3);
    for (const failure of baseline.value.failures) {
      expect(failure.ruleId).toBe('TS2551');
      expect(failure.severity).toBe('error');
    }
    // The seeded errors are HOMOGENEOUS: identical after template
    // normalization (verified directly through the adapter's parse).
    const reParsed = parseCheckOutput(tscLinesAdapter, {
      stdout: baseline.value.failures
        .map(
          (failure) =>
            `${failure.file}(${failure.line},${failure.column}): error TS2551: ${failure.message}`,
        )
        .join('\n'),
      stderr: '',
      exitCode: 1,
    });
    expect(reParsed.verdict).toBe('parsed');

    // 2. Collect → cluster: exactly ONE high-confidence cluster.
    const collected = await collectFailuresOp({ sets: [baseline.value] });
    expect(collected.status).toBe('ok');
    if (collected.status !== 'ok') return;
    expect(collected.value.failures).toHaveLength(3);
    const clustered = await clusterErrorsOp({ set: collected.value });
    expect(clustered.status).toBe('ok');
    if (clustered.status !== 'ok') return;
    expect(clustered.value.clusters).toHaveLength(1);
    const cluster = clustered.value.clusters[0];
    expect(cluster?.confidence).toBe('high');
    expect(cluster?.size).toBe(3);
    expect(cluster?.ruleId).toBe('TS2551');
    expect(cluster?.failures).toHaveLength(3);

    // 3. The report op: a REAL sidecar on disk, parseable back.
    const render = makeRenderAnalysisReport((input) => pathAnalysisFileStore(input.dir));
    const rendered = await render({ report: clustered.value, dir });
    expect(rendered.status).toBe('ok');
    if (rendered.status !== 'ok') return;
    const sidecarText = await readFile(rendered.value.sidecarPath, 'utf8');
    const sidecar = parseAnalysisSidecar(sidecarText);
    expect(sidecar.report.clusters).toHaveLength(1);
    expect(sidecar.evidence).toHaveLength(1);
    expect(
      (await readFile(rendered.value.markdownPath, 'utf8')).startsWith('# Analysis report'),
    ).toBe(true);

    // 4. The remediation: applyRemediation with the cluster id, approval,
    // and the consumer rule — collision-checked, applied through the store.
    const apply = makeApplyRemediation(
      (input) => pathAnalysisFileStore(input.dir ?? dirname(input.sidecarPath)),
      codemodRunner(mode),
    );
    if (cluster === undefined) throw new Error('unreachable: the chain asserted one cluster');
    const applied = await apply({
      sidecarPath: rendered.value.sidecarPath,
      dir,
      clusterId: cluster.id,
      approved: true,
      rule: JSON.stringify(FIX_RULE),
      dryRun: false,
    });
    expect(applied.status).toBe('ok');
    if (applied.status !== 'ok') return;
    expect(applied.value.mode).toBe('applied');
    expect(applied.value.plannedEdits).toBe(3);
    expect(applied.value.files).toHaveLength(3);
    for (const file of applied.value.files) {
      expect(file.edits).toBe(1);
    }

    // 5. Re-run the REAL probe: clean.
    const final = await probe({ adapter: 'tsc-lines', command: tscCommand(dir) });
    expect(final.status).toBe('ok');
    if (final.status !== 'ok') return;
    expect(final.value.failures).toEqual([]);
    expect(final.value.exitCode).toBe(0);

    // 6. The regression gate: baseline vs final → GREEN.
    const gate = await regressionGate({ base: baseline.value, final: final.value });
    expect(gate.status).toBe('ok');
    if (gate.status !== 'ok') return;
    expect(gate.value.verdict).toBe('no-regression');
    expect(gate.value.novelFailures).toEqual([]);
    expect(gate.value.fixedFailures).toHaveLength(3);
    expect(gate.value.preExistingCount).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('end-to-end on a fixture repo (the acceptance check)', () => {
  test(
    'seeded homogeneous errors → one cluster → mechanical codemod → regressionGate green (scripted codemod leg)',
    { timeout: 180_000 },
    () => runAnalyzeChain('scripted'),
  );

  test.runIf(AST_GREP_AVAILABLE)(
    'seeded homogeneous errors → one cluster → mechanical codemod → regressionGate green (REAL ast-grep binary)',
    { timeout: 180_000 },
    () => runAnalyzeChain('real'),
  );
});

describe('the quarantine lane in miniature (end to end)', () => {
  test('a playbook whose verifier fails is quarantined; the second dispatch refuses', async () => {
    const engine = AST_GREP_AVAILABLE
      ? 'the REAL ast-grep binary'
      : 'the SCRIPTED ast-grep wire runner';
    console.log(`[e2e analyze:quarantine] codemod leg running on ${engine}`);
    const dir = await mkdtemp(join(tmpdir(), 'analyze-e2e-q-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'es2020',
            module: 'commonjs',
            types: [],
          },
          include: ['src'],
        }),
        'utf8',
      );
      await writeFile(join(dir, 'src', 'alpha.ts'), SEEDED_FILE, 'utf8');
      // The playbook: the RIGHT codemod rule, a verifier that FAILS —
      // proving the quarantine path, not the fix.
      const playbook: Playbook = {
        schemaVersion: 1,
        id: 'fix-retry-typo.playbook',
        description: 'fix the retry typo — miniature quarantine fixture',
        rule: FIX_RULE,
        verifier: {
          command: {
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
            timeoutMs: 30_000,
          },
        },
      };
      const playbooks = makePlaybookRegistry([playbook]);
      const quarantine = makeQuarantineLedger();
      // The codemod half rides the real binary when present (the verifier
      // always runs for real); the scripted runner covers the sandbox case.
      const run: RunCheck = (cmd) =>
        cmd.command === 'ast-grep' && !AST_GREP_AVAILABLE
          ? scriptedAstGrepRunner(cmd)
          : subprocessRunCheck(cmd);
      const dispatch = makePlaybookDispatchOp({
        playbooks,
        quarantine,
        run,
        storeFor: (input) => pathAnalysisFileStore(input.dir),
      });
      const input = { playbookId: playbook.id, dir, targets: ['src/alpha.ts'] };

      // First dispatch: remediation APPLIED, verifier FAILED, quarantined.
      const first = await dispatch(input);
      expect(first.status).toBe('ok');
      if (first.status !== 'ok') return;
      if (first.value.outcome !== 'verifier-failed') {
        throw new Error(`expected verifier-failed, got ${first.value.outcome}`);
      }
      expect(first.value.quarantined).toBe(true);
      expect(first.value.verifierReason).toContain('exited 1');
      expect(first.value.record.kind).toBe('playbook-dispatch');
      expect(first.value.record.quarantined).toBe(true);
      // The remediation WAS applied (the honest report) — and the ledger
      // now holds the phase-tagged record with the verifier's reason.
      expect(await readFile(join(dir, 'src', 'alpha.ts'), 'utf8')).toContain('config.retries');
      expect(quarantine.isQuarantined(playbook.id)).toBe(true);
      expect(quarantine.records()[0]?.phase).toBe('verifier-failed');
      expect(quarantine.reasonOf(playbook.id)).toBe(first.value.verifierReason);

      // Second dispatch: refused BEFORE anything runs.
      const second = await dispatch(input);
      expect(second.status).toBe('needs-human');
      if (second.status === 'needs-human') {
        expect(second.reason).toContain('never re-dispatched automatically');
        expect(second.reason).toContain('explicit consumer action');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
