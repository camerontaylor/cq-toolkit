// The fixture deployment's `sweep.unit` op (the plans-smoke REAL
// sweep/test-fix instances, goal T4.3): the REAL unit composition from the
// BUILT package, bound through the fixture's DRIVER FACTORY (ADR-0002
// §2.5) — this module IS the deployment factory config the S4b-B2 migration
// requires: role 'fixer' + the fake provider → the subprocess lane over the
// fake sweep agent CLI, with the lane knobs (binary/routing table/sessions
// dir) living HERE in config, never in plan JSON. The factory owns the
// served-model assertion; the workspace binding (the unit's worktree) rides
// the invocation the op composes.
//
// Path depth (verified against the actual layout):
//   this file  = <repo>/test/fixtures/cli-smoke-ops/sweepfix/unit.js
//   DIST       = <repo>/dist/index.js                  → 4 hops up
//   SWEEP_AGENT = <repo>/test/fixtures/scratch-repo/sweep-agent.mjs → 2 hops up
//
// The fixture route's key VALUE comes from the caller's env (fake — the URL
// is a black hole; the fake sweep agent IS the model), read by the lane at
// dispatch time. The sessions dir is where the fixture factory lane writes
// the fresh session records (retention 'keep' — worker evidence); the smoke
// asserts from it that the fake agent genuinely spawned, so the caller MUST
// name it: CQ_SWEEP_FIXTURE_SESSIONS_DIR.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', '..', '..', 'dist', 'index.js');
const SWEEP_AGENT = join(HERE, '..', '..', 'scratch-repo', 'sweep-agent.mjs');

if (!existsSync(SWEEP_AGENT)) {
  throw new Error(`sweepfix fixture: the fake sweep agent is missing at '${SWEEP_AGENT}'`);
}

const sessionsDir = process.env.CQ_SWEEP_FIXTURE_SESSIONS_DIR;
if (typeof sessionsDir !== 'string' || sessionsDir === '') {
  throw new Error(
    "sweepfix fixture: CQ_SWEEP_FIXTURE_SESSIONS_DIR must name the factory lane's sessions dir (the smoke asserts the fake agent's session records from it)",
  );
}

const { createDriverFactory, bindingsFromDispatch, makeSweepUnitOp } = await import(DIST); // top-level await — fine in ESM

const factory = createDriverFactory({
  bindings: { fixer: { 'cq-t43-smoke': 'subprocess' } },
  lanes: {
    subprocess: {
      binary: [process.execPath, SWEEP_AGENT],
      sessionsDir,
      routingTable: {
        endpoints: {
          'cq-t43-smoke': {
            baseUrlEnv: 'CQ_T43_SMOKE_URL',
            baseUrlDefault: 'http://127.0.0.1:9',
            keyEnv: 'CQ_T43_SMOKE_KEY',
            models: ['sweep-fake'],
            notes:
              'T4.3 real-plan smoke: the sweep agent fixture is the model; the URL is never contacted',
          },
        },
      },
    },
  },
});

export default async function sweepUnit(input) {
  // The dispatch seam validated the input against the registry's
  // SweepUnitDispatchInputSchema (imported from the same dist); the real
  // importer's shape — bindings per dispatch, then the composed op over the
  // unit fields.
  const unitOp = makeSweepUnitOp(bindingsFromDispatch(input, factory));
  return await unitOp(input);
}
