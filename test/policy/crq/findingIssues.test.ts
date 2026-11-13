/**
 * Differential replay of the finding-issue delivery oracle.
 *
 * The oracle is `apps/crq-python/finding_issues.py`, captured by
 * `apps/crq-python/finding_issues_vector_emit_b1.py`. Every case compares the
 * exact value, Python exception class and message, and the full `gh` argv/stdin
 * call sequence. No real `gh`, filesystem or network effect runs here.
 */
import { describe, expect, test } from 'vitest';
import {
  FindingIssueError,
  GhSpawnError,
  GhTimeoutError,
  fileFindingIssue,
  findingIssueBody,
  findingIssueTitle,
  findingIssuesEnabled,
  type GhCallOptions,
  type GhResult,
} from '../../../src/policy/crq/findingIssues.js';
import { JsonNumber, JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { sha256Hex } from '../../../src/policy/crq/pythonJson.js';
import { pythonLength } from '../../../src/policy/crq/repairBinding.js';
import {
  arrayField,
  expandInput,
  loadFindingIssuesVectors,
  requireNumber,
  requireObject,
  requireString,
  type FindingIssuesCase,
} from './findingIssuesVectors.js';

const cases = loadFindingIssuesVectors();

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly message: string };

interface CaseRun {
  readonly outcome: Outcome;
  readonly calls?: readonly GhCall[];
}

interface GhCall {
  readonly argv: readonly string[];
  readonly inputText: string | null;
}

interface GhSuccess {
  readonly kind: 'success';
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GhFailure {
  readonly kind: 'timeout' | 'oserror';
  readonly detail: string;
}

type GhStep = GhSuccess | GhFailure;

class ScriptedGh {
  private readonly script: GhStep[];
  readonly calls: GhCall[] = [];

  constructor(values: readonly JsonValue[]) {
    this.script = values.map((value, index) => scriptStep(value, index));
  }

  readonly call = (argv: readonly string[], options: GhCallOptions): GhResult => {
    this.calls.push({ argv: [...argv], inputText: options.inputText });
    const step = this.script.shift();
    if (step === undefined) throw new Error('gh called more often than the script provides');
    if (step.kind !== 'success') {
      if (step.kind === 'timeout') throw new GhTimeoutError(step.detail);
      throw new GhSpawnError(step.detail);
    }
    return { returncode: step.returncode, stdout: step.stdout, stderr: step.stderr };
  };
}

function scriptStep(value: JsonValue, index: number): GhStep {
  const object = requireObject(value, `gh_script[${index}]`);
  const raised = object.get('raise');
  if (raised !== undefined) {
    const kind = requireString(raised, `gh_script[${index}].raise`);
    if (kind !== 'timeout' && kind !== 'oserror') {
      throw new Error(`gh_script[${index}]: unknown raise ${kind}`);
    }
    return { kind, detail: requireString(object.get('detail'), `gh_script[${index}].detail`) };
  }
  return {
    kind: 'success',
    returncode: requireNumber(object.get('returncode'), `gh_script[${index}].returncode`),
    stdout: requireString(object.get('stdout'), `gh_script[${index}].stdout`),
    stderr: requireString(object.get('stderr'), `gh_script[${index}].stderr`),
  };
}

function inputValue(entry: FindingIssuesCase, key: string): JsonValue {
  const value = entry.input.get(key);
  if (value === undefined) throw new Error(`${entry.family}/${entry.name}: missing ${key}`);
  return expandInput(value);
}

async function runCase(entry: FindingIssuesCase): Promise<CaseRun> {
  switch (entry.family) {
    case 'enabled':
      return { outcome: await capture(() => findingIssuesEnabled(inputValue(entry, 'repo_cfg'))) };
    case 'title': {
      const base = inputValue(entry, 'base');
      const head = inputValue(entry, 'head');
      const counts = inputValue(entry, 'severity_counts');
      const itemId = entry.input.has('item_id') ? inputValue(entry, 'item_id') : undefined;
      return {
        outcome: await capture(() =>
          itemId === undefined
            ? findingIssueTitle(base, head, counts)
            : findingIssueTitle(base, head, counts, itemId),
        ),
      };
    }
    case 'body':
      return {
        outcome: await capture(() =>
          findingIssueBody(inputValue(entry, 'meta'), inputValue(entry, 'findings_md')),
        ),
      };
    case 'file_issue': {
      const gh = new ScriptedGh(arrayField(entry.input, 'gh_script'));
      const outcome = await capture(() =>
        fileFindingIssue({
          repoConfig: inputValue(entry, 'repo_cfg'),
          base: inputValue(entry, 'base'),
          head: inputValue(entry, 'head'),
          meta: inputValue(entry, 'meta'),
          severityCounts: inputValue(entry, 'severity_counts'),
          findingsMarkdown: inputValue(entry, 'findings_md'),
          gh: gh.call,
        }),
      );
      return { outcome, calls: gh.calls };
    }
    default:
      throw new Error(`unknown finding-issues vector family: ${entry.family}`);
  }
}

async function capture(action: () => unknown | Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return {
      ok: false,
      error: pythonErrorClass(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function pythonErrorClass(error: unknown): string {
  if (error instanceof FindingIssueError) return error.pythonError;
  return error instanceof Error ? error.name : 'UnknownError';
}

function assertCase(entry: FindingIssuesCase, result: CaseRun): void {
  const expected = entry.expect;
  const label = `${entry.family}/${entry.name}`;
  const expectedOk = expected.get('ok') === true;
  expect(result.outcome.ok, label).toBe(expectedOk);

  if (expectedOk) {
    if (!result.outcome.ok) return;
    const value = expected.get('value');
    if (value !== undefined) expectValue(result.outcome.value, value, label);
    const digest = expected.get('value_sha256');
    if (digest !== undefined) {
      expect(typeof result.outcome.value, `${label}: hashed value is not a string`).toBe('string');
      const text = result.outcome.value as string;
      expect(sha256Hex(new TextEncoder().encode(text)), label).toBe(
        requireString(digest, `${label}.value_sha256`),
      );
      expect(pythonLength(text), `${label}: length`).toBe(
        requireNumber(expected.get('value_length'), `${label}.value_length`),
      );
    }
  } else {
    if (result.outcome.ok) return;
    expect(result.outcome.error, label).toBe(
      requireString(expected.get('error'), `${label}.error`),
    );
    const message = expected.get('message');
    if (message !== undefined) {
      expect(result.outcome.message, `${label}: message`).toBe(
        requireString(message, `${label}.message`),
      );
    }
  }

  if (expected.has('calls')) {
    if (result.calls === undefined) throw new Error(`${label}: vector expects gh calls`);
    assertCalls(result.calls, arrayField(expected, 'calls'), label);
  }
}

function assertCalls(
  actual: readonly GhCall[],
  expected: readonly JsonValue[],
  label: string,
): void {
  expect(actual.length, `${label}: call count`).toBe(expected.length);
  expected.forEach((value, index) => {
    const step = requireObject(value, `${label}.calls[${index}]`);
    const argv = arrayField(step, 'argv').map((item, position) =>
      requireString(item, `${label}.calls[${index}].argv[${position}]`),
    );
    expect(actual[index]?.argv, `${label}: calls[${index}].argv`).toEqual(argv);
    const inputText = step.get('input_text');
    if (inputText === null) {
      expect(actual[index]?.inputText, `${label}: calls[${index}].input_text`).toBeNull();
    } else {
      expect(actual[index]?.inputText, `${label}: calls[${index}].input_text`).toBe(
        requireString(inputText, `${label}.calls[${index}].input_text`),
      );
    }
  });
}

/** Compare a lossless JSON expectation with a materialised port value. */
function expectValue(actual: unknown, expected: JsonValue, label: string): void {
  if (expected instanceof JsonNumber) {
    if (expected.kind === 'int') {
      if (actual instanceof JsonNumber) {
        expect(actual.kind, `${label}: int kind`).toBe('int');
        expect(actual.integer, `${label}: int value`).toBe(expected.integer);
      } else {
        expect(typeof actual, `${label}: int result type`).toBe('number');
        expect(actual, `${label}: int value`).toBe(Number(expected.integer));
      }
    } else {
      if (actual instanceof JsonNumber) {
        expect(actual.kind, `${label}: float kind`).toBe('float');
        expect(Object.is(actual.float, expected.float), `${label}: float value`).toBe(true);
      } else {
        expect(typeof actual, `${label}: float result type`).toBe('number');
        expect(Object.is(actual, expected.float), `${label}: float value`).toBe(true);
      }
    }
    return;
  }
  if (expected === null) {
    expect(actual, label).toBeNull();
    return;
  }
  if (typeof expected === 'boolean' || typeof expected === 'string') {
    expect(actual, label).toBe(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${label}: expected an array`).toBe(true);
    const list = actual as readonly unknown[];
    expect(list.length, `${label}: array length`).toBe(expected.length);
    expected.forEach((item, index) => expectValue(list[index], item, `${label}[${index}]`));
    return;
  }
  if (!(expected instanceof JsonObject)) throw new Error(`${label}: unexpected expectation`);
  if (!(typeof actual === 'object' && actual !== null)) {
    throw new Error(`${label}: expected an object`);
  }
  const actualObject = actual as Record<string, unknown>;
  const expectedKeys = expected.entries.map(([key]) => key);
  expect(Object.keys(actualObject), `${label}: keys`).toEqual(expectedKeys);
  for (const [key, value] of expected.entries) {
    expectValue(actualObject[key], value, `${label}.${key}`);
  }
}

for (const family of ['enabled', 'title', 'body', 'file_issue'] as const) {
  describe(`${family} matches the Python oracle`, () => {
    for (const entry of cases.filter((candidate) => candidate.family === family)) {
      test(entry.name, async () => {
        assertCase(entry, await runCase(entry));
      });
    }
  });
}
