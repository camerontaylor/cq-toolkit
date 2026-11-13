/**
 * Differential tests for `assembleSummarySections` (A1 publish sections).
 *
 * The oracle is `apps/crq-python/fixtures/a1-status/publish-sections.json`: the
 * real `status_summary.publish` runs with its effect seams patched, and the
 * fixture records its own `utilization` and `schedule` values plus the exact
 * compact bytes of those sections and of the core with them appended.
 *
 * Inputs and expectations are parsed with `parseJsonValue`, never
 * `JSON.parse`, so `120.0`, `30.0` and `nominal_utilization` keep the lexemes
 * the Python oracle produced and the comparison is byte-exact
 * `pythonJsonText`.
 *
 * Beyond replay, the suite proves the comparison is not vacuous: it mutates
 * the fixture inputs (a start removed, the schedule state changed, the core's
 * `last_tick` cleared, an extra core key appended) and asserts the exact
 * expected change. It also drives the main case through the real
 * `readSummaryCore` route to show the existing core contract feeds this
 * helper unchanged.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { readSummaryCore } from '../../../src/ops/crq/readOnlyStatus.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText, type PythonJsonOptions } from '../../../src/policy/crq/pythonJson.js';
import {
  SummarySectionsError,
  assembleSummarySections,
  type SummarySections,
  type SummarySectionsInput,
} from '../../../src/policy/crq/summarySections.js';

const A1 = new URL('../../../apps/crq-python/fixtures/a1-status/', import.meta.url);
const FIXED_NOW = 1_794_225_600; // 2026-11-09T12:00:00Z
const COMPACT: PythonJsonOptions = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion',
  indent: null,
};

interface Expectation {
  readonly ok: boolean;
  readonly value?: JsonObject;
  readonly bytes?: string;
  readonly fullBytes?: string;
  readonly error?: string;
  readonly message?: string;
}

interface Case {
  readonly name: string;
  readonly input: JsonObject;
  readonly expect: Expectation;
}

function loadCases(): Case[] {
  const document = parseJsonValue(readFileSync(new URL('publish-sections.json', A1), 'utf8'));
  if (!(document instanceof JsonObject)) throw new Error('publish-sections: root is not an object');
  const cases = document.get('cases');
  if (!Array.isArray(cases)) throw new Error('publish-sections: missing cases');
  return cases.map((entry, index) => {
    if (!(entry instanceof JsonObject)) {
      throw new Error(`publish-sections[${String(index)}]: case is not an object`);
    }
    const input = entry.get('input');
    const expectation = entry.get('expect');
    const name = entry.get('name');
    if (!(input instanceof JsonObject) || !(expectation instanceof JsonObject)) {
      throw new Error(`publish-sections[${String(index)}]: missing input/expect`);
    }
    if (typeof name !== 'string') {
      throw new Error(`publish-sections[${String(index)}]: missing name`);
    }
    const ok = expectation.get('ok');
    if (typeof ok !== 'boolean') {
      throw new Error(`publish-sections[${String(index)}]: missing ok`);
    }
    const value = expectation.get('value');
    const bytes = expectation.get('bytes');
    const fullBytes = expectation.get('full_bytes');
    const error = expectation.get('error');
    const message = expectation.get('message');
    return {
      name,
      input,
      expect: {
        ok,
        ...(value instanceof JsonObject ? { value } : {}),
        ...(typeof bytes === 'string' ? { bytes } : {}),
        ...(typeof fullBytes === 'string' ? { fullBytes } : {}),
        ...(typeof error === 'string' ? { error } : {}),
        ...(typeof message === 'string' ? { message } : {}),
      },
    };
  });
}

function inputOf(input: JsonObject): SummarySectionsInput {
  return {
    core: required(input, 'core'),
    queue: required(input, 'queue'),
    config: required(input, 'config'),
    schedule: required(input, 'schedule'),
    now: required(input, 'now'),
  };
}

function required(object: JsonObject, key: string): JsonValue {
  if (!object.has(key)) throw new Error(`missing ${key}`);
  return object.get(key) as JsonValue;
}

function sectionsOf(result: SummarySections): Record<string, unknown> {
  // Publish order: `utilization` then `schedule`.
  return { utilization: result.utilization, schedule: result.schedule };
}

function clone(input: SummarySectionsInput): SummarySectionsInput {
  return { ...input };
}

function plain(value: unknown): unknown {
  return value instanceof JsonObject ? toPlainJson(value) : value;
}

function outcomeOf(input: SummarySectionsInput): SummarySections | SummarySectionsError {
  try {
    return assembleSummarySections(input);
  } catch (error) {
    if (error instanceof SummarySectionsError) return error;
    throw error;
  }
}

const cases = loadCases();

function requiredCase(name: string): Case {
  const found = cases.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`publish-sections: missing case ${name}`);
  return found;
}

describe('publish sections oracle', () => {
  test('the oracle family covers refusals and every section shape', () => {
    expect(cases.length).toBeGreaterThanOrEqual(18);
    expect(cases.some((vector) => !vector.expect.ok)).toBe(true);
    expect(
      cases.some((vector) => vector.expect.ok && vector.expect.value?.has('utilization') === true),
    ).toBe(true);
    expect(
      cases.some((vector) => {
        const schedule = vector.expect.value?.get('schedule');
        return schedule instanceof JsonObject && schedule.has('error');
      }),
    ).toBe(true);
  });

  for (const vector of cases) {
    test(vector.name, () => {
      const outcome = outcomeOf(inputOf(vector.input));
      if (!vector.expect.ok) {
        expect(outcome).toBeInstanceOf(SummarySectionsError);
        const error = outcome as SummarySectionsError;
        expect(error.pythonError).toBe(vector.expect.error);
        expect(error.message).toBe(vector.expect.message);
        return;
      }
      expect(outcome).not.toBeInstanceOf(SummarySectionsError);
      const result = outcome as SummarySections;
      // Exact bytes of the two sections, in publish order.
      expect(pythonJsonText(sectionsOf(result), COMPACT)).toBe(vector.expect.bytes);
      // Exact bytes of the core with the two sections appended.
      expect(pythonJsonText(result.value, COMPACT)).toBe(vector.expect.fullBytes);
      const value = vector.expect.value as JsonObject;
      expect(pythonJsonText(result.utilization, COMPACT)).toBe(
        pythonJsonText(required(value, 'utilization'), COMPACT),
      );
      expect(pythonJsonText(result.schedule, COMPACT)).toBe(
        pythonJsonText(required(value, 'schedule'), COMPACT),
      );
      const keys = Object.keys(result.value);
      expect(keys.slice(-2)).toEqual(['utilization', 'schedule']);
      expect(keys.slice(0, -2)).toEqual(
        Object.keys(plain(required(vector.input, 'core')) as Record<string, unknown>),
      );
    });
  }
});

describe('publish sections integration', () => {
  test('readSummaryCore output feeds the helper to the oracle bytes', async () => {
    const vector = requiredCase('utilization-and-schedule');
    const core = await readSummaryCore({
      readQueue: () => Promise.resolve(pythonJsonText(required(vector.input, 'queue'), COMPACT)),
      readConfig: () => Promise.resolve(pythonJsonText(required(vector.input, 'config'), COMPACT)),
      readEvents: () => Promise.resolve(''),
      readReceipt: () => Promise.resolve(null),
      now: () => FIXED_NOW,
    });
    expect(pythonJsonText(core.value, COMPACT)).toBe(
      pythonJsonText(required(vector.input, 'core'), COMPACT),
    );
    const result = assembleSummarySections({
      core: core.value,
      queue: plain(required(vector.input, 'queue')),
      config: plain(required(vector.input, 'config')),
      schedule: plain(required(vector.input, 'schedule')),
      now: required(vector.input, 'now'),
    });
    expect(pythonJsonText(sectionsOf(result), COMPACT)).toBe(vector.expect.bytes);
    expect(pythonJsonText(result.value, COMPACT)).toBe(vector.expect.fullBytes);
  });

  test('a materialised core keeps the integer cap but not float lexemes', () => {
    const vector = requiredCase('float-config-cap-keeps-float-tag');
    const core = plain(required(vector.input, 'core')) as Record<string, unknown>;
    expect(core.starts_cap).toBe(5);
    const result = assembleSummarySections({
      core,
      queue: plain(required(vector.input, 'queue')),
      config: plain(required(vector.input, 'config')),
      schedule: plain(required(vector.input, 'schedule')),
      now: required(vector.input, 'now'),
    });
    // A materialised core cannot express Python's `5.0`; the caller must pass
    // the lossless core (or JsonNumber starts_cap) for byte parity.
    expect(pythonJsonText(sectionsOf(result), COMPACT)).not.toBe(vector.expect.bytes);
    expect(result.utilization.nominal_cap_24h).toBe(120);
  });
});

describe('publish sections refusals and ordering', () => {
  const base = requiredCase('utilization-and-schedule');

  function withCore(
    core: unknown,
    overrides: Partial<SummarySectionsInput> = {},
  ): SummarySectionsInput {
    return {
      ...inputOf(base.input),
      ...overrides,
      core,
    };
  }

  test('falsy last_tick refuses with the publisher ValueError', () => {
    for (const lastTick of [null, '', 0, false, {}, []]) {
      const core = { ...(plain(required(base.input, 'core')) as object), last_tick: lastTick };
      const outcome = outcomeOf(withCore(core));
      expect(outcome).toBeInstanceOf(SummarySectionsError);
      const error = outcome as SummarySectionsError;
      expect(error.pythonError).toBe('ValueError');
      expect(error.message).toBe('no completed tick to publish');
    }
  });

  test('a missing last_tick is a KeyError before anything else', () => {
    const core = { ...(plain(required(base.input, 'core')) as Record<string, unknown>) };
    delete core.last_tick;
    const outcome = outcomeOf(withCore(core));
    expect(outcome).toBeInstanceOf(SummarySectionsError);
    const error = outcome as SummarySectionsError;
    expect(error.pythonError).toBe('KeyError');
    expect(error.message).toBe("'last_tick'");
  });

  test('a missing starts_cap is a KeyError after the queue read', () => {
    const core = { ...(plain(required(base.input, 'core')) as Record<string, unknown>) };
    delete core.starts_cap;
    const outcome = outcomeOf(withCore(core));
    expect(outcome).toBeInstanceOf(SummarySectionsError);
    const error = outcome as SummarySectionsError;
    expect(error.pythonError).toBe('KeyError');
    expect(error.message).toBe("'starts_cap'");
  });

  test('queue is read before starts_cap, as Python evaluates arguments', () => {
    const core = { ...(plain(required(base.input, 'core')) as Record<string, unknown>) };
    delete core.starts_cap;
    const outcome = outcomeOf(withCore(core, { queue: [] }));
    expect(outcome).toBeInstanceOf(SummarySectionsError);
    const error = outcome as SummarySectionsError;
    expect(error.pythonError).toBe('AttributeError');
    expect(error.message).toBe("'list' object has no attribute 'get'");
  });

  test('config is read before the schedule probe', () => {
    const outcome = outcomeOf(withCore(required(base.input, 'core'), { config: null }));
    expect(outcome).toBeInstanceOf(SummarySectionsError);
    const error = outcome as SummarySectionsError;
    expect(error.pythonError).toBe('AttributeError');
    expect(error.message).toBe("'NoneType' object has no attribute 'get'");
  });

  test('a non-dict schedule is an AttributeError', () => {
    const outcome = outcomeOf(withCore(required(base.input, 'core'), { schedule: 'x' }));
    expect(outcome).toBeInstanceOf(SummarySectionsError);
    const error = outcome as SummarySectionsError;
    expect(error.pythonError).toBe('AttributeError');
    expect(error.message).toBe("'str' object has no attribute 'get'");
  });

  test('a coverage refusal keeps the Python class and message', () => {
    const core = {
      ...(plain(required(base.input, 'core')) as Record<string, unknown>),
      starts_cap: '5',
    };
    const outcome = outcomeOf(withCore(core));
    expect(outcome).toBeInstanceOf(SummarySectionsError);
    const error = outcome as SummarySectionsError;
    expect(error.pythonError).toBe('TypeError');
    expect(error.message).toBe("'<=' not supported between instances of 'str' and 'int'");
  });

  test('a non-dict core is a TypeError subscript', () => {
    const outcome = outcomeOf(withCore(null));
    expect(outcome).toBeInstanceOf(SummarySectionsError);
    const error = outcome as SummarySectionsError;
    expect(error.pythonError).toBe('TypeError');
    expect(error.message).toBe("'NoneType' object is not subscriptable");
  });
});

describe('publish sections independent input mutations', () => {
  const base = requiredCase('utilization-and-schedule');
  const input = inputOf(base.input);

  test('removing a start changes only starts_24h and utilization', () => {
    const queue = plain(required(base.input, 'queue')) as { starts: string[] } & Record<
      string,
      unknown
    >;
    const baseline = assembleSummarySections(input);
    expect(baseline.utilization.starts_24h).toBe(2);
    const mutated = assembleSummarySections({
      ...clone(input),
      queue: { ...queue, starts: queue.starts.slice(1) },
    });
    expect(mutated.utilization.starts_24h).toBe(1);
    expect(mutated.schedule).toEqual(baseline.schedule);
    expect(pythonJsonText(sectionsOf(mutated), COMPACT)).not.toBe(
      pythonJsonText(sectionsOf(baseline), COMPACT),
    );
  });

  test('dropping the coverage ledger empties observations but keeps starts', () => {
    const queue = plain(required(base.input, 'queue')) as Record<string, unknown>;
    const withoutCoverage = Object.fromEntries(
      Object.entries(queue).filter(([key]) => key !== 'coverage'),
    );
    const mutated = assembleSummarySections({ ...clone(input), queue: withoutCoverage });
    expect(mutated.utilization.starts_24h).toBe(2);
    expect(mutated.utilization.observed_ticks_24h).toBe(0);
    expect(mutated.utilization.idle_while_pending_24h).toBeNull();
    expect(mutated.utilization.coverage_reviewed_paths).toBe(0);
  });

  test('an unknown schedule state appends the probe error last', () => {
    const mutated = assembleSummarySections({
      ...clone(input),
      schedule: { status: 'unknown', nextRunAt: '2026-11-09T12:12:00Z' },
    });
    expect(Object.keys(mutated.schedule)).toEqual(['id', 'state', 'error']);
    expect(pythonJsonText(mutated.schedule, COMPACT)).toBe(
      '{"id":"crq-tick.timer","state":"unknown","error":"schedule probe unavailable"}',
    );
  });

  test('extra core keys stay before the appended sections', () => {
    const core = {
      ...(plain(required(base.input, 'core')) as Record<string, unknown>),
      zz_extension: { kept: true },
    };
    const mutated = assembleSummarySections({ ...clone(input), core });
    expect(Object.keys(mutated.value).slice(-3)).toEqual([
      'zz_extension',
      'utilization',
      'schedule',
    ]);
  });

  test('existing section keys keep their position, as Python dict assignment does', () => {
    const source = plain(required(base.input, 'core')) as Record<string, unknown>;
    const core: Record<string, unknown> = {};
    Object.entries(source).forEach(([key, value], index) => {
      core[key] = value;
      if (index === 1) {
        // A full document from an earlier publish re-assembled in place.
        core.utilization = 'stale';
        core.schedule = 'stale';
      }
    });
    core.tail = true;
    const result = assembleSummarySections({ ...clone(input), core });
    expect(Object.keys(result.value).slice(0, 2)).toEqual(Object.keys(source).slice(0, 2));
    expect(Object.keys(result.value).slice(2, 4)).toEqual(['utilization', 'schedule']);
    expect(Object.keys(result.value).at(-1)).toBe('tail');
    expect(Object.keys(result.value).filter((key) => key === 'utilization')).toHaveLength(1);
    expect(pythonJsonText(result.utilization, COMPACT)).toBe(
      pythonJsonText(required(base.expect.value as JsonObject, 'utilization'), COMPACT),
    );
  });

  test('the helper never mutates the injected core or queue', () => {
    const core = plain(required(base.input, 'core')) as Record<string, unknown>;
    const queue = plain(required(base.input, 'queue')) as Record<string, unknown>;
    const coreBefore = pythonJsonText(core, COMPACT);
    const queueBefore = pythonJsonText(queue, COMPACT);
    assembleSummarySections({ ...clone(input), core, queue });
    expect(pythonJsonText(core, COMPACT)).toBe(coreBefore);
    expect(pythonJsonText(queue, COMPACT)).toBe(queueBefore);
  });
});
