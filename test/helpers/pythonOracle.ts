import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DRIVER = fileURLToPath(new URL('./pythonOracle.py', import.meta.url));
const CRQ_PYTHON = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));

export type OracleOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** True when a `python3` that can import the crq modules is on PATH. */
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
  return probe.status === 0;
}

/** Run one pure Python function over every case in a single subprocess. */
export function runOracle(op: string, cases: readonly unknown[] | string): OracleOutcome[] {
  const run = spawnSync('python3', ['-I', DRIVER, CRQ_PYTHON], {
    // A string is the cases' JSON text, passed through so int/float lexemes survive.
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
