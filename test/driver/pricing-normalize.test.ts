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
  servedModelIsBounded,
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

  test('an Object.prototype member name is not a declared alias at any level', () => {
    // A plain index answers `constructor` with a function; spreading that as
    // the alias list threw instead of reporting nothing declared.
    expect(servedAliasIds(ALIASES, 'constructor', 'anthropic', 'claude-haiku-4-5')).toEqual([]);
    expect(servedAliasIds(ALIASES, 'subprocess', 'toString', 'claude-haiku-4-5')).toEqual([]);
    expect(servedAliasIds(ALIASES, 'subprocess', 'anthropic', 'constructor')).toEqual([]);
    expect(
      worstCaseRates({ provider: 'anthropic', model: 'constructor' }, ALIASES, 'subprocess')
        .candidates,
    ).toEqual(['constructor']);
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
    // `deepseek-chat` IS a vendored table key, so the requested id prices
    // directly. It is the WIRE's served id (`deepseek-flash`) that needs the
    // alias set, which is what the next test covers.
    expect(resolved.rates).toEqual(priceOf(DEEPSEEK_CHAT));
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
  test('an entirely unpriced candidate set reports NO rates, not zero rates', () => {
    // A `rates` object with zeros would read as "this model is free", which is
    // the fabrication the price map refuses to make. The completeness metadata
    // still travels so a caller can tell unknown from priced.
    const worst = worstCaseRates(UNKNOWN, ALIASES, 'ai-sdk');
    expect(worst.rates).toBeUndefined();
    expect(worst.complete).toBe(false);
    expect(worst.unpricedCandidates).toEqual(['claude-never-shipped']);
    expect(worst.candidates).toEqual(['claude-never-shipped']);
  });

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

describe('servedModelIsBounded', () => {
  // The predicate ENFORCES the conjunction; it is not a pass-through of the flag.
  const exact = resolvePricedModel({
    lane: 'subprocess',
    modelSpec: HAIKU,
    servedModel: HAIKU.model,
  });
  const aliased = resolvePricedModel({
    lane: 'subprocess',
    modelSpec: HAIKU,
    servedModel: 'claude-haiku-4-5-20251001',
    aliases: ALIASES,
  });
  const remapped = resolvePricedModel({
    lane: 'subprocess',
    modelSpec: HAIKU,
    servedModel: 'claude-opus-4-1',
    aliases: ALIASES,
  });

  test('bounded only when observed AND the observed id was in the declared set', () => {
    expect(servedModelIsBounded({ requireObserved: true, priced: exact })).toBe(true);
    expect(servedModelIsBounded({ requireObserved: true, priced: aliased })).toBe(true);
    // An observed id OUTSIDE the declared set breaks the bound even with the
    // check switched on — the half of the conjunction a caller used to skip.
    expect(servedModelIsBounded({ requireObserved: true, priced: remapped })).toBe(false);
  });

  test('requireObserved:false never bounds, whatever was observed', () => {
    expect(servedModelIsBounded({ requireObserved: false, priced: exact })).toBe(false);
    expect(servedModelIsBounded({ requireObserved: false, priced: aliased })).toBe(false);
  });

  test('an unobserved resolution is in-bounds under requireObserved:true, by construction', () => {
    // `via: 'unobserved'` is unreachable on a lane with requireObserved:true —
    // the seam wrapper rejects an unobserved id before a result is priced — so
    // this case cannot arise in a governed run. The predicate follows the stated
    // contract (requireObserved AND not an undeclared remap) rather than adding
    // a third condition the ADR does not have.
    const unobserved = resolvePricedModel({ lane: 'acp', modelSpec: HAIKU });
    expect(unobserved.via).toBe('unobserved');
    expect(servedModelIsBounded({ requireObserved: true, priced: unobserved })).toBe(true);
    // ...but the same resolution on a lane that does NOT require observation is
    // unbounded, which is the case that actually reaches admission.
    expect(servedModelIsBounded({ requireObserved: false, priced: unobserved })).toBe(false);
  });
});

describe('pricedCandidates consistency (F5)', () => {
  test('a policy declaring the requested id in its own alias list is deduped ONCE', () => {
    // The two functions used to filter independently and drifted apart, so the
    // requested id appeared twice in worstCaseRates' unpricedCandidates.
    const selfReferential: ServedAliasTable = {
      'ai-sdk': { deepseek: { 'deepseek-chat': ['deepseek-chat', 'deepseek-flash'] } },
    };
    const resolved = resolvePricedModel({
      lane: 'ai-sdk',
      modelSpec: DEEPSEEK_CHAT,
      aliases: selfReferential,
    });
    const worst = worstCaseRates(DEEPSEEK_CHAT, selfReferential, 'ai-sdk');
    expect(resolved.candidates).toEqual(['deepseek-chat', 'deepseek-flash']);
    expect(worst.candidates).toEqual(resolved.candidates);
    expect(worst.unpricedCandidates).toEqual([]);
  });

  test('the requested id appearing twice in the alias list still yields one candidate', () => {
    const repeated: ServedAliasTable = {
      'ai-sdk': { deepseek: { 'deepseek-chat': ['deepseek-flash', 'deepseek-flash'] } },
    };
    expect(worstCaseRates(DEEPSEEK_CHAT, repeated, 'ai-sdk').candidates).toEqual([
      'deepseek-chat',
      'deepseek-flash',
    ]);
  });
});
