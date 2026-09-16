// Analyze lane G1 — test evidence for signature clustering: the exact
// normalization pipeline (what is abstracted, what is preserved, rule
// order), content-derived stable ids, the confidence decision table
// (high/low; v1 never merges, never emits 'medium'), the ledger noise seam
// (knownNoise excludes BY CLUSTER SIGNATURE — any other recorded form never
// matches), and a seeded PROPERTY test proving the acceptance constraint:
// the same failure set in any presentation order yields identical cluster
// ids, confidences, and membership. All pure — zero I/O.
import { describe, expect, test } from 'vitest';
import { failureIdentity } from '../../../src/ops/analyze/collectFailures.js';
import {
  clusterErrors,
  clusterErrorsOp,
  clusterSignature,
  messageTemplate,
} from '../../../src/ops/analyze/clusterErrors.js';
import { fnv1a32Hex } from '../../../src/ops/gates/fingerprint.js';
import { SIGNATURE_MAX_CHARS } from '../../../src/ops/ledger/ledger.js';
import type { LedgerView } from '../../../src/ops/ledger/index.js';
import type { CheckFailure, FailureSet } from '../../../src/ops/gates/index.js';

/** A failure with only the fields under test (the gates test idiom). */
function failureOf(overrides: Partial<CheckFailure>): CheckFailure {
  return {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    ruleId: 'rule',
    message: 'message text',
    severity: 'error',
    ...overrides,
  };
}

/** A FailureSet over the given failures, tool configurable. */
function setOf(failures: CheckFailure[], tool = 'eslint', exitCode: number | null = 1): FailureSet {
  return { tool, failures, exitCode };
}

/** An in-memory ledger view: every knownNoise signature is GROUNDED in a recorded entry (as the real ledger derives it). */
function ledgerOf(knownNoise: string[]): LedgerView {
  return {
    entries: knownNoise.map((signature) => ({ signature, count: 2, component: 'src/ops/analyze' })),
    knownNoise,
    needsHuman: [],
  };
}

describe('messageTemplate normalization pipeline (the documented contract)', () => {
  test('numbers abstract to <num>: counts, decimals, line refs, codes', () => {
    expect(messageTemplate('Expected 2 arguments, but got 3.')).toBe(
      'Expected <num> arguments, but got <num>.',
    );
    expect(messageTemplate('line 42 col 7.5')).toBe('line <num> col <num>');
    expect(messageTemplate('error TS2551 occurred')).toBe('error TS<num> occurred');
  });

  test('quoted spans abstract to <str> before any other rule (all three quote styles)', () => {
    expect(messageTemplate("'foo' is defined but never used")).toBe(
      '<str> is defined but never used',
    );
    expect(messageTemplate('Cannot find module "../utils/date"')).toBe('Cannot find module <str>');
    // The other two QUOTED_SPAN alternatives, each on a plain word span.
    expect(messageTemplate('"x" is not defined')).toBe('<str> is not defined');
    expect(messageTemplate('run `npm test` now')).toBe('run <str> now');
  });

  test('unquoted path-like runs abstract to <path>: posix, windows, URLs', () => {
    expect(messageTemplate('Cannot open file src/utils/date.ts for reading')).toBe(
      'Cannot open file <path> for reading',
    );
    expect(messageTemplate('no such directory C:\\work\\repo\\src')).toBe(
      'no such directory <path>',
    );
    expect(messageTemplate('fetch of https://example.test/api failed')).toBe(
      'fetch of <path> failed',
    );
  });

  test('rule order: a quoted path is <str>; a number inside a path stays inside <path>', () => {
    expect(messageTemplate("could not read 'C:\\data\\2024.json'")).toBe('could not read <str>');
    expect(messageTemplate('missing src/v2/config.json')).toBe('missing <path>');
  });

  test('whitespace runs collapse and trim; case is preserved', () => {
    expect(messageTemplate('  too   much\t\twhitespace\nhere  ')).toBe('too much whitespace here');
    expect(messageTemplate('Foo and foo differ')).toBe('Foo and foo differ');
  });

  test('the coarseness is deliberate: a slash in prose also abstracts (documented)', () => {
    expect(messageTemplate('true and/or false')).toBe('true <path> false');
  });

  test('contraction apostrophes never open a quoted span; a real quoted span still abstracts', () => {
    // No curly rewrite anymore: the opener-boundary rule leaves the straight
    // apostrophe in place, verbatim.
    expect(messageTemplate("The option doesn't accept 'foo'")).toBe(
      "The option doesn't accept <str>",
    );
    // The over-split trap: changing the quoted word must NOT change the
    // signature — the contraction's apostrophe is not a quote-pair opener.
    const withFoo = clusterSignature(
      failureOf({ message: "The option doesn't accept 'foo'" }),
      'eslint',
    );
    const withBar = clusterSignature(
      failureOf({ message: "The option doesn't accept 'bar'" }),
      'eslint',
    );
    expect(withFoo).toBe(withBar);
    // A genuine quoted span (no contraction involved) still abstracts.
    expect(messageTemplate("'baz' is defined but never used")).toBe(
      '<str> is defined but never used',
    );
  });

  test('possessive apostrophes never open a quoted span either (space after the apostrophe)', () => {
    expect(messageTemplate("Users' setting rejects 'foo'")).toBe("Users' setting rejects <str>");
    // Same over-split discipline: the quoted word is volatile, the
    // possessive is not — both messages share one signature.
    const withFoo = clusterSignature(
      failureOf({ message: "Users' setting rejects 'foo'" }),
      'eslint',
    );
    const withBar = clusterSignature(
      failureOf({ message: "Users' setting rejects 'bar'" }),
      'eslint',
    );
    expect(withFoo).toBe(withBar);
  });

  test("Unicode letters count as word chars for the opener boundary (café's)", () => {
    // \w is ASCII-only: é is a Unicode letter but not \w, so under an ASCII
    // lookbehind the apostrophe after café OPENS a span and pairs with the
    // LATER quoted word — an over-split. The Unicode-aware boundary keeps
    // the span at 'foo'.
    expect(messageTemplate("café's setting rejects 'foo'")).toBe("café's setting rejects <str>");
    const withFoo = clusterSignature(
      failureOf({ message: "café's setting rejects 'foo'" }),
      'eslint',
    );
    const withBar = clusterSignature(
      failureOf({ message: "café's setting rejects 'bar'" }),
      'eslint',
    );
    expect(withFoo).toBe(withBar);
  });

  test('escaped delimiters cannot close a span ("a\\"b" is ONE span)', () => {
    // The body consumes backslash pairs, so the escaped quote does not end
    // the span — changing the volatile tail must not change the signature.
    expect(messageTemplate('Invalid value "a\\"b"')).toBe('Invalid value <str>');
    const withB = clusterSignature(failureOf({ message: 'Invalid value "a\\"b"' }), 'eslint');
    const withC = clusterSignature(failureOf({ message: 'Invalid value "a\\"c"' }), 'eslint');
    expect(withB).toBe(withC);
  });

  test('a Windows path in quotes abstracts as ONE <str> span (escape pairs consumed)', () => {
    // Each \X inside the span is consumed as an escape pair, so the back
    //slashes cannot break the span and the closer is still found — the
    // whole span abstracts (the documented Windows-path tradeoff).
    expect(messageTemplate("cannot read 'C:\\temp\\log'")).toBe('cannot read <str>');
  });

  test('linear scan at scale: 2000 space-preceded apostrophes pair into 1000 spans (identical semantics)', () => {
    // Every apostrophe after the first is the previous opener's CLOSER
    // candidate, so this many-opener input pairs into spans rather than
    // failing — the exact output is pinned via .repeat, which also pins
    // the scanner's linear single-pass shape (no per-opener tail rescans).
    const message = "'a ".repeat(2000);
    // The pipeline's trailing trim removes the final space of the last
    // literal 'a ' unit.
    const expected = '<str>a '.repeat(999) + '<str>a';
    expect(messageTemplate(message)).toBe(expected);
  });

  test('a failed opener (no closer in the tail) makes the rest of the message literal', () => {
    // The failed-opener rule: the single apostrophe opens, the scan
    // exhausts the tail without a closer, and the style goes dead — the
    // whole message passes through literally. Exact output pinned.
    const message = `'${'a'.repeat(4000)}`;
    expect(messageTemplate(message)).toBe(message);
  });

  test('pathological tokens normalize with correct output (token-wise scan, unbounded messages)', () => {
    const longToken = 'a'.repeat(200_000);
    // With a separator: the whole maximal non-space run is one <path>.
    expect(messageTemplate(`${longToken}/x`)).toBe('<path>');
    // Without a separator: passed through unchanged — the case a
    // backtracking path regex makes quadratic on adversarial input.
    expect(messageTemplate(longToken)).toBe(longToken);
  });
});

describe('clusterSignature (the ledger-matching form)', () => {
  test('is the canonical JSON tuple: tool, ruleId (null stays null — never coerced), template', () => {
    expect(
      clusterSignature(failureOf({ ruleId: 'prefer-const', message: 'x is 3' }), 'eslint'),
    ).toBe(JSON.stringify(['eslint', 'prefer-const', 'x is <num>']));
    expect(clusterSignature(failureOf({ ruleId: null, message: 'a' }), 'vitest')).toBe(
      JSON.stringify(['vitest', null, 'a']),
    );
  });

  test('volatile fragments do not change the signature; ANY other change does', () => {
    const base = clusterSignature(failureOf({ message: "'a' used at line 3" }), 'eslint');
    expect(clusterSignature(failureOf({ message: "'b' used at line 99" }), 'eslint')).toBe(base);
    expect(clusterSignature(failureOf({ message: "'a' used at line 3" }), 'tsc')).not.toBe(base);
    expect(
      clusterSignature(failureOf({ ruleId: 'other', message: "'a' used at line 3" }), 'eslint'),
    ).not.toBe(base);
  });

  test('a very long message yields a bounded, deterministic signature (ledger record seam)', () => {
    const long = 'x'.repeat(5000);
    const signature = clusterSignature(failureOf({ message: long }), 'eslint');
    expect(signature.length).toBeLessThanOrEqual(SIGNATURE_MAX_CHARS);
    expect(clusterSignature(failureOf({ message: long }), 'eslint')).toBe(signature);
    // Distinct long messages stay distinct when they differ BEFORE the cut…
    expect(clusterSignature(failureOf({ message: 'y'.repeat(5000) }), 'eslint')).not.toBe(
      signature,
    );
    // …and the DOCUMENTED coarseness: messages differing only after the
    // truncation point sign ONE signature (accepted prefix-collision class).
    expect(clusterSignature(failureOf({ message: `${long}suffix` }), 'eslint')).toBe(signature);
  });

  test('escape inflation near the cut exercises the MULTI-iteration truncation path', () => {
    // One raw double quote sits INSIDE the first budget window, so the
    // first cut escapes it (+1 JSON unit) and overflows the bound by one —
    // the loop must shrink the budget and cut again. Both calls agree
    // (determinism) and terminate UNDER the bound.
    const message = `${'x'.repeat(450)}"${'x'.repeat(5000)}`;
    const signature = clusterSignature(failureOf({ message }), 'eslint');
    expect(signature.length).toBeLessThanOrEqual(SIGNATURE_MAX_CHARS);
    expect(clusterSignature(failureOf({ message }), 'eslint')).toBe(signature);
    // Truncation actually happened (the marker is present).
    expect(signature).toContain('…');
  });

  test('escape-inflated overhead: the LIBRARY-only over-bound residual, deterministic and terminating', () => {
    // Direct clusterSignature calls bypass the registry's ENCODED-size
    // bounds, so 200 double-quote characters in tool and ruleId are
    // constructible here: each encodes to 402 JSON units (> 120), the
    // fixed overhead inflates past SIGNATURE_MAX_CHARS, the budget bottoms
    // out, and the loop returns the over-bound signature deterministically.
    // Through the op this input cannot pass the registry; the ledger record
    // boundary would reject the over-bound result — no suppression, never
    // wrong suppression.
    const quoted = '"'.repeat(200);
    const failure = failureOf({ ruleId: quoted, message: 'x'.repeat(5000) });
    const signature = clusterSignature(failure, quoted);
    expect(signature.length).toBeGreaterThan(SIGNATURE_MAX_CHARS);
    expect(clusterSignature(failure, quoted)).toBe(signature);
  });
});

describe('clusterErrors decision table', () => {
  test('same rule + same shape across files → ONE high-confidence cluster with all members', () => {
    const set = setOf([
      failureOf({ file: 'src/a.ts', line: 3, message: "'a' is defined but never used" }),
      failureOf({ file: 'src/b.ts', line: 8, message: "'b' is defined but never used" }),
      failureOf({ file: 'src/c.ts', line: 13, message: "'c' is defined but never used" }),
    ]);
    const report = clusterErrors(set);
    expect(report.noise).toEqual([]);
    expect(report.clusters).toHaveLength(1);
    const cluster = report.clusters[0];
    if (cluster === undefined) throw new Error('expected one cluster');
    expect(cluster.confidence).toBe('high');
    expect(cluster.size).toBe(3);
    expect(cluster.tool).toBe('eslint');
    expect(cluster.ruleId).toBe('rule');
    expect(cluster.id).toBe(fnv1a32Hex(cluster.signature));
    expect(cluster.signature).toBe(clusterSignature(cluster.failures[0] as CheckFailure, 'eslint'));
  });

  test('singletons are low-confidence and stay in their OWN cluster (never silently merged)', () => {
    const burstA = failureOf({ file: 'src/a.ts', message: "'x' is defined but never used" });
    const burstB = failureOf({ file: 'src/b.ts', message: "'y' is defined but never used" });
    // A same-rule NEAR-TWIN: its template ('…never used here') differs from
    // the burst's ('…never used') by more than volatile fragments, so v1
    // keeps it a separate low-confidence cluster instead of absorbing it.
    const odd = failureOf({ file: 'src/odd.ts', message: "'z' is defined but never used here" });
    const report = clusterErrors(setOf([burstA, burstB, odd]));
    expect(report.clusters).toHaveLength(2);
    const high = report.clusters.find((cluster) => cluster.size === 2);
    const low = report.clusters.find((cluster) => cluster.size === 1);
    if (high === undefined || low === undefined) throw new Error('expected 2 + 1 split');
    expect(high.confidence).toBe('high');
    expect(high.failures).toEqual([burstA, burstB]);
    expect(low.confidence).toBe('low');
    expect(low.failures).toEqual([odd]);
    // No emitted cluster ever carries the v1-unreachable 'medium'.
    for (const cluster of report.clusters) {
      expect(cluster.confidence).not.toBe('medium');
    }
  });

  test('different shapes of the same rule stay separate (no similarity merging in v1)', () => {
    const set = setOf([
      failureOf({ message: "'a' is defined but never used" }),
      failureOf({ message: 'a is assigned a value but never used' }),
    ]);
    expect(clusterErrors(set).clusters).toHaveLength(2);
  });

  test('severity is NOT part of the signature: the same shape clusters across error/warning', () => {
    const set = setOf([
      failureOf({ severity: 'error', message: "'a' is defined but never used" }),
      failureOf({ severity: 'warning', message: "'b' is defined but never used" }),
    ]);
    const report = clusterErrors(set);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]?.size).toBe(2);
  });

  test('ruleId is identity: identical messages under different rules never cluster together', () => {
    const set = setOf([
      failureOf({ ruleId: 'no-unused-vars', message: 'unused' }),
      failureOf({ ruleId: 'prefer-const', message: 'unused' }),
    ]);
    expect(clusterErrors(set).clusters).toHaveLength(2);
  });

  test('exact duplicates are preserved as members (occurrence count is signal)', () => {
    const same = failureOf({ file: 'src/dup.ts', line: 4 });
    const report = clusterErrors(setOf([same, { ...same }]));
    expect(report.clusters[0]?.size).toBe(2);
  });

  test('member order is the identity key: same-signature pair differing in severity AND message', () => {
    // Everything but severity and the raw message is identical, so the two
    // orderings DISAGREE: the identity tuple orders severity BEFORE message
    // ('error' sorts first), while a JSON.stringify proxy over the fixture
    // literal (message before severity) would pick the warning. Same
    // normalized template → same signature → one cluster, either way.
    const errorVariant = failureOf({
      file: 'src/same.ts',
      line: 5,
      ruleId: 'prefer-const',
      severity: 'error',
      message: "'zz' is assigned a value but never used",
    });
    const warningVariant = failureOf({
      file: 'src/same.ts',
      line: 5,
      ruleId: 'prefer-const',
      severity: 'warning',
      message: "'aa' is assigned a value but never used",
    });
    const report = clusterErrors(setOf([warningVariant, errorVariant]));
    expect(report.clusters).toHaveLength(1);
    const cluster = report.clusters[0];
    if (cluster === undefined) throw new Error('expected one cluster');
    expect(cluster.size).toBe(2);
    // severity ('error' < 'warning' in the identity tuple) decides — the
    // error variant leads despite its later message and later input position.
    expect(cluster.failures).toEqual([errorVariant, warningVariant]);
    // Monotonicity under the IMPLEMENTATION key, not a stringify proxy.
    const firstIdentity = failureIdentity(cluster.failures[0] as CheckFailure, 'eslint');
    const secondIdentity = failureIdentity(cluster.failures[1] as CheckFailure, 'eslint');
    expect(firstIdentity <= secondIdentity).toBe(true);
  });

  test('location-less failures (vitest shape) cluster by test-name shape', () => {
    const set = setOf(
      [
        failureOf({
          file: null,
          line: null,
          column: null,
          ruleId: null,
          message: 'dates > handles 3 cases',
        }),
        failureOf({
          file: null,
          line: null,
          column: null,
          ruleId: null,
          message: 'dates > handles 9 cases',
        }),
      ],
      'vitest',
    );
    const report = clusterErrors(set);
    expect(report.clusters).toHaveLength(1); // shape-identical names merge — documented
    expect(report.clusters[0]?.signature).toBe(
      JSON.stringify(['vitest', null, 'dates > handles <num> cases']),
    );
  });

  test('a null ruleId and an EMPTY-STRING ruleId are distinct signatures (no coercion), in any order', () => {
    const nullRule = failureOf({ file: 'src/n.ts', line: 1, ruleId: null, message: 'same shape' });
    const emptyRule = failureOf({ file: 'src/e.ts', line: 2, ruleId: '', message: 'same shape' });
    const forward = clusterErrors(setOf([nullRule, emptyRule]));
    const backward = clusterErrors(setOf([emptyRule, nullRule]));
    expect(forward.clusters).toHaveLength(2);
    // Order-invariant, and each cluster reports its own ruleId — the
    // members[0] read is deterministic because signature equality implies
    // an identical ruleId value.
    expect(forward.clusters).toEqual(backward.clusters);
    const byRuleId = new Map(forward.clusters.map((cluster) => [cluster.ruleId, cluster]));
    expect(byRuleId.get(null)?.failures).toEqual([nullRule]);
    expect(byRuleId.get('')?.failures).toEqual([emptyRule]);
  });

  test('empty set → empty report (clustering nothing asserts nothing)', () => {
    expect(clusterErrors(setOf([], 'eslint', 0))).toEqual({ clusters: [], noise: [] });
  });

  test('deterministic ordering: clusters by id, members and noise by exact identity', () => {
    const set = setOf([
      failureOf({ file: 'src/z.ts', line: 1, ruleId: 'rule-b', message: 'shape one 1' }),
      failureOf({ file: 'src/a.ts', line: 2, ruleId: 'rule-b', message: 'shape one 2' }),
      failureOf({ file: 'src/m.ts', line: 3, ruleId: 'rule-a', message: 'shape two' }),
    ]);
    const report = clusterErrors(set);
    const ids = report.clusters.map((cluster) => cluster.id);
    expect([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ids);
    for (const cluster of report.clusters) {
      const first = cluster.failures[0];
      const last = cluster.failures[cluster.failures.length - 1];
      if (first === undefined || last === undefined) throw new Error('empty cluster');
      // The REAL sort key — failureIdentity — not a stringify proxy.
      const firstIdentity = failureIdentity(first, 'eslint');
      const lastIdentity = failureIdentity(last, 'eslint');
      expect(firstIdentity <= lastIdentity).toBe(true);
    }
  });

  test('distinct signatures colliding on the 32-bit id still sort deterministically (pinned pair)', () => {
    // A GENUINE FNV-1a-32 collision, found by an offline brute-force search
    // over random letter-only template candidates (236,728 tried; the pair
    // is hard-coded so this test executes the signature tiebreak in the
    // cluster sort). Both templates are pure letters, so messageTemplate
    // leaves them unchanged and the failures' computed signatures equal
    // these strings verbatim.
    const sigA = JSON.stringify(['eslint', 'r', 'tjivlzyj']);
    const sigB = JSON.stringify(['eslint', 'r', 'qcmqx']);
    expect(sigA).not.toBe(sigB);
    expect(fnv1a32Hex(sigA)).toBe('e6854fd8');
    expect(fnv1a32Hex(sigB)).toBe('e6854fd8');
    const a = failureOf({ file: 'src/a.ts', ruleId: 'r', message: 'tjivlzyj' });
    const b = failureOf({ file: 'src/b.ts', ruleId: 'r', message: 'qcmqx' });
    const forward = clusterErrors(setOf([a, b]));
    const backward = clusterErrors(setOf([b, a]));
    expect(forward.clusters).toHaveLength(2); // distinct signatures: never merged
    const first = forward.clusters[0];
    const second = forward.clusters[1];
    if (first === undefined || second === undefined) throw new Error('expected two clusters');
    // The tie is REAL: two distinct signatures, one 32-bit id — both
    // singleton clusters report low confidence.
    expect(first.id).toBe(second.id);
    expect(first.id).toBe('e6854fd8');
    expect(first.confidence).toBe('low');
    expect(second.confidence).toBe('low');
    // Sorted by SIGNATURE within the tie (sigB < sigA code-unit-wise),
    // identically for both input orders — never by insertion order.
    expect(first.signature).toBe(sigB);
    expect(second.signature).toBe(sigA);
    expect(first.failures).toEqual([b]);
    expect(second.failures).toEqual([a]);
    expect(forward.clusters).toEqual(backward.clusters);
  });
});

describe('clusterErrors × ledger (known noise never clusters as signal)', () => {
  const noisy = failureOf({
    file: 'src/noisy.ts',
    line: 5,
    message: "'n' is defined but never used",
  });
  // A different message SHAPE, so it does not share noisy's signature and
  // genuinely tests that suppression is per-signature, not global.
  const signal = failureOf({
    file: 'src/signal.ts',
    line: 7,
    message: "'s' is assigned a value but never used",
  });

  test('a failure whose CLUSTER SIGNATURE is in knownNoise goes to noise, not clusters', () => {
    const signature = clusterSignature(noisy, 'eslint');
    const report = clusterErrors(setOf([noisy, signal]), ledgerOf([signature]));
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]?.failures).toEqual([signal]);
    expect(report.noise).toEqual([noisy]);
    // Noise never leaks into any cluster, by identity.
    for (const cluster of report.clusters) {
      expect(cluster.failures).not.toContainEqual(noisy);
    }
  });

  test('the seam is signature-form: a ledger entry recorded as the RAW message never matches', () => {
    const report = clusterErrors(setOf([noisy]), ledgerOf([noisy.message]));
    expect(report.noise).toEqual([]);
    expect(report.clusters).toHaveLength(1);
  });

  test('a needsHuman escalation (count ≥ escalateAt) is inside knownNoise and is excluded', () => {
    const signature = clusterSignature(noisy, 'eslint');
    const ledger: LedgerView = {
      entries: [{ signature, count: 3 }],
      knownNoise: [signature],
      needsHuman: [signature],
    };
    const report = clusterErrors(setOf([noisy]), ledger);
    expect(report.noise).toEqual([noisy]);
    expect(report.clusters).toEqual([]);
  });

  test('knownNoise with NO grounding entry throws (stale or hand-built view)', () => {
    const signature = clusterSignature(noisy, 'eslint');
    const stale: LedgerView = { entries: [], knownNoise: [signature], needsHuman: [] };
    expect(() => clusterErrors(setOf([noisy]), stale)).toThrow(/knownNoise.*entry/);
    // A view whose entries DO contain the signature still suppresses.
    const grounded = clusterErrors(setOf([noisy]), ledgerOf([signature]));
    expect(grounded.noise).toEqual([noisy]);
  });

  test('a hand-built view violating needsHuman ⊆ knownNoise throws (enforced, not assumed)', () => {
    const signature = clusterSignature(noisy, 'eslint');
    const badView: LedgerView = {
      entries: [{ signature, count: 3 }],
      knownNoise: [],
      needsHuman: [signature],
    };
    expect(() => clusterErrors(setOf([noisy]), badView)).toThrow(/needsHuman.*knownNoise/);
  });

  test('no ledger (or an empty view) suppresses nothing', () => {
    expect(clusterErrors(setOf([noisy])).noise).toEqual([]);
    expect(clusterErrors(setOf([noisy]), ledgerOf([])).noise).toEqual([]);
  });

  test('a ledger recorded under a DIFFERENT tool namespace does not match', () => {
    const signature = clusterSignature(noisy, 'tsc'); // wrong tool in the signature
    const report = clusterErrors(setOf([noisy]), ledgerOf([signature]));
    expect(report.noise).toEqual([]);
  });
});

describe('clusterErrors order-invariance property (seeded, deterministic)', () => {
  /** mulberry32 — tiny seeded PRNG; a fixed seed makes the property deterministic. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fisher-Yates over a copy; the input array is never mutated. */
  function shuffled<T>(items: readonly T[], rng: () => number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const swap = copy[i];
      const other = copy[j];
      if (swap === undefined || other === undefined) throw new Error('shuffle index out of range');
      copy[i] = other;
      copy[j] = swap;
    }
    return copy;
  }

  // Four signatures: two multi-member bursts (shape-identical messages that
  // differ only in volatile fragments), one singleton, one known-noise
  // signature — so the property covers ids, confidence, membership, AND the
  // noise split.
  const fixture: CheckFailure[] = [
    failureOf({
      file: 'src/a.ts',
      line: 1,
      ruleId: 'no-unused-vars',
      message: "'a' unused at line 1",
    }),
    failureOf({
      file: 'src/b.ts',
      line: 2,
      ruleId: 'no-unused-vars',
      message: "'b' unused at line 22",
    }),
    failureOf({
      file: 'src/c.ts',
      line: 3,
      ruleId: 'no-unused-vars',
      message: "'c' unused at line 333",
    }),
    failureOf({
      file: 'src/d.ts',
      line: 4,
      ruleId: 'prefer-const',
      message: 'expected 2 args, got 3',
    }),
    failureOf({
      file: 'src/e.ts',
      line: 5,
      ruleId: 'prefer-const',
      message: 'expected 7 args, got 1',
    }),
    failureOf({ file: 'src/f.ts', line: 6, ruleId: 'lonely-rule', message: 'one of a kind' }),
    failureOf({ file: 'src/g.ts', line: 7, ruleId: 'noisy-rule', message: 'noise burst 1' }),
    failureOf({ file: 'src/h.ts', line: 8, ruleId: 'noisy-rule', message: 'noise burst 2' }),
  ];
  const noiseSignature = clusterSignature(fixture[6] as CheckFailure, 'eslint');
  const ledger = ledgerOf([noiseSignature]);

  test('every permutation yields identical ids, confidence, membership, and noise (40 iterations)', () => {
    const rng = mulberry32(0xc1a57e8);
    const reference = clusterErrors(setOf(fixture), ledger);
    expect(reference.clusters).toHaveLength(3);
    expect(reference.noise).toHaveLength(2);
    expect(reference.clusters.map((cluster) => cluster.confidence).sort()).toEqual([
      'high',
      'high',
      'low',
    ]);
    for (let i = 0; i < 40; i++) {
      expect(clusterErrors(setOf(shuffled(fixture, rng)), ledger)).toEqual(reference);
    }
  });

  test('the ids are content-derived: the same failures under a different tool namespace re-key', () => {
    const reference = clusterErrors(setOf(fixture), ledger);
    const otherTool = clusterErrors(setOf(fixture, 'tsc'));
    expect(otherTool.clusters).toHaveLength(4); // the suppressed noise pair clusters as tsc signal
    for (const cluster of reference.clusters) {
      expect(cluster.tool).toBe('eslint');
      // Every signature embeds its tool, so no tsc signature equals an eslint one.
      for (const other of otherTool.clusters) {
        expect(other.signature).not.toBe(cluster.signature);
      }
    }
  });
});

describe('clusterErrorsOp', () => {
  test('ok with the report, including the optional ledger input', async () => {
    const noisy = failureOf({ message: 'known noise' });
    const signature = clusterSignature(noisy, 'eslint');
    const result = await clusterErrorsOp({ set: setOf([noisy]), ledger: ledgerOf([signature]) });
    expect(result).toEqual({
      status: 'ok',
      value: { clusters: [], noise: [noisy] },
    });
  });

  test('ok on an empty set (an empty report asserts nothing)', async () => {
    const result = await clusterErrorsOp({ set: setOf([], 'eslint', 0) });
    expect(result).toEqual({ status: 'ok', value: { clusters: [], noise: [] } });
  });

  test('an invariant-violating ledger view maps the policy throw to failed', async () => {
    const escalated = failureOf({ message: 'escalated but unsuppressed' });
    const signature = clusterSignature(escalated, 'eslint');
    const result = await clusterErrorsOp({
      set: setOf([escalated]),
      ledger: { entries: [], knownNoise: [], needsHuman: [signature] },
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('needsHuman');
    expect(result.error).toContain(signature);
  });

  test('an ungrounded knownNoise view maps the policy throw to failed', async () => {
    const neverRecorded = failureOf({ message: 'never recorded anywhere' });
    const signature = clusterSignature(neverRecorded, 'eslint');
    const result = await clusterErrorsOp({
      set: setOf([neverRecorded]),
      ledger: { entries: [], knownNoise: [signature], needsHuman: [] },
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('knownNoise');
    expect(result.error).toContain(signature);
  });
});
