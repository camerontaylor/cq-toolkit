// smoke-only op — proves the FROM-SOURCE path: the built CLI's registry
// resolves this fixture family via --ops-root, the governed composition
// drives a REAL SubprocessDriver spawning the fake agent CLI child
// (test/fixtures/fake-agent-cli.mjs — the same stream-json fixture the
// subprocess conformance suite drives) through the driver's `binary` config
// with its REAL spawn — no test overrides: the fixture is a real child
// process in a real workspace, only the model is fake (the default 'ok'
// completion, fixed usage {10,5,2,3}).
//
// This module replaces the old smoke's hand-wired child composition
// (scripts/smoke-run-plan.mjs used to wire SubprocessDriver + this op +
// governor + runPlan + emitReport by hand). What the CLI now owns, this
// module must NOT do: no runPlan, no emitReport, no governor — the built
// CLI's run-plan composes runPlan through governRegistry (I9), and the
// usage fold's evidence lives in the guards below (see the smoke header).
//
// Path depth (verified against the actual layout):
//   this file    = <repo>/test/fixtures/cli-smoke-ops/smoke/agent-run.js
//   DIST         = <repo>/dist/index.js                 → 4 hops up
//   FAKE_CLI     = <repo>/test/fixtures/fake-agent-cli.mjs → 3 hops up

import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', '..', '..', 'dist', 'index.js');
const FAKE_CLI = join(HERE, '..', '..', 'fake-agent-cli.mjs');

const { SubprocessDriver, RoutingTableSchema, defaultRoutingTable, defaultHarnessConfig, currentJobContext } =
  await import(DIST); // top-level await — fine in ESM

// The input schema — the same shape registry.js declares for `agent-run`
// (the CLI validates with the registry's copy; the op re-parses its own).
const InputSchema = z.object({ jobId: z.string() }).strict();

// ONE driver at module load (lazy in practice: the CLI only imports this
// module when it dispatches `agent-run`). The routing table is CONFIG: the
// shipped default extended with the fixture endpoint (the subprocess test's
// conformance-table posture — the URL is a black hole; the fixture IS the
// model).
const scratchDir = await mkdtemp(join(tmpdir(), 'smoke-cli-ops-ws-'));
// Best-effort scratch cleanup: the mkdtemp dir above would otherwise leak
// per smoke run; 'exit' fires on every normal/failed exit of the CLI child
// (a hard-crashed process may skip it — hence best effort).
process.once('exit', () => {
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // best effort — cleanup must never break the op
  }
});
const routingTable = RoutingTableSchema.parse({
  endpoints: {
    ...defaultRoutingTable().endpoints,
    smoke: {
      baseUrlEnv: 'SMOKE_BASE_URL',
      baseUrlDefault: 'http://127.0.0.1:1/anthropic',
      keyEnv: 'SMOKE_API_KEY',
      models: ['smoke-1'],
      notes: 'T1.7 from-source smoke: the fake agent CLI is the model; the URL is never contacted',
    },
  },
});
const driver = new SubprocessDriver({
  binary: ['node', FAKE_CLI],
  routingTable,
  sessionsDir: join(scratchDir, 'sessions'),
  harnessConfig: { ...defaultHarnessConfig, workspaceRoot: join(scratchDir, 'workspaces') },
  // no `spawn` override — the REAL spawnManaged runs the fixture child
});

/**
 * The governed smoke op: delegate to the driver on the frozen seam, fold the
 * WorkerResult into the op-result taxonomy, report usage through the governed
 * job context. The served model id is the op's value — the remap-detection
 * fact. DEFAULT export (the family convention's op-module shape).
 */
export default async function agentRun(raw) {
  const { jobId } = InputSchema.parse(raw);
  const ctx = currentJobContext();
  // The CLI-boundary replacement for the old smoke's governor-rollup
  // assertion: run-plan composes runPlan through governRegistry, so a
  // dispatched op ALWAYS has a governed job context. `undefined` here means
  // the governRegistry wiring was dropped — refuse loudly (both jobs fail,
  // the parent sees exit 1) instead of silently skipping the reportUsage
  // fold: an ungoverned run must never look green.
  if (ctx === undefined) {
    return {
      status: 'failed',
      error: 'ungoverned: run-plan must compose runPlan through governRegistry — the usage fold has no observer',
    };
  }
  let result;
  try {
    result = await driver.run({
      prompt: `smoke job ${jobId}: reply with the word ok`,
      modelSpec: { provider: 'smoke', model: 'smoke-1' },
      toolPolicy: { allow: [], mode: 'none' },
      sandboxPolicy: { level: 'none' },
      budget: {},
    });
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  // The fixture contract guarantees usage on every result (fixed numbers): a
  // driver result WITHOUT it is exactly the regression this smoke must
  // catch, so it fails the job — never a silent skip of the reportUsage
  // fold.
  if (result.usage === undefined) {
    return {
      status: 'failed',
      error: 'driver result carries no usage — WorkerResult.usage reporting regressed (the fixture always reports fixed usage)',
    };
  }
  ctx.reportUsage(result.usage);
  if (result.stopReason === 'complete') return { status: 'ok', value: result.model ?? 'unreported' };
  return { status: 'failed', error: `agent run stopped: ${result.stopReason}` };
}
