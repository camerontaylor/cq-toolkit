// Self-host swap e2e (lane H slice 1, goal H4): scripts/ratchet-typecheck.mjs
// is no longer a self-contained counter — it is a thin driver over the BUILT
// engine (dist/ops/ratchet). The old sandbox tests copied the script into a
// throwaway repo with a stub compiler; that design died with the placeholder,
// because the script now derives its engine from ITS OWN repo (ensureDist →
// loadEngine → registerAdapter → createCheckRatchet): self-hosting IS the
// point, so these tests exercise the script's real path at the real root —
// the same invocation ci.yml's 'Typecheck ratchet' step makes.
//
// Spawn-only by design (like the driver e2e suites): the .mjs driver and the
// dist engine are deliberately NOT imported into typechecked test code — a
// test file importing dist would make `tsc -p tsconfig.json` (noEmit)
// require a prior build, breaking the typecheck-before-build order.
// POSIX-only narration asserts (CI is linux; the win32 shell branch of the
// driver is exercised by neither this suite nor CI).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/ratchet-typecheck.mjs';
// The engine's deterministic baseline path for (target 'typecheck', metric
// 'typecheck-count') — format.ts's digest, asserted end-to-end here.
const BASELINE_REL = 'baselines/typecheck--typecheck-count--7caef1e76077.json';

function runTypecheckScript() {
  return spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
}

function outputOf(res: { stdout: string; stderr: string }): string {
  return `${res.stdout}${res.stderr}`;
}

describe('ratchet-typecheck (self-host swap): the driver over the built engine', () => {
  it(
    'clean tree: the engine verdict passes and names the baseline file',
    { timeout: 180_000 },
    () => {
      const res = runTypecheckScript();
      expect(res.status, outputOf(res)).toBe(0);
      // Narration on stderr, exit contract on the process: the pass line
      // names the ENGINE-owned baseline path and the compared values.
      expect(res.stderr).toContain('ratchet-typecheck: pass');
      expect(res.stderr).toContain(BASELINE_REL);
      expect(res.stderr).toContain('0 error(s) <= baseline 0');
    },
  );

  it(
    'a loosened baseline fails the run naming file and metric; the file is restored byte-for-byte',
    { timeout: 180_000 },
    () => {
      const baselinePath = join(ROOT, BASELINE_REL);
      const original = readFileSync(baselinePath, 'utf8');
      try {
        // Hand-loosen the committed evidence (schema-valid, value moved in
        // the loosening direction for lower-is-better: only a baseline BELOW
        // the current reading 0 can loosen past it). The engine — not the
        // driver — must catch it: verdict fail with the identity and both
        // values named.
        const loosened = JSON.parse(original) as Record<string, unknown>;
        loosened['value'] = -1;
        writeFileSync(baselinePath, `${JSON.stringify(loosened, null, 2)}\n`);
        const res = runTypecheckScript();
        expect(res.status, outputOf(res)).toBe(1);
        expect(res.stderr).toContain('FAIL');
        expect(res.stderr).toContain(BASELINE_REL);
        expect(res.stderr).toContain("'typecheck-count'");
        expect(res.stderr).toContain('loosened: baseline -1 → current 0');
        expect(res.stderr).toContain('only tightening passes');
      } finally {
        writeFileSync(baselinePath, original);
      }
      expect(
        readFileSync(baselinePath, 'utf8'),
        'the baseline must be restored byte-for-byte',
      ).toBe(original);
    },
  );

  it(
    'the driver builds what it consumes: loadEngine wires dist, registry, adapters, evidence',
    { timeout: 180_000 },
    () => {
      // The fixture is plain .mjs run by node: it imports the REAL
      // scripts/ratchet-lib.mjs (build → import dist → register → classify)
      // and exits nonzero with the diff on stderr on any failed expectation.
      const res = spawnSync(process.execPath, ['test/fixtures/ratchet-lib-selfhost.mjs'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(res.status, outputOf(res)).toBe(0);
      expect(res.stderr).toContain('ratchet-lib-selfhost: ok');
    },
  );

  it(
    'ratchet-propose: a tokenless run is the gate — skip message, exit 0, nothing measured',
    { timeout: 60_000 },
    () => {
      // The propose workflow has NO job-level if (the env context is
      // unavailable at job-if evaluation): the SCRIPT is the token gate. It
      // must exit 0 with the skip narration BEFORE any build/measurement —
      // a tokenless runner is a green no-op, never a red run. The token is
      // scrubbed from the env so a developer's local export cannot flip this
      // into the effects path (which additionally refuses dirty worktrees).
      const env = { ...process.env };
      delete env.CQ_AUTOMATION_TOKEN;
      const res = spawnSync(process.execPath, ['scripts/ratchet-propose.mjs'], {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      });
      expect(res.status, outputOf(res)).toBe(0);
      expect(res.stderr).toContain('CQ_AUTOMATION_TOKEN not set; skipping proposal');
    },
  );
});
