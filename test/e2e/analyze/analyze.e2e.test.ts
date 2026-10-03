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
import type { ApprovalAuthority, ApprovalState } from '../../../src/ops/analyze/approval.js';
import {
  makeApprovalAuthority,
  makeInMemoryNonceLedger,
  makeProcessLocalMutationLocks,
} from '../../../src/ops/analyze/approval.js';
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

/**
 * W4.3 — the approval authority this e2e binds. A REAL `ApprovalAuthority`
 * (the same code the ops call) over an in-memory nonce ledger and
 * process-local locks, with the run's verified approvals answering for every
 * subject and a fixed workspace state. The state reader is fixed rather than
 * the real git one because the seeded temp tree is deliberately not a
 * repository; the state re-check, single-use nonce and the mutation lock are
 * the real code either way, and the TOCTOU/durability proofs over a REAL
 * repository live in test/ops/analyze/approval.test.ts.
 */
function e2eApprovalAuthority(): ApprovalAuthority {
  // The SIGNED state and the state READER must agree, or admission's drift
  // check refuses and the e2e cannot pass: the reader answers the SAME
  // workspace the verified seam signed. (The `''` placeholder this replaced
  // was harmless only while the seam carried a bare nonce; from the
  // signed-state contract onward it made every leg fail closed.)
  const stateFor = (workspace: string): ApprovalState => ({
    workspace,
    headSha: 'e2e-head',
    treeClean: true,
  });
  return makeApprovalAuthority({
    approvals: {
      verifiedFor: (subject) =>
        Promise.resolve({ nonce: `e2e-${subject.op}`, state: stateFor(subject.workspace) }),
    },
    ledger: makeInMemoryNonceLedger(),
    locks: makeProcessLocalMutationLocks(),
    readState: { read: (workspace: string) => Promise.resolve(stateFor(workspace)) },
  });
}

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
    // W4.3: the apply's write is gated on an approval GRANT, not on the
    // `approved: true` flag. This e2e composes the op the way a direct SDK
    // consumer does, so it binds a real authority (the registry adapter that
    // binds the kernel's verified approvals is #238's file and unchanged).
    const apply = makeApplyRemediation(
      (input) => pathAnalysisFileStore(input.dir ?? dirname(input.sidecarPath)),
      codemodRunner(mode),
      e2eApprovalAuthority(),
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

  test('ANALYZE_E2E_REQUIRE_REAL=1 enforcement: the real ast-grep binary must be installed', () => {
    // OPT-IN ENFORCEMENT GUARD for the real-binary acceptance half above:
    // that leg is runIf(available), so CI — which does not install
    // ast-grep — silently skips it. A CI job that INSTALLS ast-grep can set
    // ANALYZE_E2E_REQUIRE_REAL=1 to turn that silent skip into a loud
    // failure here. Setting the variable belongs in the CI job that
    // installs the binary; the workflows are lane-i-owned, so the variable
    // setup is deliberately NOT edited in this change (recorded for the
    // conductor's STATUS).
    if (process.env.ANALYZE_E2E_REQUIRE_REAL !== '1' || AST_GREP_AVAILABLE) {
      return; // not enforcing, or the binary IS present — nothing to guard
    }
    throw new Error(
      "ANALYZE_E2E_REQUIRE_REAL=1 but no 'ast-grep' binary is on PATH — the REAL-binary acceptance half (the end-to-end codemod on the real engine) is being silently skipped; install ast-grep in the CI job that sets this variable",
    );
  });
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
        approval: e2eApprovalAuthority(),
      });
      const input = { playbookId: playbook.id, dir, targets: ['src/alpha.ts'] };

      // First dispatch: remediation APPLIED, verifier FAILED, quarantined —
      // and (W4.3) the edits ROLLED BACK, so the dispatch is NOT `ok`.
      const before = await readFile(join(dir, 'src', 'alpha.ts'), 'utf8');
      const first = await dispatch(input);
      expect(first.status).toBe('failed');
      if (first.status !== 'failed') return;
      expect(first.error).toContain('the verifier FAILED');
      const marker = 'Dispatch evidence: ';
      const at = first.error.indexOf(marker);
      expect(at).toBeGreaterThanOrEqual(0);
      const evidence = JSON.parse(first.error.slice(at + marker.length)) as {
        outcome: string;
        quarantined: boolean;
        verifierReason: string;
        restore: { restored: string[]; stranded: unknown[] };
        record: { kind: string; quarantined: boolean };
      };
      expect(evidence.outcome).toBe('verifier-failed');
      expect(evidence.quarantined).toBe(true);
      expect(evidence.verifierReason).toContain('exited 1');
      expect(evidence.record.kind).toBe('playbook-dispatch');
      expect(evidence.record.quarantined).toBe(true);
      // STEP 5, over a REAL store and a REAL verifier: the failed
      // remediation is rolled back to the exact pre-dispatch bytes.
      expect(evidence.restore.restored).toEqual(['src/alpha.ts']);
      expect(evidence.restore.stranded).toEqual([]);
      expect(await readFile(join(dir, 'src', 'alpha.ts'), 'utf8')).toBe(before);
      expect(quarantine.isQuarantined(playbook.id)).toBe(true);
      expect(quarantine.records()[0]?.phase).toBe('verifier-failed');
      expect(quarantine.reasonOf(playbook.id)).toBe(evidence.verifierReason);

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
