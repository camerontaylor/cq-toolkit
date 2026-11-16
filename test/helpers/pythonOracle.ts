import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DRIVER = fileURLToPath(new URL('./pythonOracle.py', import.meta.url));
const CRQ_PYTHON = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));

export type OracleOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * True when a `python3` that can import the crq modules is on PATH.
 *
 * The ONLY skip is the structural absence the probe can confirm: no `python3`
 * on PATH (spawn ENOENT). Every other probe failure is a real one — a bundled
 * `crq`/`usage_slots` import that raises (a syntax error included) means the
 * repository is broken, not the host — so it throws with the probe's stderr
 * diagnostics instead of reporting the oracle as unavailable.
 */
export function pythonAvailable(): boolean {
  const probe = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import sys; sys.path.insert(0, sys.argv[1]); import crq, usage_slots',
      CRQ_PYTHON,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (probe.error !== undefined) {
    // The one structural absence this probe can confirm: no `python3` on PATH.
    if ((probe.error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`python oracle probe could not run python3: ${probe.error.message}`);
  }
  if (probe.status !== 0) {
    // A timeout kills the probe by signal; either way, its stderr is the datum.
    const how = probe.signal ? `signal ${probe.signal}` : `exit ${String(probe.status)}`;
    throw new Error(`python oracle probe failed (${how}): ${probe.stderr.slice(0, 500)}`);
  }
  return true;
}

/** Run one pure Python function over every case in a single subprocess. */
/** A string `cases` is raw JSON text, spliced in verbatim so int lexemes survive. */
export function runOracle(op: string, cases: readonly unknown[] | string): OracleOutcome[] {
  const run = spawnSync('python3', ['-I', DRIVER, CRQ_PYTHON], {
    input:
      typeof cases === 'string'
        ? `{"op":${JSON.stringify(op)},"cases":${cases}}`
        : JSON.stringify({ op, cases }),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`python oracle failed: ${run.stderr.slice(0, 500)}`);
  return JSON.parse(run.stdout) as OracleOutcome[];
}
