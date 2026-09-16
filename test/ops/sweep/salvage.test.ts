// Sweep lane (WS-D, goal D2) — evidence for the salvage classifier
// (src/ops/sweep/salvage.ts; UC §1 row 7; R2 D8).
//
// Pinned here, on injected fake effects unless stated:
//   1. THE CLASS TABLE (R2 D8): clean-done → reuse; half-done (strictly
//      clean, partial journal progress) → resume; dirty → preserve;
//      absent path → an absent ROW, not an error; a FAILED liveness or
//      clean probe → indeterminate NAMING the fault — never discard, never
//      a silent skip.
//   2. THE DIRTY LADDER IS EXPLICIT-ONLY: salvage NEVER classifies a dirty
//      tree `discard` without the explicit discardDirty flag; with the flag
//      the row only MARKS discard-eligibility (stash-first) — the seam has
//      NO mutating effects, so no classification can ever delete.
//   3. PATH CANONICALIZATION: rows carry the canonical form (realpath /
//      lexical fallback idiom as an injected effect).
//   4. COUNTS: all six classes present, zeros included, summing to the rows.
//   5. THE BOUNDARY: every input defect is a single `failed` result naming
//      the field — never an escaping TypeError.
import { describe, expect, test } from 'vitest';
import { makeSalvage, makeSubprocessSalvageEffects } from '../../../src/ops/sweep/salvage.js';
import type {
  SalvageEffects,
  SalvageInput,
  SalvagePlan,
  SalvageRow,
} from '../../../src/ops/sweep/salvage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTRY = '/runs/wt/fix/core';

function inputOf(entries: SalvageInput['entries'], discardDirty?: boolean): SalvageInput {
  return discardDirty === undefined
    ? { repoRoot: '/repo', entries }
    : { repoRoot: '/repo', entries, discardDirty };
}

/** Unwraps an `ok` plan; anything else fails the test with what came back. */
async function okPlan(
  op: ReturnType<typeof makeSalvage>,
  input: SalvageInput,
): Promise<SalvagePlan> {
  const result = await op(input);
  if (result.status !== 'ok') {
    throw new Error(
      `expected ok, got ${result.status}: ${result.status === 'failed' ? result.error : result.status}`,
    );
  }
  return result.value;
}

/** Unwraps a `failed` result's error; any other status fails the test. */
async function failedAt(op: ReturnType<typeof makeSalvage>, input: SalvageInput): Promise<string> {
  const result = await op(input);
  if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  return result.error;
}

/** Recording fake effects: dirs that exist, the clean subset, canonical mapping. */
interface FakeWorld {
  dirs: Set<string>;
  clean: Set<string>;
  canonical: Map<string, string>;
  calls: string[];
}

function fakeWorld(): FakeWorld {
  return { dirs: new Set(), clean: new Set(), canonical: new Map(), calls: [] };
}

function effectsOf(world: FakeWorld): SalvageEffects {
  return {
    pathExists: async (p) => {
      world.calls.push(`pathExists:${p}`);
      return world.dirs.has(p);
    },
    isStrictClean: async (p) => {
      world.calls.push(`isStrictClean:${p}`);
      return world.clean.has(p);
    },
    canonicalize: async (p) => {
      world.calls.push(`canonicalize:${p}`);
      return world.canonical.get(p) ?? p;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The class table (R2 D8)
// ---------------------------------------------------------------------------

describe('sweep.salvage classification (UC row 7, R2 D8)', () => {
  test('exists + strict-clean + journal allTerminal → reuse (clean-done skip)', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    world.clean.add(ENTRY);
    const plan = await okPlan(
      makeSalvage(effectsOf(world)),
      inputOf([{ path: ENTRY, branch: 'cq/09-16a/fix/core', journal: { allTerminal: true } }]),
    );
    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0] as SalvageRow;
    expect(row.class).toBe('reuse');
    expect(row.path).toBe(ENTRY);
    expect(row.branch).toBe('cq/09-16a/fix/core');
    expect(row.reason).toMatch(/all steps terminal/);
  });

  test('exists + strict-clean + partial journal progress (lastStep, allTerminal absent) → resume', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    world.clean.add(ENTRY);
    const plan = await okPlan(
      makeSalvage(effectsOf(world)),
      inputOf([{ path: ENTRY, journal: { lastStep: 'fix.core.lint', stepsTotal: 4 } }]),
    );
    const row = plan.rows[0] as SalvageRow;
    expect(row.class).toBe('resume');
    expect(row.reason).toMatch(/PARTIAL journal progress/);
    expect(row.reason).toContain('fix.core.lint');
    expect(row.reason).toContain('4');
  });

  test('resume requires POSITIVE journal evidence: strictly clean with no journal tail is reuse, not resume', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    world.clean.add(ENTRY);
    const plan = await okPlan(makeSalvage(effectsOf(world)), inputOf([{ path: ENTRY }]));
    const row = plan.rows[0] as SalvageRow;
    expect(row.class).toBe('reuse');
    expect(row.reason).toMatch(/no journal tail/);
  });

  test('a DIRTY tree is preserve — REQUIRED: never discard without the explicit flag', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    // Not in `clean`: `git status --porcelain` non-empty semantics.
    const plan = await okPlan(makeSalvage(effectsOf(world)), inputOf([{ path: ENTRY }]));
    const row = plan.rows[0] as SalvageRow;
    expect(row.class).toBe('preserve');
    expect(row.reason).toMatch(/never auto-classified for removal/);
    expect(row.reason).toMatch(/--force/);
  });

  test('an explicit allTerminal:false with a lastStep resumes; untracked dirt still preserves', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    world.clean.add(ENTRY);
    const resumed = await okPlan(
      makeSalvage(effectsOf(world)),
      inputOf([{ path: ENTRY, journal: { lastStep: 's1', allTerminal: false } }]),
    );
    expect((resumed.rows[0] as SalvageRow).class).toBe('resume');

    world.dirs.add('/runs/wt/fix/cli');
    const dirty = await okPlan(
      makeSalvage(effectsOf(world)),
      inputOf([{ path: '/runs/wt/fix/cli' }]),
    );
    expect((dirty.rows[0] as SalvageRow).class).toBe('preserve');
  });

  test('a NOT-existing path is an absent ROW, not an error', async () => {
    const world = fakeWorld();
    const plan = await okPlan(makeSalvage(effectsOf(world)), inputOf([{ path: ENTRY }]));
    const row = plan.rows[0] as SalvageRow;
    expect(row.class).toBe('absent');
    expect(plan.counts.absent).toBe(1);
  });

  test('a FAILED liveness probe is NOT death: pathExists fault → indeterminate naming the fault', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    const effects: SalvageEffects = {
      ...effectsOf(world),
      pathExists: async (p) => {
        if (p === ENTRY) throw new Error(`EACCES: permission denied, stat '${p}'`);
        return world.dirs.has(p);
      },
    };
    const plan = await okPlan(makeSalvage(effects), inputOf([{ path: ENTRY }]));
    const row = plan.rows[0] as SalvageRow;
    expect(row.class).toBe('indeterminate');
    expect(row.reason).toMatch(/liveness probe/);
    expect(row.reason).toContain('EACCES');
    // Never death, never skip: the row exists and is counted.
    expect(plan.counts.indeterminate).toBe(1);
  });

  test('a FAILED clean probe is NOT death either: isStrictClean fault → indeterminate', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    const effects: SalvageEffects = {
      ...effectsOf(world),
      isStrictClean: async () => {
        throw new Error('git status failed — fatal: not a git repository');
      },
    };
    const plan = await okPlan(makeSalvage(effects), inputOf([{ path: ENTRY }]));
    const row = plan.rows[0] as SalvageRow;
    expect(row.class).toBe('indeterminate');
    expect(row.reason).toMatch(/clean probe/);
    expect(row.reason).toContain('not a git repository');
  });

  test('a faulting canonicalize also lands indeterminate — one entry never fails the report', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    world.dirs.add('/runs/wt/fix/cli');
    world.clean.add('/runs/wt/fix/cli');
    const effects: SalvageEffects = {
      ...effectsOf(world),
      canonicalize: async (p) => {
        if (p === ENTRY) throw new Error('realpath exploded');
        return p;
      },
    };
    const plan = await okPlan(
      makeSalvage(effects),
      inputOf([{ path: ENTRY }, { path: '/runs/wt/fix/cli', journal: { allTerminal: true } }]),
    );
    expect(plan.rows).toHaveLength(2);
    expect((plan.rows[0] as SalvageRow).class).toBe('indeterminate');
    expect((plan.rows[0] as SalvageRow).reason).toContain('realpath exploded');
    expect((plan.rows[1] as SalvageRow).class).toBe('reuse');
  });
});

// ---------------------------------------------------------------------------
// 2. The explicit-only dirty ladder
// ---------------------------------------------------------------------------

describe('sweep.salvage discard is explicit-only', () => {
  test('discardDirty=true flips dirty rows to discard with a discard-ELIGIBLE stash-first reason', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    const plan = await okPlan(
      makeSalvage(effectsOf(world)),
      inputOf([{ path: ENTRY, branch: 'cq/x/fix/core' }], true),
    );
    const row = plan.rows[0] as SalvageRow;
    expect(row.class).toBe('discard');
    expect(row.reason).toMatch(/discard-ELIGIBLE/);
    expect(row.reason).toMatch(/stash/i);
    expect(plan.counts.discard).toBe(1);
  });

  test('the discard classification performs NO mutations — the seam has no mutating effects', async () => {
    // TYPE-LEVEL PIN: if a mutating effect ever joined SalvageEffects, the
    // Exclude stops being `never` and this assignment stops compiling —
    // salvage cannot delete because it cannot even name a deleter.
    type IsExactlyReadOnly =
      Exclude<keyof SalvageEffects, 'pathExists' | 'isStrictClean' | 'canonicalize'> extends never
        ? true
        : false;
    const exactlyReadOnly: IsExactlyReadOnly = true;
    expect(exactlyReadOnly).toBe(true);

    // RUNTIME PIN: every effect call the discard classification makes is one
    // of the three read-only probes.
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    await okPlan(makeSalvage(effectsOf(world)), inputOf([{ path: ENTRY }], true));
    for (const call of world.calls) {
      expect(
        ['canonicalize', 'isStrictClean', 'pathExists'].some((m) => call.startsWith(`${m}:`)),
      ).toBe(true);
    }
    // And the real subprocess binding exposes exactly the three read-only probes.
    expect(Object.keys(makeSubprocessSalvageEffects()).sort()).toEqual([
      'canonicalize',
      'isStrictClean',
      'pathExists',
    ]);
  });

  test('discardDirty does not touch clean or absent classifications', async () => {
    const world = fakeWorld();
    world.dirs.add(ENTRY);
    world.clean.add(ENTRY);
    const plan = await okPlan(
      makeSalvage(effectsOf(world)),
      inputOf([{ path: ENTRY, journal: { allTerminal: true } }, { path: '/runs/wt/fix/absent' }]),
    );
    expect((plan.rows[0] as SalvageRow).class).toBe('reuse');
    expect((plan.rows[1] as SalvageRow).class).toBe('absent');
  });
});

// ---------------------------------------------------------------------------
// 3. Canonical paths + counts
// ---------------------------------------------------------------------------

describe('sweep.salvage canonical paths and counts', () => {
  test('rows carry the CANONICAL form: a canonicalized path classifies and reports under its real name', async () => {
    // The macOS /tmp → /private/tmp class: the caller's lexical path and the
    // porcelain's realpath differ; the row names the canonical form.
    const world = fakeWorld();
    world.canonical.set(ENTRY, '/private/runs/wt/fix/core');
    world.dirs.add('/private/runs/wt/fix/core');
    world.clean.add('/private/runs/wt/fix/core');
    const plan = await okPlan(
      makeSalvage(effectsOf(world)),
      inputOf([{ path: ENTRY, journal: { allTerminal: true } }]),
    );
    const row = plan.rows[0] as SalvageRow;
    expect(row.path).toBe('/private/runs/wt/fix/core');
    expect(row.class).toBe('reuse');
    expect(world.calls).toContain('pathExists:/private/runs/wt/fix/core');
  });

  test('counts carry all six classes, zeros included, and sum to the row count', async () => {
    const world = fakeWorld();
    world.dirs.add('/runs/wt/fix/core');
    world.clean.add('/runs/wt/fix/core');
    world.dirs.add('/runs/wt/fix/dirty');
    // '/runs/wt/fix/gone' absent; '/runs/wt/fix/guarded' faults.
    const effects: SalvageEffects = {
      ...effectsOf(world),
      pathExists: async (p) => {
        if (p === '/runs/wt/fix/guarded') throw new Error('EIO: i/o error');
        return world.dirs.has(p);
      },
    };
    const plan = await okPlan(
      makeSalvage(effects),
      inputOf([
        { path: '/runs/wt/fix/core', journal: { allTerminal: true } },
        { path: '/runs/wt/fix/dirty' },
        { path: '/runs/wt/fix/gone' },
        { path: '/runs/wt/fix/guarded' },
      ]),
    );
    expect(plan.rows).toHaveLength(4);
    expect(Object.keys(plan.counts).sort()).toEqual([
      'absent',
      'discard',
      'indeterminate',
      'preserve',
      'resume',
      'reuse',
    ]);
    expect(plan.counts).toEqual({
      reuse: 1,
      resume: 0,
      preserve: 1,
      discard: 0,
      absent: 1,
      indeterminate: 1,
    });
    const total = Object.values(plan.counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(plan.rows.length);
  });

  test('an empty inventory plans an empty report', async () => {
    const plan = await okPlan(makeSalvage(effectsOf(fakeWorld())), inputOf([]));
    expect(plan.rows).toEqual([]);
    expect(Object.values(plan.counts).every((n) => n === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. The boundary
// ---------------------------------------------------------------------------

describe('sweep.salvage boundary', () => {
  test('a non-array entries field is a failed result — the char-wise iteration corruption class', async () => {
    const error = await failedAt(
      makeSalvage(effectsOf(fakeWorld())),
      inputOf('build' as unknown as SalvageInput['entries']),
    );
    expect(error).toMatch(/entries must be an array/);
  });

  test('a null inventory element is a failed result naming the index, not a TypeError', async () => {
    const error = await failedAt(
      makeSalvage(effectsOf(fakeWorld())),
      inputOf([null as unknown as SalvageInput['entries'][number]]),
    );
    expect(error).toMatch(/entries\[0\]/);
  });

  test('an empty or control-character-bearing path is refused', async () => {
    const effects = effectsOf(fakeWorld());
    await expect(failedAt(makeSalvage(effects), inputOf([{ path: '' }]))).resolves.toMatch(
      /entries\[0\] must have a non-empty path/,
    );
    await expect(
      failedAt(makeSalvage(effects), inputOf([{ path: '/runs/wt\n/evil' }])),
    ).resolves.toMatch(/control characters/);
  });

  test('a backslash-bearing path is refused — never reinterpreted as separator or literal', async () => {
    const error = await failedAt(
      makeSalvage(effectsOf(fakeWorld())),
      inputOf([{ path: '\\\\windows\\path' }]),
    );
    expect(error).toMatch(/backslash/);
    expect(error).toMatch(/posix separators/);
  });

  test('a dash-leading path is refused — a positional git argument, never a flag', async () => {
    const error = await failedAt(
      makeSalvage(effectsOf(fakeWorld())),
      inputOf([{ path: '--upstream=x' }]),
    );
    expect(error).toMatch(/must not start with '-'/);
  });

  test('branch and runPrefix metadata are shape-guarded', async () => {
    const effects = effectsOf(fakeWorld());
    await expect(
      failedAt(makeSalvage(effects), inputOf([{ path: ENTRY, branch: '' }])),
    ).resolves.toMatch(/branch must be a non-empty string/);
    await expect(
      failedAt(makeSalvage(effects), inputOf([{ path: ENTRY, branch: 'cq/x\r' }])),
    ).resolves.toMatch(/branch must not contain control characters/);
    await expect(
      failedAt(makeSalvage(effects), inputOf([{ path: ENTRY, runPrefix: '../evil' }])),
    ).resolves.toMatch(/runPrefix/);
    await expect(
      failedAt(makeSalvage(effects), inputOf([{ path: ENTRY, runPrefix: 'cq/a..b' }])),
    ).resolves.toMatch(/runPrefix/);
  });

  test('journal metadata is shape-guarded — a garbage journal is a failed result, not a classification', async () => {
    const effects = effectsOf(fakeWorld());
    await expect(
      failedAt(
        makeSalvage(effects),
        inputOf([
          {
            path: ENTRY,
            journal: 'done' as unknown as NonNullable<SalvageInput['entries'][number]['journal']>,
          },
        ]),
      ),
    ).resolves.toMatch(/journal must be an object/);
    await expect(
      failedAt(makeSalvage(effects), inputOf([{ path: ENTRY, journal: { stepsTotal: -1 } }])),
    ).resolves.toMatch(/stepsTotal .*≥ 0/);
    await expect(
      failedAt(
        makeSalvage(effects),
        inputOf([
          {
            path: ENTRY,
            journal: { allTerminal: 'yes' } as unknown as NonNullable<
              SalvageInput['entries'][number]['journal']
            >,
          },
        ]),
      ),
    ).resolves.toMatch(/allTerminal must be a boolean/);
  });

  test('a non-boolean discardDirty and a blank repoRoot are refused', async () => {
    const effects = effectsOf(fakeWorld());
    await expect(
      failedAt(makeSalvage(effects), {
        repoRoot: '/repo',
        entries: [],
        discardDirty: 'yes',
      } as unknown as SalvageInput),
    ).resolves.toMatch(/discardDirty must be a boolean/);
    await expect(
      failedAt(makeSalvage(effects), { repoRoot: '', entries: [] } as SalvageInput),
    ).resolves.toMatch(/repoRoot/);
  });
});
