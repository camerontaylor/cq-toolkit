// ratchet-typecheck — the ci.yml 'Typecheck ratchet' step (self-host swap:
// lane H slice 1, goal H4). Same path, same CLI contract as the placeholder
// it replaces — exit 0 pass / 1 fail, human narration on stderr — but ALL
// the ratchet logic now lives in the BUILT engine (dist/ops/ratchet): this
// script runs the repo typecheck, hands the raw evidence to
// createCheckRatchet through a SourceCatalog, and reports the verdict as
// data. No counting, no comparing, no baseline writing here — thresholds
// only tighten, and the engine (loosens + the committed baseline file) owns
// that law.
//
// I5, carried over from the placeholder: a typecheck that exits nonzero with
// NO parsable error lines (missing node_modules, compiler panic, rejected
// flag) is non-passing evidence, never a pass — the tool output is echoed
// and we exit 1 BEFORE the engine ever sees a reading. A clean run (status
// 0) is fed as the adapter's authoritative object form ({count: 0}), where a
// structured zero is a real zero; an errored-but-parsable run is fed as the
// raw text the adapter counts. See scripts/ratchet-lib.mjs.
//
// The placeholder's --update flag is gone on purpose: baseline persistence
// is captureBaseline's job now (the engine), not this script's — a runner
// that could rewrite its own baseline would judge its own evidence.
import { fail, loadEngine, runTypecheckRaw, typecheckEvidence, ROOT } from './ratchet-lib.mjs';

// Build dist fresh, import the engine, register the metric. The registry is
// runtime-only composition wiring — the op input below carries ids only
// (CODEX P1), so this registration is exactly how the kernel would wire it.
const engine = await loadEngine();
engine.registerAdapter(engine.adapters.typecheckCount);

const run = runTypecheckRaw();
if (run.error) {
  fail(`cannot run typecheck: ${run.error.message}`);
}
const { evidence, rawText } = typecheckEvidence(engine.adapters.typecheckCount, run);
if (evidence === null) {
  fail(
    `typecheck exited ${run.status} with no parsable error lines — ` +
      'non-passing evidence, never a pass (I5) — tool output follows:\n' +
      rawText.trim(),
  );
}

// The op reads ONE live reading through the catalog and compares it against
// the committed baseline; every failure mode below lands on verdict 'fail'
// with a reason naming what failed — never a throw, never a fabricated pass.
const checkRatchet = engine.createCheckRatchet(
  new Map([['tsc', async () => evidence]]),
);
const result = await checkRatchet({
  ws: ROOT,
  target: 'typecheck',
  metric: 'typecheck-count',
  sourceId: 'tsc',
});
const outcome = result.value;

if (outcome.verdict !== 'pass') {
  console.error(`ratchet-typecheck: FAIL (${outcome.path})`);
  if (outcome.reason) console.error(outcome.reason);
  process.exit(1);
}
console.error(
  `ratchet-typecheck: pass — ${outcome.currentValue} error(s) <= baseline ` +
    `${outcome.baselineValue} (${outcome.path})`,
);
