import { describe, expect, it } from 'vitest';
import { applyCorrelationEnv, paseoParentWorkId } from '../../src/driver/correlation-env.js';
import { buildChildEnv } from '../../src/shared/proc.js';
import type { WorkCorrelation } from '../../src/driver/types.js';

// Measurement M5b1 — correlate direct op parents. A DIRECT op invocation
// (no governed dispatch, no runner-minted correlation) must still link its
// child harness to the enclosing work: applyCorrelationEnv is the ONE
// shared driver boundary every SDK/ACP transport composes its child env
// through (the CLI's overrides-only composition is stamped at buildChildEnv
// time instead), so the Paseo parent derivation lives there (no
// src/cli/main.ts change,
// no second precedence implementation). All fixtures are local maps — the
// host environment cannot reach the derivation, because it reads ONLY the
// env passed in.

describe('M5b1 nominal evidence', () => {
  it('a direct invocation inside a Paseo agent derives paseo:<PASEO_AGENT_ID> as CQ_PARENT_WORK_ID at the shared driver boundary', () => {
    // The lane-composed child env: the raw agent id is never forwarded;
    // buildChildEnv translates it into the derived link at composition.
    const env = buildChildEnv(
      { PATH: '/bin', PASEO_AGENT_ID: '61f19a9d' },
      // The overrides map a lane composes (auth/base-url).
      { ANTHROPIC_BASE_URL: 'http://localhost:8080' },
    );
    expect('PASEO_AGENT_ID' in env).toBe(false);
    applyCorrelationEnv(env, undefined);
    expect(env['CQ_PARENT_WORK_ID']).toBe('paseo:61f19a9d');
    // The derivation links the child WITHOUT minting a work identity:
    // no CQ_WORK_ID, no run id, nothing invented beyond the parent link.
    expect(env['CQ_WORK_ID']).toBeUndefined();
    expect(env['CQ_RUN_ID']).toBeUndefined();
  });

  it('precedence: CQ_WORK_ID, then CQ_PARENT_WORK_ID, then Paseo — an explicit inherited identity is never clobbered', () => {
    // CQ_WORK_ID present: the child keeps its inherited identity AND its
    // inherited parent link untouched; the boundary invents nothing else.
    const withWork = applyCorrelationEnv(
      { PASEO_AGENT_ID: 'a1', CQ_PARENT_WORK_ID: 'outer-parent', CQ_WORK_ID: 'outer-run:w:1' },
      undefined,
    );
    expect(withWork['CQ_WORK_ID']).toBe('outer-run:w:1');
    expect(withWork['CQ_PARENT_WORK_ID']).toBe('outer-parent');
    // CQ_PARENT_WORK_ID present without CQ_WORK_ID: kept as-is.
    const withParentOnly = applyCorrelationEnv(
      { PASEO_AGENT_ID: 'a1', CQ_PARENT_WORK_ID: 'outer-parent' },
      undefined,
    );
    expect(withParentOnly['CQ_PARENT_WORK_ID']).toBe('outer-parent');
    // Neither explicit name: the Paseo agent becomes the parent.
    const paseoOnly = applyCorrelationEnv({ PASEO_AGENT_ID: 'a1' }, undefined);
    expect(paseoOnly['CQ_PARENT_WORK_ID']).toBe('paseo:a1');
    // The same precedence holds through the COMPOSED lane env
    // (buildChildEnv): with an inherited CQ_WORK_ID but no inherited
    // parent, composition still derives the Paseo parent (the Paseo tier
    // answers — the work id names the run itself, not its parent).
    const composedWithWork = buildChildEnv({
      PASEO_AGENT_ID: 'a1',
      CQ_WORK_ID: 'outer-run:w:1',
      PATH: '/bin',
    });
    expect(composedWithWork['CQ_WORK_ID']).toBe('outer-run:w:1');
    expect(composedWithWork['CQ_PARENT_WORK_ID']).toBe('paseo:a1');
    applyCorrelationEnv(composedWithWork, undefined);
    expect(composedWithWork['CQ_PARENT_WORK_ID']).toBe('paseo:a1');
    // A BLANK inherited CQ_PARENT_WORK_ID counts as absent: composition
    // derives the Paseo link over it (and the boundary re-derives nothing).
    const composedBlank = buildChildEnv({
      PASEO_AGENT_ID: 'a1',
      CQ_PARENT_WORK_ID: '   ',
      PATH: '/bin',
    });
    expect(composedBlank['CQ_PARENT_WORK_ID']).toBe('paseo:a1');
  });

  it('a governed correlation is applied verbatim: the direct-path derivation never runs', () => {
    const correlation: WorkCorrelation = { workId: 'run:j:1', runId: 'run', role: 'fixer' };
    // The env shape a lane actually passes: the composed child env (the
    // default allowlist never forwards PASEO_AGENT_ID), plus a stale outer
    // CQ_ROLE the correlation must clear.
    const env = applyCorrelationEnv(buildChildEnv({ CQ_ROLE: 'stale', PATH: '/bin' }), correlation);
    expect(env).toEqual({
      PATH: '/bin',
      CQ_WORK_ID: 'run:j:1',
      CQ_RUN_ID: 'run',
      CQ_ROLE: 'fixer',
    });
    expect('PASEO_AGENT_ID' in env).toBe(false);
  });
});

describe('M5b1 missing evidence', () => {
  it('a direct invocation with no inbound identity leaves the env untouched', () => {
    const env = { PATH: '/bin', ANTHROPIC_BASE_URL: 'http://localhost:8080' };
    // Identity (not deep-equality) is the guard: a returned-clone env leak
    // would show up here (the sentinel test asserts the caller's map).
    expect(applyCorrelationEnv(env, undefined)).toBe(env);
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_BASE_URL', 'PATH']);
  });

  it('blank PASEO_AGENT_ID counts as absent (no paseo: parent with an empty id)', () => {
    const env = applyCorrelationEnv({ PASEO_AGENT_ID: '   ' }, undefined);
    expect(env['CQ_PARENT_WORK_ID']).toBeUndefined();
    const blank = applyCorrelationEnv({ PASEO_AGENT_ID: '' }, undefined);
    expect(blank['CQ_PARENT_WORK_ID']).toBeUndefined();
  });

  it('explicit blank CQ_* values fall through to the next precedence tier', () => {
    // Blank CQ_WORK_ID → CQ_PARENT_WORK_ID answers; blank both → Paseo.
    expect(
      applyCorrelationEnv({ CQ_WORK_ID: '  ', CQ_PARENT_WORK_ID: 'p' }, undefined)[
        'CQ_PARENT_WORK_ID'
      ],
    ).toBe('p');
    expect(
      applyCorrelationEnv(
        { CQ_WORK_ID: '', CQ_PARENT_WORK_ID: '', PASEO_AGENT_ID: 'a2' },
        undefined,
      )['CQ_PARENT_WORK_ID'],
    ).toBe('paseo:a2');
  });
});

describe('M5b1 failure evidence', () => {
  it('PASEO_AGENT_ID is never forwarded: the raw id never rides, only the derived parent link', () => {
    // The real lane shape: buildChildEnv composes the child env from the
    // parent, and the raw agent id is NOT on the default allowlist — so it
    // is translated into the derived `paseo:<id>` link AT COMPOSITION TIME
    // (review major: without this, the driver boundary could never derive
    // the parent, because the raw id was already gone).
    const env = buildChildEnv({ PASEO_AGENT_ID: 'a1', PATH: '/bin' });
    expect('PASEO_AGENT_ID' in env).toBe(false);
    expect(env['CQ_PARENT_WORK_ID']).toBe('paseo:a1');
    // The driver boundary then finds no raw id to derive from (already
    // translated) and leaves the composed link alone.
    applyCorrelationEnv(env, undefined);
    expect(env['CQ_PARENT_WORK_ID']).toBe('paseo:a1');
    expect('PASEO_AGENT_ID' in env).toBe(false);
    // An explicit inherited CQ_PARENT_WORK_ID survives composition (higher
    // precedence tier, never clobbered).
    const explicit = buildChildEnv({
      PASEO_AGENT_ID: 'a1',
      CQ_PARENT_WORK_ID: 'outer-parent',
      PATH: '/bin',
    });
    expect(explicit['CQ_PARENT_WORK_ID']).toBe('outer-parent');
    // Blank agent id: no link invented.
    const blank = buildChildEnv({ PASEO_AGENT_ID: '  ', PATH: '/bin' });
    expect(blank['CQ_PARENT_WORK_ID']).toBeUndefined();
  });

  it('the host environment cannot affect the fixtures: BOTH halves discriminate under an ambient id', () => {
    // The derivation reads ONLY the passed map. To prove it regardless of
    // what the TEST PROCESS itself carries, put a sentinel id in the test
    // process's own env for both halves: the injected half must derive from
    // the PASSED id (not the sentinel), and the bare half must derive
    // NOTHING (a {...process.env, ...env} leak would stamp the sentinel and
    // fail either side, deterministically even on a clean CI runner).
    const prior = process.env['PASEO_AGENT_ID'];
    process.env['PASEO_AGENT_ID'] = 'host-sentinel';
    try {
      // Injected half: the link derives from the passed id only.
      const derived = applyCorrelationEnv({ PATH: '/bin', PASEO_AGENT_ID: 'injected' }, undefined);
      expect(derived['CQ_PARENT_WORK_ID']).toBe('paseo:injected');
      // Absent-id half: no derivation is invented, sentinel or not.
      const bare: Record<string, string> = { PATH: '/bin' };
      applyCorrelationEnv(bare, undefined);
      expect(bare['CQ_PARENT_WORK_ID']).toBeUndefined();
      expect(bare['CQ_WORK_ID']).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env['PASEO_AGENT_ID'];
      else process.env['PASEO_AGENT_ID'] = prior;
    }
    // And the helper itself never consults the host: a blank id is absent.
    expect(paseoParentWorkId({ PASEO_AGENT_ID: '  ' })).toBeUndefined();
  });

  it('a malformed correlation field stays out of the child env (empty-string task/role removed, not stamped)', () => {
    const env = applyCorrelationEnv(
      { CQ_ROLE: 'stale', CQ_TASK: 'stale-task' },
      { workId: 'w', role: '', task: '' },
    );
    expect(env['CQ_ROLE']).toBeUndefined();
    expect(env['CQ_TASK']).toBeUndefined();
    expect(env['CQ_WORK_ID']).toBe('w');
  });
});

describe('M5b1 shared driver boundary', () => {
  it('applyCorrelationEnv alone derives the Paseo parent with no second precedence implementation', () => {
    // The "shared driver boundary" clause: for the SDK and ACP transports,
    // the composed child env reaches the harness through applyCorrelationEnv,
    // which derives the Paseo parent from the env's own PASEO_AGENT_ID when
    // no CQ_WORK_ID/CQ_PARENT_WORK_ID answers. (The CLI composition hands
    // the boundary only its overrides map, so its link is stamped at
    // buildChildEnv time — the derivation is a backstop there, not the
    // primary path.) This map has no inherited CQ_* identity at all, so the
    // boundary ALONE must answer: no src/cli/main.ts step, no parallel
    // precedence ladder.
    const boundaryOnly: Record<string, string> = {
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'http://localhost:8080',
      PASEO_AGENT_ID: 'direct-op',
    };
    applyCorrelationEnv(boundaryOnly, undefined);
    expect(boundaryOnly['CQ_PARENT_WORK_ID']).toBe('paseo:direct-op');
    // And the id shape is the shared helper's, spelled exactly once.
    expect(boundaryOnly['CQ_PARENT_WORK_ID']).toBe(
      paseoParentWorkId({ PASEO_AGENT_ID: 'direct-op' }),
    );
  });
});
