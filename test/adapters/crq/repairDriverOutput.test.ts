import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue, pythonNonFinite } from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import {
  pythonPathStem,
  validateCodexOutput,
  validatePaseoJudgeAnswer,
  writeCqSessionLink,
  type CqSessionLinkEffects,
  type CqSessionRecord,
} from '../../../src/adapters/crq/repairDriverOutput.js';
import { isPyError, PyError } from '../../../src/queue-runner/pyErrors.js';

interface CodexCase {
  label: string;
  judge: boolean;
  output_b64: string;
  expect: { ok: true; result: string } | { ok: false; failure: string } | { raises: string };
}
interface PaseoCase {
  label: string;
  logs: string;
  returncode: number;
  expect: { result: string; persisted: string | null } | { raises: string };
}
interface CqCase {
  label: string;
  existing: string[];
  created: string[];
  end: 'timeout' | 'stdout';
  stdout?: string;
  no_dir?: boolean;
  work_id?: string;
  expect: { record: CqSessionRecord | null; stop: string } | { raises: string };
}
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/crq-driver-output/cases.json', import.meta.url),
    'utf8',
  ),
) as { schema: string; codex: CodexCase[]; paseo: PaseoCase[]; cq: CqCase[] };

const json = (value: unknown): string =>
  pythonJsonText(value, { asciiOnly: true, sortKeys: false, spacedSeparators: true });

describe('driver output oracle fixture', () => {
  it('is the committed v1 schema and covers all three drivers', () => {
    expect(fixture.schema).toBe('cq.crq-driver-output-vector/v1');
    expect(fixture.codex.length).toBeGreaterThan(50);
    expect(fixture.paseo.length).toBeGreaterThan(40);
    expect(fixture.cq.length).toBeGreaterThan(20);
  });
});

describe('codex output validation (48eedd939, c6a87eb95)', () => {
  for (const c of fixture.codex) {
    it(c.label, () => {
      const outcome = validateCodexOutput(Buffer.from(c.output_b64, 'base64'), c.judge);
      if ('raises' in c.expect) throw new Error('codex validation never raises in Python');
      if (c.expect.ok) {
        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(json(outcome.result)).toBe(c.expect.result);
      } else {
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(json(outcome.failure)).toBe(c.expect.failure);
      }
    });
  }
});

describe('paseo judge answer validation (a508c93ca)', () => {
  for (const c of fixture.paseo) {
    it(c.label, () => {
      const run = () => validatePaseoJudgeAnswer(c.logs, c.returncode);
      if ('raises' in c.expect) {
        // json.JSONDecodeError is a ValueError subclass; the port raises ValueError for both.
        expect(['ValueError', 'JSONDecodeError']).toContain(c.expect.raises);
        let caught: unknown;
        try {
          run();
        } catch (error) {
          caught = error;
        }
        expect(isPyError(caught, 'ValueError')).toBe(true);
      } else {
        const verdict = run();
        expect(json(verdict.result)).toBe(c.expect.result);
        expect(json(verdict.answer)).toBe(c.expect.persisted);
      }
    });
  }
});

function effectsFor(c: CqCase, written: CqSessionRecord[]): CqSessionLinkEffects {
  const names = [...c.existing, ...c.created];
  const exists = c.no_dir !== true || c.created.length > 0;
  return {
    isDirectory: () => exists,
    listJsonl: () => names.filter((name) => name.endsWith('.jsonl')),
    hasEntries: () => names.length > 0,
    writeSession: (record) => {
      written.push(record);
    },
  };
}

/** Python `data.get('value')` then `data.get('result')`, as `cq.invoke` reads the CLI JSON. */
function valueSessionId(stdout: string | undefined): unknown {
  if (stdout === undefined) return undefined;
  let data: unknown;
  try {
    data = parseJsonValue(stdout, { parseConstant: pythonNonFinite });
  } catch {
    return undefined;
  }
  if (!(data instanceof JsonObject)) return undefined;
  let result = data.get('value');
  if (result === null || result === undefined) result = data.get('result');
  if (!(result instanceof JsonObject)) return undefined;
  return result.get('sessionId');
}

describe('cq session link (2eb6b4770)', () => {
  for (const c of fixture.cq) {
    it(c.label, () => {
      if ('raises' in c.expect) throw new Error('cq link never raises in Python');
      const written: CqSessionRecord[] = [];
      const record = writeCqSessionLink(
        {
          sessionsDir: '<sessions>',
          created: new Set(c.created),
          valueSessionId: valueSessionId(c.stdout) as never,
          workId: c.work_id ?? null,
        },
        effectsFor(c, written),
      );
      expect(record).toEqual(c.expect.record);
      expect(written).toEqual(c.expect.record === null ? [] : [c.expect.record]);
    });
  }
});

describe('cq session link failure handling', () => {
  const base = {
    sessionsDir: '/s',
    created: new Set<string>(),
    workId: null,
  };
  const ok: CqSessionLinkEffects = {
    isDirectory: () => true,
    listJsonl: () => ['a.jsonl'],
    hasEntries: () => true,
    writeSession: () => undefined,
  };

  it('swallows an OSError raised while gathering or writing', () => {
    for (const key of ['isDirectory', 'listJsonl', 'hasEntries', 'writeSession'] as const) {
      const effects = {
        ...ok,
        [key]: () => {
          throw new PyError('OSError', 'denied');
        },
      } as CqSessionLinkEffects;
      expect(writeCqSessionLink(base, effects)).toBeNull();
    }
    const missing = {
      ...ok,
      writeSession: () => {
        throw new PyError('FileNotFoundError', 'gone');
      },
    };
    expect(writeCqSessionLink(base, missing)).toBeNull();
  });

  it('lets any other failure escape as in Python', () => {
    const effects = {
      ...ok,
      writeSession: () => {
        throw new PyError('ValueError', 'bad');
      },
    };
    expect(() => writeCqSessionLink(base, effects)).toThrow('bad');
    expect(() =>
      writeCqSessionLink(base, {
        ...ok,
        listJsonl: () => {
          throw new TypeError('x');
        },
      }),
    ).toThrow('x');
  });

  it('matches pathlib stems for dotted names', () => {
    expect(pythonPathStem('a.jsonl')).toBe('a');
    expect(pythonPathStem('.jsonl')).toBe('.jsonl');
    expect(pythonPathStem('a.')).toBe('a');
    expect(pythonPathStem('..jsonl')).toBe('..jsonl');
    expect(pythonPathStem('a..jsonl')).toBe('a.');
    expect(pythonPathStem('.a.b')).toBe('.a');
    expect(pythonPathStem('a.b.c')).toBe('a.b');
    expect(pythonPathStem('plain')).toBe('plain');
  });
});
