// Candidate-alias evidence pin — pure data, no network, no model calls.
//
// The built-in alias layer is EMPTY while reconciliation open point O-2 is
// undecided (ADR-0002 §2.6). This file pins the CANDIDATE evidence that O-2's
// decision consumes: the exact structural shape, the entries that primary
// sources support, and — the load-bearing part — the omissions that a reviewer
// must not read as oversights. Provenance, fetch dates and drift findings live in
// ./PROVENANCE.md.
import { describe, expect, test } from 'vitest';
import {
  CANDIDATE_ANTHROPIC_DATED_ALIASES,
  CANDIDATE_DEEPSEEK_SERVED_ALIASES,
  CANDIDATE_SERVED_ALIASES,
  CANDIDATE_ZAI_ROUTING_ALIASES,
} from '../../src/driver/pricing/candidate-aliases.js';
import {
  resolvePricedModel,
  servedAliasIds,
  worstCaseRates,
} from '../../src/driver/pricing/normalize.js';
import type { ServedAliasTable } from '../../src/driver/pricing/normalize.js';

describe('candidate served aliases — shape and contents', () => {
  test('the anthropic group is lane-scoped and records the dated id for the dateless alias', () => {
    expect(Object.keys(CANDIDATE_ANTHROPIC_DATED_ALIASES).sort()).toEqual([
      'ai-sdk',
      'claude-agent',
      'subprocess',
    ]);
    for (const lane of ['ai-sdk', 'claude-agent', 'subprocess'] as const) {
      expect(
        servedAliasIds(CANDIDATE_ANTHROPIC_DATED_ALIASES, lane, 'anthropic', 'claude-haiku-4-5'),
      ).toEqual(['claude-haiku-4-5-20251001']);
    }
  });

  test('the deepseek group records only the observed chat → flash remap', () => {
    expect(
      servedAliasIds(CANDIDATE_DEEPSEEK_SERVED_ALIASES, 'ai-sdk', 'deepseek', 'deepseek-chat'),
    ).toEqual(['deepseek-flash']);
    // No reasoner candidate: an unevidenced remap from a retired id to a live one
    // is a fabrication, so the omission is deliberate and pinned here.
    expect(
      servedAliasIds(CANDIDATE_DEEPSEEK_SERVED_ALIASES, 'ai-sdk', 'deepseek', 'deepseek-reasoner'),
    ).toEqual([]);
  });

  test('the zai group records the three documented auto-routes', () => {
    const zai = CANDIDATE_ZAI_ROUTING_ALIASES['ai-sdk']?.zai ?? {};
    expect(zai).toEqual({
      'glm-4.7': ['glm-5.3-flash'],
      'glm-5.1': ['glm-5.3'],
      'glm-5.2': ['glm-5.3'],
    });
  });

  test('the merged candidate table keeps EVERY group (no shallow-spread clobber)', () => {
    // A shallow `{...a, ...b, ...c}` keeps only the LAST group's `ai-sdk` map and
    // silently loses the anthropic and deepseek entries: a table that looks
    // populated and is missing half of what went into it.
    const aiSdk = CANDIDATE_SERVED_ALIASES['ai-sdk'];
    expect(Object.keys(aiSdk ?? {}).sort()).toEqual(['anthropic', 'deepseek', 'zai']);
    expect(
      servedAliasIds(CANDIDATE_SERVED_ALIASES, 'ai-sdk', 'anthropic', 'claude-haiku-4-5'),
    ).toEqual(['claude-haiku-4-5-20251001']);
    expect(servedAliasIds(CANDIDATE_SERVED_ALIASES, 'ai-sdk', 'deepseek', 'deepseek-chat')).toEqual(
      ['deepseek-flash'],
    );
    expect(servedAliasIds(CANDIDATE_SERVED_ALIASES, 'ai-sdk', 'zai', 'glm-4.7')).toEqual([
      'glm-5.3-flash',
    ]);
    // And the lane-scoped groups that no other group carries survive too.
    expect(
      servedAliasIds(CANDIDATE_SERVED_ALIASES, 'claude-agent', 'anthropic', 'claude-haiku-4-5'),
    ).toEqual(['claude-haiku-4-5-20251001']);
  });

  test('the merged table is a superset of every group it merged', () => {
    for (const group of [
      CANDIDATE_ANTHROPIC_DATED_ALIASES,
      CANDIDATE_DEEPSEEK_SERVED_ALIASES,
      CANDIDATE_ZAI_ROUTING_ALIASES,
    ]) {
      for (const [lane, byProvider] of Object.entries(group)) {
        for (const [provider, byRequested] of Object.entries(byProvider)) {
          for (const [requested, served] of Object.entries(byRequested)) {
            expect(servedAliasIds(CANDIDATE_SERVED_ALIASES, lane, provider, requested)).toEqual(
              served,
            );
          }
        }
      }
    }
  });

  test('no candidate maps a served id that itself remaps (an alias cycle would never settle)', () => {
    const seen = new Set<string>();
    for (const [lane, byProvider] of Object.entries(CANDIDATE_SERVED_ALIASES)) {
      for (const [provider, byRequested] of Object.entries(byProvider)) {
        for (const [requested, served] of Object.entries(byRequested)) {
          for (const id of served) {
            const key = `${lane}/${provider}/${id}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
            expect(Object.hasOwn(byRequested, id)).toBe(false);
            expect(id).not.toBe(requested);
          }
        }
      }
    }
  });

  test('no candidate entry is an empty alias list (a declared empty set is noise)', () => {
    for (const byProvider of Object.values(CANDIDATE_SERVED_ALIASES)) {
      for (const served of Object.values(byProvider).map((byRequested) =>
        Object.values(byRequested),
      )) {
        for (const ids of served) {
          expect(ids.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('candidate served aliases — what they would do to pricing if enabled', () => {
  test('the deepseek candidate makes a chat request priceable through the served id', () => {
    const resolved = resolvePricedModel({
      lane: 'ai-sdk',
      modelSpec: { provider: 'deepseek', model: 'deepseek-chat' },
      servedModel: 'deepseek-flash',
      aliases: CANDIDATE_DEEPSEEK_SERVED_ALIASES,
    });
    expect(resolved.via).toBe('alias');
    expect(resolved.candidates).toEqual(['deepseek-chat', 'deepseek-flash']);
    // Both ids are table keys, so the worst case is bounded and prices the
    // maximum of the two rows rather than either row alone.
    const worst = worstCaseRates(
      { provider: 'deepseek', model: 'deepseek-chat' },
      CANDIDATE_DEEPSEEK_SERVED_ALIASES,
      'ai-sdk',
    );
    expect(worst.complete).toBe(true);
    expect(worst.rates?.output).toBe(0.6);
  });

  test('the anthropic candidate is UNBOUNDED as written, because the dated id is unpriced', () => {
    const worst = worstCaseRates(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      CANDIDATE_ANTHROPIC_DATED_ALIASES,
      'subprocess',
    );
    expect(worst.complete).toBe(false);
    expect(worst.unpricedCandidates).toEqual(['claude-haiku-4-5-20251001']);
  });

  test('a zai auto-routed request still resolves to no price until the table gains the id', () => {
    const resolved = resolvePricedModel({
      lane: 'ai-sdk',
      modelSpec: { provider: 'zai', model: 'glm-4.7' },
      servedModel: 'glm-5.3-flash',
      aliases: CANDIDATE_ZAI_ROUTING_ALIASES,
    });
    expect(resolved.via).toBe('alias');
    expect(resolved.canonicalModel).toBe('glm-4.7');
    expect(resolved.rates).toBeUndefined();
  });

  test('with no candidates injected the normalizer behaves exactly as before', () => {
    const none: ServedAliasTable = {};
    const resolved = resolvePricedModel({
      lane: 'subprocess',
      modelSpec: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      servedModel: 'claude-opus-4-1',
      aliases: none,
    });
    expect(resolved.via).toBe('undeclared-remap');
    expect(resolved.rates).toBeUndefined();
  });
});
