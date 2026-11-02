import { describe, expect, it } from 'vitest';
import { applyCorrelationEnv } from '../../src/driver/correlation-env.js';
import { buildChildEnv } from '../../src/shared/proc.js';
import type { WorkCorrelation } from '../../src/driver/types.js';

// Measurement M5b1 — correlate direct op parents. A DIRECT op invocation
// (no governed dispatch, no runner-minted correlation) must still link its
// child harness to the enclosing work: applyCorrelationEnv is the ONE
// shared driver boundary every transport composes its child env through,
// so the Paseo parent derivation lives there (no src/cli/main.ts change,
// no second precedence implementation). All fixtures are local maps — the
// host environment cannot reach the derivation, because it reads ONLY the
// env passed in.

describe('M5b1 nominal evidence', () => {
  it('a direct invocation inside a Paseo agent derives paseo:<PASEO_AGENT_ID> as CQ_PARENT_WORK_ID at the shared driver boundary', () => {
    const env = buildChildEnv(
      { PATH: '/bin', PASEO_AGENT_ID: '61f19a9d' },
      // The overrides map a lane composes (auth/base-url); PASEO_AGENT_ID
      // rides only via the allowlist pass-through of the PARENT map here.
      { ANTHROPIC_BASE_URL: 'http://localhost:8080' },
      ['PASEO_AGENT_ID'],
    );
    expect('PASEO_AGENT_ID' in env).toBe(true);
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
  it('PASEO_AGENT_ID is never forwarded: it is not on the default child allowlist and the derivation consumes it', () => {
    expect('PASEO_AGENT_ID' in buildChildEnv({ PATH: '/bin', PASEO_AGENT_ID: 'a1' })).toBe(false);
    // And on a default-allowlist child env (the real lane shape) the raw id
    // still never rides, while the derived parent link does.
    const env = buildChildEnv({ PASEO_AGENT_ID: 'a1', PATH: '/bin' });
    applyCorrelationEnv(env, undefined);
    expect('PASEO_AGENT_ID' in env).toBe(false);
    expect(env['CQ_PARENT_WORK_ID']).toBeUndefined();
  });

  it('the host environment cannot affect the fixtures: the derivation reads only the passed map', () => {
    // No PASEO_AGENT_ID / CQ_* was seeded into this test process's env by
    // the fixtures above — every assertion so far ran on literal maps. As a
    // direct probe: an env with no identity keys derives nothing even if the
    // test process itself runs inside a Paseo agent.
    const env: Record<string, string> = { PATH: '/bin' };
    applyCorrelationEnv(env, undefined);
    expect(env['CQ_PARENT_WORK_ID']).toBeUndefined();
    expect(env['CQ_WORK_ID']).toBeUndefined();
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
