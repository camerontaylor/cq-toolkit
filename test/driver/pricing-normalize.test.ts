// W3.5 pricing normalizer — pure data tests. No network, no model calls.
//
// The cases pin the fail-closed rules the W2 blocker note in ADR-0003 §2.4
// depends on: an undeclared served id is never priced, an unknown canonical
// model is never priced 0, and a worst case with any unbounded direction returns
// no reservation rather than an undercount. Alias data is the SHAPE of
// `ServedModelPolicy.aliases` (ADR-0002 §2.6), passed in by the seam owner; the
// built-in layer is empty until open point O-2 is decided.
import { describe, expect, test } from 'vitest';
import type { ModelSpec } from '../../src/driver/types.js';
import { priceOf } from '../../src/driver/pricing/index.js';
import {
  resolvePricedModel,
  servedAliasIds,
  servedModelBoundedByObservation,
  worstCaseRates,
  worstCaseReservationUsd,
} from '../../src/driver/pricing/normalize.js';
import type { PerMillionRates } from '../../src/driver/pricing/data.js';
import type { ServedAliasTable } from '../../src/driver/pricing/normalize.js';

const HAIKU: ModelSpec = { provider: 'anthropic', model: 'claude-haiku-4-5' };
const HAIKU_DATED: ModelSpec = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };
const DEEPSEEK_CHAT: ModelSpec = { provider: 'deepseek', model: 'deepseek-chat' };
const UNKNOWN: ModelSpec = { provider: 'anthropic', model: 'claude-never-shipped' };

/** anthropic/haiku served as its dated id; deepseek/chat served as deepseek-flash. */
const ALIASES: ServedAliasTable = {
  subprocess: {
    anthropic: { 'claude-haiku-4-5': ['claude-haiku-4-5-20251001'] },
  },
  'ai-sdk': {
    deepseek: { 'deepseek-chat': ['deepseek-flash'] },
    anthropic: { 'claude-haiku-4-5': ['claude-haiku-4-5-20251001'] },
  },
};

describe('servedAliasIds', () => {
  test('returns the declared served ids for that exact lane and provider', () => {
    expect(servedAliasIds(ALIASES, 'subprocess', 'anthropic', 'claude-haiku-4-5')).toEqual([
      'claude-haiku-4-5-20251001',
    ]);
  });

  test('an alias declared on one lane never leaks onto another', () => {
    expect(servedAliasIds(ALIASES, 'acp', 'anthropic', 'claude-haiku-4-5')).toEqual([]);
  });

  test('an unknown requested id or a missing table yields an empty set', () => {
    expect(servedAliasIds(ALIASES, 'subprocess', 'anthropic', 'claude-opus-4-1')).toEqual([]);
    expect(servedAliasIds(undefined, 'subprocess', 'anthropic', 'claude-haiku-4-5')).toEqual([]);
  });
});

describe('resolvePricedModel', () => {
  test('an observed id equal to the requested id is exact and carries the canonical rate', () => {
    const resolved = resolvePricedModel({
      lane: 'subprocess',
      modelSpec: HAIKU,
      servedModel: 'claude-haiku-4-5',
      aliases: ALIASES,
    });
    expect(resolved.via).toBe('exact');
    expect(resolved.canonicalModel).toBe('claude-haiku-4-5');
    expect(resolved.rates).toEqual({ input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 });
  });

  test('a declared dated served id resolves to the canonical alias id, not the dated id', () => {
    const resolved = resolvePricedModel({
      lane: 'subprocess',
      modelSpec: HAIKU,
      servedModel: 'claude-haiku-4-5-20251001',
      aliases: ALIASES,
    });
    expect(resolved.via).toBe('alias');
    expect(resolved.canonicalModel).toBe('claude-haiku-4-5');
    expect(resolved.rates).toEqual(priceOf(HAIKU));
    // The dated id itself is unknown to the table — that miss is what this fixes.
    expect(priceOf(HAIKU_DATED)).toBeUndefined();
  });

  test('an UNDECLARED served id resolves to no price and never to zero', () => {
    const resolved = resolvePricedModel({
      lane: 'subprocess',
      modelSpec: HAIKU,
      servedModel: 'claude-opus-4-1',
      aliases: ALIASES,
    });
    expect(resolved.via).toBe('undeclared-remap');
    expect(resolved.canonicalModel).toBeUndefined();
    expect(resolved.rates).toBeUndefined();
  });

  test('an unknown CANONICAL model is undefined, never a fabricated price', () => {
    const resolved = resolvePricedModel({ lane: 'ai-sdk', modelSpec: UNKNOWN });
    expect(resolved.via).toBe('unobserved');
    expect(resolved.canonicalModel).toBe('claude-never-shipped');
    expect(resolved.rates).toBeUndefined();
  });

  test('an unobserved served id prices the requested id and stays unobserved', () => {
    const resolved = resolvePricedModel({ lane: 'acp', modelSpec: DEEPSEEK_CHAT });
    expect(resolved.via).toBe('unobserved');
    expect(resolved.rates).toBeUndefined(); // deepseek-chat is not a table key
    expect(resolved.candidates).toEqual(['deepseek-chat']);
  });

  test('the priced candidate set is the requested id plus every declared alias', () => {
    const resolved = resolvePricedModel({
      lane: 'ai-sdk',
      modelSpec: DEEPSEEK_CHAT,
      servedModel: 'deepseek-flash',
      aliases: ALIASES,
    });
    expect(resolved.via).toBe('alias');
    expect(resolved.canonicalModel).toBe('deepseek-chat');
    expect(resolved.candidates).toEqual(['deepseek-chat', 'deepseek-flash']);
  });
});

describe('worstCaseRates', () => {
  test('no aliases means the requested id alone bounds the rates', () => {
    const worst = worstCaseRates(HAIKU, ALIASES, 'acp');
    expect(worst.complete).toBe(true);
    expect(worst.unpricedCandidates).toEqual([]);
    expect(worst.missingDirections).toEqual([]);
    expect(worst.rates).toEqual({ input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 });
  });

  test('an alias the price table does not know makes the worst case unbounded', () => {
    const worst = worstCaseRates(HAIKU, ALIASES, 'subprocess');
    expect(worst.complete).toBe(false);
    expect(worst.unpricedCandidates).toEqual(['claude-haiku-4-5-20251001']);
    expect(worst.candidates).toEqual(['claude-haiku-4-5', 'claude-haiku-4-5-20251001']);
  });

  test('the worst case takes the per-direction MAXIMUM over the alias set', () => {
    const worst = worstCaseRates(DEEPSEEK_CHAT, ALIASES, 'ai-sdk');
    expect(worst.complete).toBe(true);
    // deepseek-chat input 0.28 vs deepseek-flash 0.15 → max 0.28;
    // output 0.42 vs 0.60 → max 0.60; cacheRead 0.028 vs 0.003 → max 0.028.
    expect(worst.rates).toEqual({ input: 0.28, output: 0.6, cacheRead: 0.028 });
  });

  test('a direction no candidate prices is a zero term, not a gap', () => {
    const worst = worstCaseRates(DEEPSEEK_CHAT, ALIASES, 'ai-sdk');
    expect(worst.missingDirections).toEqual([]);
    expect(worst.rates?.cacheWrite).toBeUndefined();
  });

  test('candidates that DISAGREE about a direction leave it absent, never zero', () => {
    // Injected lookup: 'cheap' prices a cache write, 'dear' does not — the
    // worst case cannot claim zero for a direction the other vendor charges.
    const lookup = (candidate: string): PerMillionRates | undefined =>
      candidate === 'cheap' ? { input: 1, output: 2 } : { input: 9, output: 2, cacheWrite: 3 };
    const worst = worstCaseRates(
      { provider: 'anthropic', model: 'dear' },
      { subprocess: { anthropic: { dear: ['cheap'] } } },
      'subprocess',
      lookup,
    );
    expect(worst.complete).toBe(false);
    expect(worst.missingDirections).toEqual(['cacheWrite']);
    expect(worst.rates?.cacheWrite).toBeUndefined();
    expect(worst.rates?.input).toBe(9);
  });
});

describe('worstCaseReservationUsd', () => {
  test('a complete worst case reserves the per-direction maximum', () => {
    const reservation = worstCaseReservationUsd({
      lane: 'ai-sdk',
      modelSpec: DEEPSEEK_CHAT,
      aliases: ALIASES,
      envelope: { input: 1_000_000, output: 1_000_000 },
    });
    expect(reservation.complete).toBe(true);
    expect(reservation.usd).toBeCloseTo(0.28 + 0.6, 12);
  });

  test('an unbounded alias set reserves nothing rather than an undercount', () => {
    const reservation = worstCaseReservationUsd({
      lane: 'subprocess',
      modelSpec: HAIKU,
      aliases: ALIASES,
      envelope: { input: 1_000_000, output: 1_000_000 },
    });
    expect(reservation.complete).toBe(false);
    expect(reservation.usd).toBeUndefined();
  });

  test('an unknown canonical model reserves nothing', () => {
    const reservation = worstCaseReservationUsd({
      lane: 'ai-sdk',
      modelSpec: UNKNOWN,
      envelope: { input: 1_000_000, output: 1_000_000 },
    });
    expect(reservation.complete).toBe(false);
    expect(reservation.usd).toBeUndefined();
  });

  test('an unknown canonical model never reserves zero for an empty envelope', () => {
    const reservation = worstCaseReservationUsd({
      lane: 'acp',
      modelSpec: UNKNOWN,
      envelope: { input: 0, output: 0 },
    });
    expect(reservation.usd).not.toBe(0);
  });
});

describe('servedModelBoundedByObservation', () => {
  test('only requireObserved:true bounds the served model by the alias set', () => {
    expect(servedModelBoundedByObservation(true)).toBe(true);
    expect(servedModelBoundedByObservation(false)).toBe(false);
  });
});
