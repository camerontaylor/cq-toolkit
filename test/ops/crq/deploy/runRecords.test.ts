import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  Refused,
  claimRunDir,
  complete,
  persistRecoveryReceipt,
  pyEqual,
  runStamp,
  type ClaimRunDirEffects,
  type CompleteEffects,
  type RecoveryReceiptEffects,
  type RecoveryReceiptInput,
} from '../../../../src/ops/crq/deploy/runRecords.js';

function claimFixture(over: Partial<ClaimRunDirEffects> = {}): {
  effects: ClaimRunDirEffects;
  log: string[];
} {
  const log: string[] = [];
  const effects: ClaimRunDirEffects = {
    resolve: (p) => (p.startsWith('/') ? p : `/cwd/${p}`),
    join: (b, n) => `${b}/${n}`,
    mkdirPrivateAll: (p) => {
      log.push(`mkdirAll:${p}`);
    },
    mode: () => 0o700,
    mkdirPrivate: (p) => {
      log.push(`mkdir:${p}`);
    },
    now: () => new Date(Date.UTC(2026, 10, 5, 3, 4, 9)),
    uuidHex: () => 'abcdef0123456789',
    ...over,
  };
  return { effects, log };
}
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Refused);
    return (e as Error).message;
  }
  throw new Error('did not throw');
};

describe('claimRunDir', () => {
  test('creates a private run dir named from the UTC stamp and 6 uuid hex chars', () => {
    const f = claimFixture();
    expect(claimRunDir(f.effects, '/rec', '/live')).toBe('/rec/run-20261105T030409Z-abcdef');
    expect(f.log).toEqual(['mkdirAll:/rec', 'mkdir:/rec/run-20261105T030409Z-abcdef']);
  });

  test.each([
    ['same as root', '/live', '/live'],
    ['inside root', '/live/records', '/live'],
    ['inside root, trailing slash root', '/live/records', '/live/'],
    ['inside the filesystem root', '/anything', '/'],
  ])('refuses a record dir %s before creating anything', (_n, rec, root) => {
    const f = claimFixture();
    expect(message(() => claimRunDir(f.effects, rec, root))).toBe(
      '--record-dir must be outside the deployment checkout',
    );
    expect(f.log).toEqual([]);
  });

  test.each([
    ['a sibling with the root as name prefix', '/live-records', '/live'],
    ['the root’s parent', '/', '/live'],
    ['unrelated', '/var/rec', '/live'],
  ])('accepts %s', (_n, rec, root) => {
    claimRunDir(claimFixture().effects, rec, root);
  });

  test('resolution is applied to both sides (a symlinked record dir is judged by its target)', () => {
    const f = claimFixture({ resolve: (p) => (p === '/link' ? '/live/inside' : p) });
    expect(message(() => claimRunDir(f.effects, '/link', '/live'))).toContain('outside');
  });

  test.each([0o770, 0o707, 0o750, 0o755, 0o777, 0o700 | 0o001])(
    'refuses mode %o and creates no run dir',
    (mode) => {
      const f = claimFixture({ mode: () => mode });
      expect(message(() => claimRunDir(f.effects, '/rec', '/live'))).toBe(
        'private record directory must have mode 0700: /rec',
      );
      expect(f.log).toEqual(['mkdirAll:/rec']);
    },
  );

  test('modes 0700 and 0500 are accepted, as Python only tests the group/other bits', () => {
    for (const mode of [0o700, 0o500, 0o600])
      claimRunDir(claimFixture({ mode: () => mode }).effects, '/rec', '/live');
  });

  test('an existing run dir surfaces the mkdir error', () => {
    const f = claimFixture({
      mkdirPrivate: () => {
        throw new Error('EEXIST');
      },
    });
    expect(() => claimRunDir(f.effects, '/rec', '/live')).toThrow('EEXIST');
  });

  test('the stamp is zero padded and UTC', () => {
    expect(runStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('20260102T030405Z');
    expect(runStamp(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe('20261231T235959Z');
  });
});

const input: RecoveryReceiptInput = {
  runDir: '/rec/run-1',
  target: 't'.repeat(40),
  priorSha: 'p'.repeat(40),
  originalTriggers: { 'crq-a.timer': 'active' },
  cqBin: { pointer: '/x', placeholder: false },
  originalConfig: new TextEncoder().encode('cfg'),
  preserved: { queue: 'abc' },
};
function receiptFixture(existing?: unknown): {
  effects: RecoveryReceiptEffects;
  writes: [string, Record<string, unknown>][];
  loads: string[];
} {
  const writes: [string, Record<string, unknown>][] = [];
  const loads: string[] = [];
  return {
    writes,
    loads,
    effects: {
      exists: () => existing !== undefined,
      loadJson: (p) => {
        loads.push(p);
        return existing;
      },
      durableWrite: (p, v) => {
        writes.push([p, v]);
      },
      nowIso: () => '2026-11-05T03:04:09Z',
    },
  };
}

describe('persistRecoveryReceipt', () => {
  test('writes the full receipt once when none exists', () => {
    const f = receiptFixture();
    persistRecoveryReceipt(f.effects, input);
    expect(f.writes).toEqual([
      [
        '/rec/run-1/recovery-receipt.json',
        {
          operation: 'deploy',
          written_at: '2026-11-05T03:04:09Z',
          target: input.target,
          prior_sha: input.priorSha,
          original_triggers: { 'crq-a.timer': 'active' },
          cq_bin: input.cqBin,
          config_sha256: createHash('sha256').update('cfg').digest('hex'),
          preserved: { queue: 'abc' },
        },
      ],
    ]);
  });

  test('a trailing slash on the run dir does not double the separator', () => {
    const f = receiptFixture();
    persistRecoveryReceipt(f.effects, { ...input, runDir: '/rec/run-1/' });
    expect(f.writes[0]![0]).toBe('/rec/run-1/recovery-receipt.json');
  });

  test('an identical existing receipt (other stamp) is kept and not rewritten', () => {
    const base = receiptFixture();
    persistRecoveryReceipt(base.effects, input);
    const stored = { ...base.writes[0]![1], written_at: 'older' };
    const f = receiptFixture(stored);
    persistRecoveryReceipt(f.effects, input);
    expect(f.writes).toEqual([]);
    expect(f.loads).toEqual(['/rec/run-1/recovery-receipt.json']);
  });

  test.each([
    ['target', { target: 'x' }],
    ['prior_sha', { prior_sha: 'x' }],
    ['original_triggers', { original_triggers: {} }],
    ['cq_bin', { cq_bin: null }],
    ['config_sha256', { config_sha256: '0' }],
    ['preserved', { preserved: {} }],
    ['operation', { operation: 'other' }],
    ['an extra key', { extra: 1 }],
  ])('a differing %s refuses without writing', (_n, patch) => {
    const base = receiptFixture();
    persistRecoveryReceipt(base.effects, input);
    const f = receiptFixture({ ...base.writes[0]![1], ...patch });
    expect(message(() => persistRecoveryReceipt(f.effects, input))).toBe(
      'the recovery receipt in /rec/run-1 already exists with different content; refusing to mutate the recorded evidence',
    );
    expect(f.writes).toEqual([]);
  });

  test('a missing key in the stored receipt refuses', () => {
    const base = receiptFixture();
    persistRecoveryReceipt(base.effects, input);
    const { preserved: _p, ...rest } = base.writes[0]![1];
    expect(message(() => persistRecoveryReceipt(receiptFixture(rest).effects, input))).toContain(
      'different content',
    );
  });

  test('a non-object stored receipt is a plain error (Python crashes on pop)', () => {
    for (const bad of [[], 'x', null, 3]) {
      let e: unknown;
      try {
        persistRecoveryReceipt(receiptFixture(bad).effects, input);
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(TypeError);
      expect(e).not.toBeInstanceOf(Refused);
    }
  });
});

describe('pyEqual', () => {
  test('follows Python == for JSON data', () => {
    expect(pyEqual(1, true)).toBe(true);
    expect(pyEqual(0, false)).toBe(true);
    expect(pyEqual(1, 2)).toBe(false);
    expect(pyEqual('1', 1)).toBe(false);
    expect(pyEqual(null, null)).toBe(true);
    expect(pyEqual(null, {})).toBe(false);
    expect(pyEqual([1, 2], [1, 2])).toBe(true);
    expect(pyEqual([1], [1, 2])).toBe(false);
    expect(pyEqual([], {})).toBe(false);
    expect(pyEqual({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(pyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(pyEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(pyEqual({ a: undefined }, { b: undefined })).toBe(false);
  });
});

describe('complete', () => {
  test('sets rollback evidence before the record, then phase, then narration', () => {
    const log: unknown[] = [];
    const effects: CompleteEffects = {
      setRollback: (r) => log.push(['rollback', r]),
      writeRecord: (o, e) => log.push(['record', o, e]),
      phase: (n, e) => log.push(['phase', n, e]),
      narrate: (m) => log.push(['narrate', m]),
    };
    complete(effects, {
      priorSha: 'p'.repeat(40),
      target: 't'.repeat(40),
      cqBin: { pointer: '/x' },
      finalTriggers: { 'crq-a.timer': 'active' },
    });
    expect(log).toEqual([
      [
        'rollback',
        {
          permitted: true,
          to: 'p'.repeat(40),
          cq_bin: { pointer: '/x' },
          statement:
            'rollback is available while the queue carries no schema marker or author_* keys; this run invoked it only on failure',
        },
      ],
      ['record', 'completed', { released: true }],
      ['phase', 'released', { triggers: { 'crq-a.timer': 'active' } }],
      ['narrate', `deployed ${'t'.repeat(12)} (was ${'p'.repeat(12)}); health ok`],
    ]);
  });

  test('a failing record stops before the phase and the narration', () => {
    const log: string[] = [];
    const effects: CompleteEffects = {
      setRollback: () => log.push('rollback'),
      writeRecord: () => {
        throw new Error('disk');
      },
      phase: () => log.push('phase'),
      narrate: () => log.push('narrate'),
    };
    expect(() =>
      complete(effects, { priorSha: 'p', target: 't', cqBin: null, finalTriggers: {} }),
    ).toThrow('disk');
    expect(log).toEqual(['rollback']);
  });
});
