import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { identPid, identityKind, runState } from '../../../src/policy/crq/runLiveness.js';

/**
 * Differential replay of `liveness.json`. The Python oracle is
 * `author_quota.identity_kind`, `author_quota.run_state` and `crq.ident_pid`;
 * probe answers arrive as vector input, so the ported decision is compared
 * with Python's own three-state matrix rather than a restatement of it.
 *
 * The family is read with the lossless reader because `ident_pid` refuses a
 * Python `float` pid (`42.0`) and that lexeme must survive the vector boundary.
 */

interface VectorCase {
  readonly name: string;
  readonly source: string;
  readonly input: JsonObject;
  readonly value: unknown;
}

function cases(): VectorCase[] {
  const document = parseJsonValue(
    readFileSync(
      new URL('../../../apps/crq-python/fixtures/group-p/liveness.json', import.meta.url),
      'utf8',
    ),
    { duplicates: 'last' },
  );
  if (!(document instanceof JsonObject)) throw new Error('liveness family is not an object');
  const rows = document.get('cases');
  if (!Array.isArray(rows)) throw new Error('liveness family has no cases');
  return rows.map((row) => {
    if (!(row instanceof JsonObject)) throw new Error('liveness case is not an object');
    const name = row.get('name');
    const source = row.get('source');
    const input = row.get('input');
    const expect = row.get('expect');
    if (typeof name !== 'string' || typeof source !== 'string') throw new Error('bad case');
    if (!(input instanceof JsonObject) || !(expect instanceof JsonObject)) {
      throw new Error('bad case');
    }
    if (expect.get('ok') !== true) throw new Error(`${name}: vector records a refusal`);
    const value = expect.get('value');
    if (value === undefined) throw new Error(`${name}: vector records no value`);
    return { name, source, input, value: toPlainJson(value) };
  });
}

function replay(vector: VectorCase): unknown {
  const input = vector.input;
  switch (vector.source) {
    case 'author_quota.identity_kind':
      return identityKind(input.get('pidfile'), {
        runId: input.get('run_id'),
        queuePid: input.get('queue_pid'),
      });
    case 'author_quota.run_state':
      return runState({
        hasExit: input.get('has_exit') as boolean,
        identity: input.get('identity') as 'managed' | 'legacy' | 'invalid',
        runnerAlive: input.get('runner_alive') as boolean,
        cliAlive: input.get('cli_alive') as boolean,
        runnerGroupAlive: input.get('runner_group_alive') as boolean,
        wrapperGroupAlive: input.get('wrapper_group_alive') as boolean | null,
      });
    case 'crq.ident_pid':
      return identPid(input.get('value'));
    default:
      throw new Error(`no replay for ${vector.source}`);
  }
}

describe.each(cases())('liveness/$name', (vector) => {
  test(`${vector.source} matches the Python oracle`, () => {
    expect(replay(vector)).toEqual(vector.value);
  });
});

test('a missing exit artifact always retains capacity', () => {
  const probes = {
    hasExit: false,
    identity: 'managed' as const,
    runnerAlive: false,
    cliAlive: false,
    runnerGroupAlive: false,
    wrapperGroupAlive: null,
  };
  expect(runState(probes)).toBe('ambiguous');
  // Terminal evidence plus a valid identity and empty groups is the only harvestable shape.
  expect(runState({ ...probes, hasExit: true })).toBe('harvest');
});

test('a live process outranks a terminal exit artifact', () => {
  expect(
    runState({
      hasExit: true,
      identity: 'managed',
      runnerAlive: true,
      cliAlive: false,
      runnerGroupAlive: false,
      wrapperGroupAlive: null,
    }),
  ).toBe('alive');
});
