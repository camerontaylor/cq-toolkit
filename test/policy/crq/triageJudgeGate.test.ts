/**
 * Replay of the `triage_phase` judge closure against the Python oracle: the
 * ordered effect trace (clock, mkdir, scan, runner-disabled, blackout, pause,
 * dispatch) and the report or the escaping exception class for every gate.
 */
import { describe, expect, test } from 'vitest';
import { JsonNumber, JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { TriageInjectedFailure } from '../../../src/policy/crq/triageTail.js';
import { TriageJudgePyError } from '../../../src/policy/crq/triageJudge.js';
import { makeTriageJudge } from '../../../src/policy/crq/triageJudgeGate.js';
import { cases, canon, field, num } from '../../helpers/triageJudgeOracle.js';

const text = (value: JsonValue): string => value as string;
const obj = (entries: Array<[string, JsonValue]>): JsonObject => new JsonObject(entries);
const STATE = 'STATE';

function injected(spec: JsonValue): JsonValue | never {
  if (spec instanceof JsonObject && spec.has('raise')) {
    throw new TriageInjectedFailure(text(spec.get('raise') as JsonValue));
  }
  return spec;
}

function numeric(value: JsonValue): number {
  return num(value);
}

describe('triage judge closure against the Python oracle', () => {
  const all = cases('gate');
  test('fixture is not empty', () => {
    expect(all.length).toBeGreaterThan(70);
  });
  for (const fixtureCase of all) {
    const name = text(field(fixtureCase, 'name'));
    test(name, async () => {
      const spec = field(fixtureCase, 'spec') as JsonObject;
      const expected = field(fixtureCase, 'expected') as JsonObject;
      const outcome = field(expected, 'outcome') as JsonObject;
      const events: JsonValue[] = [];
      const clock = (spec.get('monotonic') as JsonValue[]).map(numeric);
      const config = spec.get('config') as JsonValue;
      const effects = {
        monotonic: () => {
          events.push(obj([['effect', 'monotonic']]));
          const next = clock.shift();
          if (next === undefined) throw new Error('clock exhausted');
          return next;
        },
        mkdir: (path: string) => {
          events.push(
            obj([
              ['effect', 'mkdir'],
              [
                'kwargs',
                obj([
                  ['exist_ok', true],
                  ['parents', true],
                ]),
              ],
              ['path', path],
            ]),
          );
          if (spec.get('precreate_file') === true)
            throw new TriageInjectedFailure('FileExistsError');
        },
        scan: (context: JsonValue, path: string) => {
          events.push(
            obj([
              ['effect', 'scan'],
              ['context', context],
              ['path', path],
            ]),
          );
          return injected(spec.get('scan') as JsonValue);
        },
        runnerDisabled: () => {
          events.push(obj([['effect', 'runner_disabled']]));
          return spec.get('runner_disabled') as JsonValue;
        },
        narrate: (message: string) => {
          events.push(
            obj([
              ['effect', 'narrate'],
              ['message', message],
            ]),
          );
        },
        publishRefusal: () => {
          events.push(obj([['effect', 'publish_refusal']]));
        },
        blocked: (repair: JsonValue) => {
          events.push(
            obj([
              ['effect', 'blocked'],
              ['repair', repair],
            ]),
          );
          return spec.get('blocked') as JsonValue;
        },
        dispatchPaused: (cfg: JsonValue) => {
          events.push(
            obj([
              ['effect', 'dispatch_paused'],
              ['config', cfg],
            ]),
          );
          return spec.get('paused') as JsonValue;
        },
        dispatch: (call: {
          config: JsonValue;
          role: JsonValue;
          job: JsonValue;
          wt: JsonValue;
          directory: string;
          judge: true;
        }) => {
          events.push(
            obj([
              ['effect', 'dispatch'],
              ['config', call.config],
              ['directory', call.directory],
              ['job', call.job],
              ['judge', call.judge],
              ['role', call.role],
              ['wt', call.wt],
            ]),
          );
          return injected(spec.get('dispatch') as JsonValue);
        },
      };
      let result: JsonValue | undefined;
      let thrown: unknown;
      try {
        const judge = makeTriageJudge({ config, stateDir: STATE, effects });
        result = await judge(
          spec.get('row') as JsonValue,
          spec.get('context') as JsonValue,
          numeric(spec.get('remaining') as JsonValue),
        );
      } catch (error) {
        thrown = error;
      }
      const raises = outcome.get('raises');
      if (typeof raises === 'string') {
        expect(thrown, `${name}: expected ${raises}`).toBeDefined();
        const kind =
          thrown instanceof TriageJudgePyError
            ? thrown.pythonType
            : thrown instanceof TriageInjectedFailure
              ? thrown.pythonType
              : String(thrown);
        expect(kind, name).toBe(raises);
        const message = outcome.get('message');
        if (typeof message === 'string') expect((thrown as Error).message, name).toBe(message);
      } else {
        expect(thrown, `${name}: unexpected ${String(thrown)}`).toBeUndefined();
        expect(canon(result), name).toBe(canon(outcome.get('result')));
      }
      if (outcome.get('construction') === true) expect(events, name).toEqual([]);
      expect(canon(events), name).toBe(canon(expected.get('events')));
      void JsonNumber;
    });
  }
});
