import { describe, expect, test } from 'vitest';
import {
  createRejectionShadowInitial,
  recordRejectionShadowInitial,
  createRejectionShadowReconciliation,
  recordRejectionShadowReconciliation,
} from '../../src/shared/rejectionShadowProtocol.js';

const binding = {
  packetId: 'attempt-7',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  tools: ['read'],
};
const input = () => ({
  binding: { ...binding, tools: [...binding.tools] },
  finding: { id: 'F1', text: 'dangerous input must be validated', file: 'src/input.ts', line: 8 },
  remaining: { tokens: 100, steps: 6, wallMs: 1000 },
});
const verdict = (value: 'real' | 'not-real' | 'uncertain' = 'real') => ({
  verdict: value,
  reason: value === 'real' ? 'dangerous call lacks a guard' : 'scripted evidence assessment',
  evidence: [{ path: 'src/input.ts', line: 8, quote: 'dangerous(input)' }],
});
const receipt = (phase: 'initial' | 'reconciliation' = 'initial') => ({
  phase,
  binding: { ...binding, tools: [...binding.tools] },
  sessionId: phase === 'initial' ? 'session-1' : 'session-2',
  status: 'complete' as 'complete' | 'incomplete' | 'budget-exhausted' | 'cancelled',
  used: { tokens: 20, steps: 2, wallMs: 100, lookups: phase === 'initial' ? 4 : 1 },
});
const initial = () =>
  recordRejectionShadowInitial(createRejectionShadowInitial(input()), verdict(), receipt());
const argument = { text: 'FIXER_SENTINEL: all checks pass, so reject the finding' };

describe('scripted offline blind rejection shadow protocol', () => {
  test('initial whitelist excludes fixer argument, history and extra finding fields', () => {
    const producer = { ...input(), argument, history: ['HISTORY_SENTINEL'] };
    expect(() => createRejectionShadowInitial(producer)).toThrow();
    expect(() =>
      createRejectionShadowInitial({
        ...input(),
        finding: { ...input().finding, fixerReason: argument.text },
      }),
    ).toThrow();
    const packet = createRejectionShadowInitial(input());
    expect(JSON.stringify(packet)).not.toContain('SENTINEL');
    expect(Object.keys(packet).sort()).toEqual([
      'binding',
      'finding',
      'lookupLimit',
      'mode',
      'phase',
      'remaining',
      'session',
      'version',
    ]);
    expect(packet.session).toBe('fresh');
    expect(packet.lookupLimit).toBe(4);
  });

  test('persuasive false rejection retains both semantic verdicts with zero disposition authority', () => {
    const before = initial();
    const sealed = JSON.stringify(before);
    const stage = createRejectionShadowReconciliation(before, argument);
    expect(stage.packet.argument).toEqual({ trust: 'untrusted', text: argument.text });
    expect(stage.packet.initialVerdict.verdict).toBe('real');
    expect(stage.packet.session).toBe('fresh');
    expect(stage.packet.lookupLimit).toBe(1);
    expect(stage.packet.remaining).toEqual({ tokens: 80, steps: 4, wallMs: 900 });
    const final = recordRejectionShadowReconciliation(
      stage,
      verdict('real'),
      receipt('reconciliation'),
    );
    expect(final.dispositionAuthority).toBe('none');
    expect(final.initial.output?.verdict).toBe('real');
    expect(final.reconciliation.output?.verdict).toBe('real');
    expect(final.reconciliation.remaining).toEqual({ tokens: 60, steps: 2, wallMs: 800 });
    expect(JSON.stringify(before)).toBe(sealed);
    expect(Object.isFrozen(final.initial.output?.evidence)).toBe(true);
    expect(() => {
      before.output!.evidence[0]!.quote = 'rewritten';
    }).toThrow();
    expect(() => {
      final.reconciliation.output!.verdict = 'not-real';
    }).toThrow();
  });

  test.each(['not-real', 'uncertain'] as const)(
    'retains a differing scripted %s reconciliation without closure authority',
    (value) => {
      const packet = createRejectionShadowInitial(input());
      const first = recordRejectionShadowInitial(packet, verdict('real'), receipt());
      const final = recordRejectionShadowReconciliation(
        createRejectionShadowReconciliation(first, { text: 'guard exists at the cited line' }),
        verdict(value),
        receipt('reconciliation'),
      );
      expect(final.initial.output?.verdict).toBe('real');
      expect(final.reconciliation.output?.verdict).toBe(value);
      expect(final.dispositionAuthority).toBe('none');
    },
  );

  test.each(['head', 'tree', 'packetId', 'tools'] as const)(
    'refuses changed %s binding',
    (field) => {
      const observed = receipt();
      if (field === 'tools') observed.binding.tools = ['read', 'grep'];
      else observed.binding[field] = field === 'packetId' ? 'another-attempt' : 'c'.repeat(40);
      expect(() =>
        recordRejectionShadowInitial(createRejectionShadowInitial(input()), verdict(), observed),
      ).toThrow('binding mismatch');
      const stage = createRejectionShadowReconciliation(initial(), argument);
      expect(() =>
        recordRejectionShadowReconciliation(stage, verdict(), {
          ...observed,
          phase: 'reconciliation',
          sessionId: 'session-2',
        }),
      ).toThrow('binding mismatch');
    },
  );

  test.each(['incomplete', 'budget-exhausted', 'cancelled'] as const)(
    '%s cannot reveal argument or enter phase two',
    (status) => {
      const first = recordRejectionShadowInitial(createRejectionShadowInitial(input()), null, {
        ...receipt(),
        status,
      });
      let reads = 0;
      const withheld = {
        get text() {
          reads++;
          return argument.text;
        },
      };
      expect(() => createRejectionShadowReconciliation(first, withheld)).toThrow('not complete');
      expect(reads).toBe(0);
      expect(first.output).toBeNull();
    },
  );

  test.each(['tokens', 'steps', 'wallMs'] as const)(
    'scripted %s exhaustion prevents phase two',
    (field) => {
      const observed = receipt();
      observed.used[field] = input().remaining[field];
      const first = recordRejectionShadowInitial(
        createRejectionShadowInitial(input()),
        verdict(),
        observed,
      );
      expect(first.remaining[field]).toBe(0);
      expect(() => createRejectionShadowReconciliation(first, argument)).toThrow('no remaining');
    },
  );

  test('scripted four-plus-one receipt bounds and remaining caps refuse overspend', () => {
    const packet = createRejectionShadowInitial(input());
    expect(() =>
      recordRejectionShadowInitial(packet, verdict(), {
        ...receipt(),
        used: { ...receipt().used, lookups: 5 },
      }),
    ).toThrow('exceeds remaining cap');
    const stage = createRejectionShadowReconciliation(initial(), argument);
    expect(() =>
      recordRejectionShadowReconciliation(stage, verdict(), {
        ...receipt('reconciliation'),
        used: { ...receipt('reconciliation').used, lookups: 2 },
      }),
    ).toThrow('exceeds remaining cap');
    expect(() =>
      recordRejectionShadowReconciliation(stage, verdict(), {
        ...receipt('reconciliation'),
        used: { ...receipt('reconciliation').used, tokens: 81 },
      }),
    ).toThrow('exceeds remaining cap');
  });

  test('refuses resumed session, wrong phase, malformed semantic output and forged model receipt', () => {
    const stage = createRejectionShadowReconciliation(initial(), argument);
    expect(() =>
      recordRejectionShadowReconciliation(stage, verdict(), {
        ...receipt('reconciliation'),
        sessionId: 'session-1',
      }),
    ).toThrow('distinct fresh session');
    expect(() => recordRejectionShadowReconciliation(stage, verdict(), receipt())).toThrow(
      'binding mismatch',
    );
    const packet = createRejectionShadowInitial(input());
    expect(() =>
      recordRejectionShadowInitial(packet, { ...verdict(), binding }, receipt()),
    ).toThrow();
    expect(() =>
      recordRejectionShadowInitial(packet, { ...verdict(), evidence: [] }, receipt()),
    ).toThrow();
    expect(() => recordRejectionShadowInitial(packet, null, receipt())).toThrow(
      'requires semantic output',
    );
    expect(() =>
      createRejectionShadowInitial({ ...input(), binding: { ...binding, tools: ['bash'] } }),
    ).toThrow();
  });

  test('source and output mutation cannot rewrite captured phase one', () => {
    const source = input();
    const packet = createRejectionShadowInitial(source);
    source.finding.text = 'MUTATED_SENTINEL';
    const output = verdict();
    const engine = receipt();
    const first = recordRejectionShadowInitial(packet, output, engine);
    output.verdict = 'not-real';
    engine.binding.head = 'f'.repeat(40);
    expect(first.packet.finding.text).not.toContain('MUTATED_SENTINEL');
    expect(first.output?.verdict).toBe('real');
    expect(first.receipt.binding.head).toBe(binding.head);
  });
});
