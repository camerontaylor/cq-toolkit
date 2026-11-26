import { spawnSync } from 'node:child_process';

/** Python 3.14 is production's minor: `python3.14` when present, else `python3` iff it is 3.14. */
export function oraclePython(): string {
  for (const name of ['python3.14', 'python3']) {
    const probe = spawnSync(name, ['-c', 'import sys; print(sys.version_info[:2] == (3, 14))'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && probe.stdout.trim() === 'True') return name;
  }
  throw new Error('the live oracle needs Python 3.14 (python3.14, or python3 at 3.14)');
}
