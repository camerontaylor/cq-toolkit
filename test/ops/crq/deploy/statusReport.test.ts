import { describe, expect, test } from 'vitest';
import { cmdStatus, type StatusDeps } from '../../../../src/ops/crq/deploy/statusReport.js';

const T = 'a'.repeat(40);
const P = 'b'.repeat(40);
function deps(over: {
  deploy?: unknown;
  head?: string;
  marker?: boolean;
  states?: Record<string, string>;
}): StatusDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loadDeploy: async () => over.deploy,
    liveHead: async () => (calls.push('head'), over.head ?? T),
    markerExists: async () => over.marker ?? false,
    units: { state: async (u) => (calls.push(`state ${u}`), over.states?.[u] ?? 'inactive') },
  };
}
const parse = (t: string): Record<string, unknown> => JSON.parse(t) as Record<string, unknown>;
const run = (d: StatusDeps) => cmdStatus({ runDir: '/runs/r1', root: '/r' }, d);
const done = {
  outcome: 'completed',
  target: T,
  prior_sha: P,
  final_triggers: { 'b.timer': 'active', 'a.timer': 'inactive' },
};

describe('cmdStatus', () => {
  test('a matching host reports ok with sorted live triggers and exit 0', async () => {
    const d = deps({ deploy: done, states: { 'b.timer': 'active' } });
    const r = await run(d);
    expect(r.code).toBe(0);
    expect(parse(r.output)).toEqual({
      operation: 'status',
      ok: true,
      outcome: 'completed',
      refusal: null,
      run_dir: '/runs/r1',
      expected_head: T,
      live_head: T,
      final_triggers: done.final_triggers,
      live_triggers: { 'a.timer': 'inactive', 'b.timer': 'active' },
    });
    expect(r.output.endsWith('}\n')).toBe(true);
    expect(r.output.indexOf('"expected_head"')).toBeLessThan(r.output.indexOf('"final_triggers"'));
    expect(d.calls).toEqual(['head', 'state a.timer', 'state b.timer']);
  });
  test('a rolled-back run expects the prior SHA', async () => {
    const r = await run(
      deps({
        deploy: { ...done, outcome: 'rolled_back' },
        head: P,
        states: { 'b.timer': 'active' },
      }),
    );
    expect(r.code).toBe(0);
    expect(parse(r.output).expected_head).toBe(P);
  });
  test('refusals, in precedence order: marker, HEAD, trigger map, drift', async () => {
    const m = await run(deps({ deploy: done, marker: true, head: P }));
    expect(parse(m.output).refusal).toBe('the admission marker is present: units are held');
    expect(m.code).toBe(1);
    const h = await run(deps({ deploy: done, head: P }));
    expect(parse(h.output).refusal).toBe(`live HEAD ${P} is not the recorded ${T}`);
    for (const final of [undefined, {}, ['x']]) {
      const n = await run(deps({ deploy: { ...done, final_triggers: final } }));
      expect(parse(n.output).refusal).toBe('record carries no trigger map to compare');
      expect(parse(n.output).live_triggers).toBeNull();
    }
    const dr = await run(deps({ deploy: done, states: { 'b.timer': 'failed' } }));
    expect(parse(dr.output).refusal).toBe(
      'live trigger state differs from the record: {"b.timer": {"live": "failed", "recorded": "active"}}',
    );
    expect(dr.code).toBe(1);
    expect(parse(dr.output).live_triggers).toEqual({
      'a.timer': 'inactive',
      'b.timer': 'failed',
    });
  });
  test('malformed records are refused before any git read', async () => {
    for (const [deploy, msg] of [
      [[], 'deploy.json must be a JSON object'],
      [{ outcome: 'started' }, "this run did not finish ('started'); it is not a released record"],
      [{ outcome: 'completed', target: 'abc' }, 'record does not name an expected HEAD'],
      [{ outcome: 'rolled_back', target: T }, 'record does not name an expected HEAD'],
      [{ outcome: 'completed', target: T.toUpperCase() }, 'record does not name an expected HEAD'],
    ] as const) {
      const d = deps({ deploy });
      await expect(run(d)).rejects.toThrow(msg);
      expect(d.calls).toEqual([]);
    }
  });
});
