// Routing-table agreement pin — VB1C batch gate.
//
// The two agent lanes ship DUPLICATED endpoint data: the subprocess lane's
// `defaultRoutingTable()` and the claude-agent lane's
// `defaultEndpointTable()` both carry the zai / deepseek / anthropic
// endpoints as plain serializable config (the subprocess table adds the
// per-endpoint model allowlist its routeFor enforces; the claude-agent
// table is provider-only by the no-allowlist owner override). The tables
// share no code, so nothing stopped a future rename — a new base URL, a
// moved key env — from drifting ONE lane silently. This pin asserts the
// shipped defaults agree per provider on the three fields both tables
// carry (`baseUrlEnv` / `baseUrlDefault` / `keyEnv`) and on the provider
// set itself: drift is now a loud test failure, not a silent lane split.
import { describe, expect, test } from 'vitest';
import { defaultEndpointTable } from '../../src/driver/claude-agent/routing.js';
import { defaultRoutingTable } from '../../src/driver/subprocess/routing.js';

const claudeEndpoints = defaultEndpointTable().endpoints;
const subprocessEndpoints = defaultRoutingTable().endpoints;

describe('routing tables — the two lanes ship ONE endpoint truth', () => {
  test('the provider sets agree across lanes', () => {
    expect(Object.keys(claudeEndpoints).sort()).toEqual(Object.keys(subprocessEndpoints).sort());
  });

  test.each(Object.keys(subprocessEndpoints).sort())('%s: baseUrlEnv/baseUrlDefault/keyEnv agree across lanes', (provider) => {
    const subprocess = subprocessEndpoints[provider];
    const claude = claudeEndpoints[provider];
    expect(claude).toBeDefined(); // implied by the set pin above; kept for a clear failure message
    expect(claude.baseUrlEnv).toBe(subprocess.baseUrlEnv);
    expect(claude.baseUrlDefault).toBe(subprocess.baseUrlDefault);
    expect(claude.keyEnv).toBe(subprocess.keyEnv);
  });
});
