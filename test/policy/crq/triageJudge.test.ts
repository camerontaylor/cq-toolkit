/**
 * Replay of `drivers.cq.judge` against the Python oracle: the request text,
 * the bridge argv and kill timeout, the `driver.log` entry and the report (or
 * the escaping exception class) for each process outcome.
 */
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  pythonNonFinite,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import {
  TriageJudgePyError,
  runCqJudge,
  type JudgeProcess,
} from '../../../src/policy/crq/triageJudge.js';
import { cases, canon, field, num } from '../../helpers/triageJudgeOracle.js';

const text = (value: JsonValue): string => value as string;

function toProcess(spec: JsonValue): JudgeProcess | { raise: string } {
  const kind = text(field(spec, 'kind'));
  if (kind === 'raise') return { raise: text(field(spec, 'error')) };
  if (kind === 'timeout') {
    return {
      kind: 'timeout',
      stdout: field(spec, 'stdout') as string | null,
      stderr: field(spec, 'stderr') as string | null,
    };
  }
  return {
    kind: 'completed',
    returncode: num(field(spec, 'returncode')),
    stdout: text(field(spec, 'stdout')),
    stderr: text(field(spec, 'stderr')),
  };
}

describe('cq.judge against the Python oracle', () => {
  const all = cases('judge');
  test('fixture is not empty', () => {
    expect(all.length).toBeGreaterThan(60);
  });
  for (const fixtureCase of all) {
    const name = text(field(fixtureCase, 'name'));
    test(name, async () => {
      const expected = field(fixtureCase, 'expected') as JsonObject;
      const process = toProcess(field(fixtureCase, 'process'));
      let requestText: string | null = null;
      let command: { timeout: JsonNumber } | null = null;
      const logged: Array<{ stdout: string; stderr: string }> = [];
      const scripted = Object.assign(new Error('scripted'), {
        name: 'raise' in process ? process.raise : '',
      });
      let report: JsonValue | undefined;
      let thrown: unknown;
      try {
        report = await runCqJudge(
          {
            writeRequest: (request) => {
              requestText = request;
              return Promise.resolve();
            },
            runBridge: (timeout) => {
              command = { timeout };
              if ('raise' in process) return Promise.reject(scripted);
              return Promise.resolve(process);
            },
            logInvocation: (stdout, stderr) => {
              logged.push({ stdout, stderr });
              return Promise.resolve();
            },
          },
          field(fixtureCase, 'config'),
          field(fixtureCase, 'role'),
          parseJsonValue(text(field(fixtureCase, 'job_json')), { parseConstant: pythonNonFinite }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(requestText, name).toBe(expected.get('request_text') ?? null);
      const expectedCommand = expected.get('command');
      if (expectedCommand === null || expectedCommand === undefined) {
        expect(command, name).toBeNull();
      } else {
        const wanted = field(expectedCommand, 'timeout') as JsonNumber;
        const got = (command as unknown as { timeout: JsonNumber }).timeout;
        expect(got.kind, name).toBe(wanted.kind);
        expect(got.raw, name).toBe(wanted.raw);
      }
      const expectedLogged = expected.get('logged') as JsonObject[];
      expect(
        logged.map((entry) => `${entry.stdout}\u0000${entry.stderr}`),
        name,
      ).toEqual(
        expectedLogged.map(
          (entry) => `${text(field(entry, 'stdout'))}\u0000${text(field(entry, 'stderr'))}`,
        ),
      );
      const raises = expected.get('raises');
      if (typeof raises === 'string') {
        if ('raise' in process) {
          expect(thrown, name).toBe(scripted);
          expect(raises, name).toBe(process.raise);
          return;
        }
        expect(thrown, name).toBeInstanceOf(TriageJudgePyError);
        expect((thrown as TriageJudgePyError).pythonType, name).toBe(raises);
        const message = expected.get('message');
        if (typeof message === 'string') expect((thrown as Error).message, name).toBe(message);
        return;
      }
      expect(thrown, name).toBeUndefined();
      expect(canon(report), name).toBe(canon(expected.get('result')));
      expect(
        pythonJsonText(report as JsonValue, {
          asciiOnly: true,
          sortKeys: false,
          spacedSeparators: true,
        }),
        name,
      ).toBe(text(expected.get('result_text') as JsonValue));
    });
  }
});
