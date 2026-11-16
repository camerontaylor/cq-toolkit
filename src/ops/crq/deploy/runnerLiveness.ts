/**
 * The runner-liveness probe the deploy controller hands to `drain_check`,
 * over an injected process seam.
 *
 * Ports `_RUNNER_PROBE`, `_runner_liveness` and `_refusing_liveness` from
 * `apps/crq-python/ops/deploy-controller.py`. Inactive and unimported: nothing
 * here spawns a process; the caller supplies the one effect that does.
 */

/** What the probe reports for one review item. */
export type LivenessState = 'alive' | 'ambiguous' | 'harvest';

const STATES: readonly unknown[] = ['alive', 'ambiguous', 'harvest'];

/**
 * The Python source run by `python -I -B -c <RUNNER_PROBE> <runner>`: it loads
 * the runner, reads one request from stdin and prints `run_liveness`'s JSON.
 * Byte-for-byte the Python `_RUNNER_PROBE`; a test pins it to the source.
 */
export const RUNNER_PROBE = `import importlib.util, json, sys
from pathlib import Path
runner = Path(sys.argv[1])
sys.path.insert(0, str(runner.parent))
spec = importlib.util.spec_from_file_location("crq", runner)
module = importlib.util.module_from_spec(spec)
sys.modules["crq"] = module
spec.loader.exec_module(module)
request = json.load(sys.stdin)
print(json.dumps(module.run_liveness(Path(request["rdir"]), request["item"],
                                    request["run"], request["has_exit"])))
`;

/** The runner source file, relative to the checkout root. */
export const RUNNER_RELPATH = 'apps/crq-python/crq.py';

/** The request the probe writes to the child's stdin (Python `json.dumps`ed). */
export interface ProbeRequest {
  readonly rdir: string;
  readonly item: unknown;
  readonly run: unknown;
  readonly has_exit: unknown;
}

export interface RunnerLivenessEffects {
  /** The checkout root (`effects.root`). */
  readonly root: string;
  /**
   * Run `python -I -B -c RUNNER_PROBE <runner>` with `request` on stdin and a
   * 30 s timeout. Throws on spawn failure, timeout or any other subprocess
   * error (Python `OSError`/`SubprocessError`); otherwise returns what ran.
   */
  runProbe(
    runner: string,
    request: ProbeRequest,
  ): Promise<{ readonly code: number; readonly stdout: string }>;
}

export type LivenessProbe = (
  rdir: string,
  item: unknown,
  run: unknown,
  hasExit: unknown,
) => Promise<LivenessState>;

/**
 * Python `_runner_liveness`: every failure (spawn, timeout, non-zero exit,
 * unparseable or unrecognised output) is "ambiguous", so a doubtful probe can
 * only block a deploy, never let one proceed.
 */
export function runnerLiveness(effects: RunnerLivenessEffects): LivenessProbe {
  const runner = `${effects.root}/${RUNNER_RELPATH}`;
  return async (rdir, item, run, hasExit) => {
    try {
      const result = await effects.runProbe(runner, { rdir, item, run, has_exit: hasExit });
      if (result.code !== 0) return 'ambiguous';
      const state: unknown = JSON.parse(result.stdout);
      return STATES.includes(state) ? (state as LivenessState) : 'ambiguous';
    } catch {
      return 'ambiguous';
    }
  };
}

/** Python `_refusing_liveness`: a probe that never proves anything alive or dead. */
export function refusingLiveness(): Promise<LivenessState> {
  return Promise.resolve('ambiguous');
}
