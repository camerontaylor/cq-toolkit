/** `cmd_status` from `apps/crq-python/ops/deploy-runbook.py`: does the host still match a
 * finished run's recorded outcome? File, git and unit reads are injected; the function
 * returns the exit code and the exact stdout instead of printing. Inactive.
 */
import { pythonJsonText, compareCodePoints } from '../../../policy/crq/pythonJson.js';
import { Refused, dumpSorted, type UnitControl } from './deployUnitSteps.js';

const SHA_RE = /^[0-9a-f]{40}$/;

export interface StatusDeps {
  /** `load_json(run_dir/deploy.json)`; raises Refused on unreadable or invalid JSON. */
  loadDeploy(runDir: string): Promise<unknown>;
  /** `git rev-parse HEAD` in the root; raises Refused on failure. */
  liveHead(root: string): Promise<string>;
  /** Whether the admission marker file exists. */
  markerExists(root: string): Promise<boolean>;
  units: Pick<UnitControl, 'state'>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Minimal Python repr for the refusal text (strings, None, bools, ints). */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    return q + v.replaceAll('\\', '\\\\').replaceAll(q, `\\${q}`).replaceAll('\n', '\\n') + q;
  }
  return String(v);
}

export async function cmdStatus(
  args: { runDir: string; root: string },
  deps: StatusDeps,
): Promise<{ code: 0 | 1; output: string }> {
  const deploy = await deps.loadDeploy(args.runDir);
  if (!isRecord(deploy)) throw new Refused('deploy.json must be a JSON object');
  const outcome = deploy['outcome'];
  if (outcome !== 'completed' && outcome !== 'rolled_back')
    throw new Refused(`this run did not finish (${pyRepr(outcome)}); it is not a released record`);
  const expected = outcome === 'completed' ? deploy['target'] : deploy['prior_sha'];
  if (typeof expected !== 'string' || !SHA_RE.test(expected))
    throw new Refused('record does not name an expected HEAD');
  const liveHead = await deps.liveHead(args.root);
  const final = deploy['final_triggers'] ?? null;
  let live: Record<string, string> | null = null;
  let refused: string | null = null;
  if (await deps.markerExists(args.root)) {
    refused = 'the admission marker is present: units are held';
  } else if (liveHead !== expected) {
    refused = `live HEAD ${liveHead} is not the recorded ${expected}`;
  } else if (!isRecord(final) || Object.keys(final).length === 0) {
    refused = 'record carries no trigger map to compare';
  } else {
    const entries: [string, string][] = [];
    for (const unit of Object.keys(final).sort(compareCodePoints))
      entries.push([unit, await deps.units.state(unit)]);
    live = Object.fromEntries(entries);
    const drifted = Object.fromEntries(
      entries
        .filter(([unit, state]) => final[unit] !== state)
        .map(([unit, state]) => [unit, { live: state, recorded: final[unit] ?? null }]),
    );
    if (Object.keys(drifted).length > 0)
      refused = `live trigger state differs from the record: ${dumpSorted(drifted)}`;
  }
  const output = pythonJsonText(
    {
      operation: 'status',
      ok: refused === null,
      outcome,
      refusal: refused,
      run_dir: args.runDir,
      expected_head: expected,
      live_head: liveHead,
      final_triggers: final,
      live_triggers: live,
    },
    { asciiOnly: true, sortKeys: true, keyOrder: 'code-point', indent: 2, trailingNewline: true },
  );
  return { code: refused === null ? 0 : 1, output };
}
