// Shipped-routing pin — VB1C batch gate, post-Phase-1.9.
//
// The two agent lanes the original pin guarded shipped DUPLICATED endpoint
// data; Phase 1.9 merged them into the ONE claude-code lane with ONE
// `defaultRoutingTable()`, so the drift this file existed to catch is now
// impossible by construction (no second table exists to drift). What stays
// load-bearing is the shipped default itself: these endpoints are
// provider-documented CONFIG (as-of 2026-09), and a rename of a base URL,
// a key env, or a provider handle would silently re-route every deployment
// that relies on the defaults. This pin asserts the documented shape loudly.
import { describe, expect, test } from 'vitest';
import { defaultRoutingTable } from '../../src/driver/claude-code/routing.js';

const endpoints = defaultRoutingTable().endpoints;

describe('routing table — the shipped default keeps the documented anthropic-compat endpoints', () => {
  test('the provider set is exactly the documented three', () => {
    expect(Object.keys(endpoints).sort()).toEqual(['anthropic', 'deepseek', 'zai']);
  });

  test.each(['zai', 'deepseek', 'anthropic'])('%s: the documented env wiring holds', (provider) => {
    const entry = endpoints[provider];
    if (entry === undefined) throw new Error(`missing endpoint: ${provider}`);
    // The key env is the provider's documented credential variable, and the
    // base URL default matches the provider's anthropic-compat endpoint.
    const documented: Record<string, { baseUrlDefault: string; keyEnv: string }> = {
      zai: { baseUrlDefault: 'https://api.z.ai/api/anthropic', keyEnv: 'ZAI_API_KEY' },
      deepseek: {
        baseUrlDefault: 'https://api.deepseek.com/anthropic',
        keyEnv: 'DEEPSEEK_API_KEY',
      },
      anthropic: { baseUrlDefault: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY' },
    };
    expect(entry.baseUrlDefault).toBe(documented[provider]?.baseUrlDefault);
    expect(entry.keyEnv).toBe(documented[provider]?.keyEnv);
    // The base URL override env var is per-provider and never a credential.
    expect(entry.baseUrlEnv).toMatch(/_ANTHROPIC_BASE_URL$|^ANTHROPIC_BASE_URL$/);
    // The model allowlist is retired: the shipped default carries no rows.
    expect(entry.models).toBeUndefined();
  });
});
