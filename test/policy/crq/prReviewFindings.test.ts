/**
 * Differential replay of the pull-request review delivery oracle.
 *
 * The oracle is `apps/crq-python/pr_review_findings.py`, captured by
 * `apps/crq-python/pr_review_findings_vector_emit_b1.py`. Every case compares
 * the exact value, Python exception class and message, and the full `gh`
 * argv/stdin call sequence. No real `gh`, filesystem or network effect runs
 * here; the scripted port throws the same `TimeoutExpired`/`OSError` details
 * the Python fake raised.
 */
import { describe, expect, test } from 'vitest';
import {
  GhSpawnError,
  GhTimeoutError,
  PrReviewAttributeError,
  PrReviewRuntimeError,
  PrReviewTypeError,
  PrReviewValueError,
  anchor,
  buildReview,
  cleanText,
  codeSpan,
  deliver,
  loadFindings,
  marker,
  neutraliseMentions,
  oneLine,
  rightRanges,
  type Finding,
  type GhResult,
} from '../../../src/policy/crq/prReviewFindings.js';
import { JsonObject, JsonNumber, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { sha256Hex } from '../../../src/policy/crq/pythonJson.js';
import { pythonLength } from '../../../src/policy/crq/repairBinding.js';
import {
  arrayField,
  expandInput,
  loadPrReviewVectors,
  optionalString,
  requireNumber,
  requireObject,
  requireString,
  type PrReviewCase,
} from './prReviewFindingsVectors.js';

const cases = loadPrReviewVectors();

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly message: string };

interface GhCall {
  readonly argv: readonly string[];
  readonly inputText: string | null;
}

interface GhStep {
  readonly kind: 'success' | 'timeout' | 'oserror';
  readonly returncode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly detail?: string;
}

/** A `gh` port recording argv/stdin pairs and replaying scripted results. */
class ScriptedGh {
  readonly calls: GhCall[] = [];

  constructor(
    private readonly state: string,
    private readonly merged: boolean,
    private readonly head: string,
    private readonly base: string,
    private readonly reviews: string,
    private readonly compare: GhStep,
    private readonly post: GhStep[],
    private readonly script: GhStep[] = [],
  ) {}

  static fromConfig(config: JsonObject): ScriptedGh {
    const post = config.has('post')
      ? (config.get('post') as JsonValue[]).map(scriptStep)
      : [postedStep()];
    return new ScriptedGh(
      optionalString(config.get('state')) ?? 'open',
      config.get('merged') === true,
      optionalString(config.get('head')) ?? 'a'.repeat(40),
      optionalString(config.get('base')) ?? 'b'.repeat(40),
      optionalString(config.get('reviews')) ?? '[]',
      config.has('compare') ? scriptStep(config.get('compare') as JsonValue) : defaultCompare(),
      post,
      config.has('script') ? asArrayValue(config.get('script')).map(scriptStep) : [],
    );
  }

  readonly port = (
    argv: readonly string[],
    options: { readonly inputText: string | null },
  ): GhResult => {
    this.calls.push({ argv: [...argv], inputText: options.inputText });
    // EndpointGh: a scripted step overrides the next call regardless of shape.
    if (this.script.length > 0) {
      return stepResult(argv, this.script.shift() as GhStep);
    }
    if (argv[2] === 'user') {
      return ghProcess(0, 'crq-host\n', '');
    }
    if (argv.includes('--method')) {
      const step = this.post.shift() ?? successStep(0, postedJson(), '');
      return stepResult(argv, step);
    }
    const target = argv.find((argument) => argument.startsWith('repos/')) ?? '';
    if (target.endsWith('/reviews?per_page=100')) {
      const modelled = applyReviewsJq(argv, this.reviews);
      if (typeof modelled === 'object') {
        return modelled as GhResult;
      }
      return ghProcess(0, modelled as string, '');
    }
    if (target.includes('/compare/')) {
      return stepResult(argv, this.compare);
    }
    return ghProcess(
      0,
      JSON.stringify({ state: this.state, merged: this.merged, base: this.base, head: this.head }),
      '',
    );
  };
}

/**
 * Mirror of the emitter's `_apply_reviews_jq`: rows whose `user.login`
 * equals the selector's login and whose body satisfies the marker
 * predicate, projected to `{id, url}` per line. A caller regression that
 * drops either predicate changes the argv, so the fake returns unfiltered
 * rows and the recorded calls/delivery result expose the difference.
 */
function applyReviewsJq(argv: readonly string[], raw: string): GhResult | string {
  let jq = '';
  for (const [index, argument] of argv.entries()) {
    if (argument === '--jq' && index + 1 < argv.length) {
      jq = argv[index + 1] as string;
      break;
    }
  }
  const loginMatch = jq.match(/select\(\.user\.login == "((?:[^"\\]|\\.)*)"/);
  const literalMatch = jq.match(/(startswith|contains)\("((?:[^"\\]|\\.)*)"\)/);
  if (loginMatch === null || literalMatch === null) {
    // Unmodelled selector: refuse rather than fake agreement.
    return { returncode: processCode(3), stdout: '', stderr: 'jq: unmodelled selector in fake' };
  }
  const login = JSON.parse(`"${loginMatch[1] as string}"`) as string;
  const predicate = literalMatch[1];
  const wanted = JSON.parse(`"${literalMatch[2] as string}"`) as string;
  const nounOf = (row: unknown): string =>
    row === null
      ? 'null'
      : Array.isArray(row)
        ? 'array'
        : typeof row === 'string'
          ? 'string'
          : typeof row === 'number'
            ? 'number'
            : typeof row === 'boolean'
              ? 'boolean'
              : 'object';
  const keep = () => outLines.map((line) => `${line}\n`).join('');
  // Real `gh --paginate` feeds jq one stream of concatenated pages, each a
  // JSON array on its own line; jq processes documents in sequence and
  // reports the 0-based document line where an error hit.
  const outLines: string[] = [];
  for (const [pageIndex, pageLine] of raw.split('\n').entries()) {
    if (pageLine.trim() === '') continue;
    let page: unknown;
    try {
      page = JSON.parse(pageLine);
    } catch {
      return {
        returncode: processCode(2),
        stdout: keep(),
        stderr: `jq: parse error: Invalid literal at line ${pageIndex + 1}`,
      };
    }
    if (!Array.isArray(page)) {
      return {
        returncode: processCode(2),
        stdout: keep(),
        stderr: `jq: error (at <stdin>:${pageIndex}): Cannot iterate over null`,
      };
    }
    for (const row of page) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        // Real jq streams results as it goes: earlier matches stay on stdout
        // and the message names the row's actual JSON type.
        return {
          returncode: processCode(5),
          stdout: keep(),
          stderr: `jq: error (at <stdin>:${pageIndex}): Cannot index ${nounOf(row)} with string ("user")`,
        };
      }
      const record = row as unknown as Record<string, JsonValue>;
      const user = record['user'];
      const loginValue =
        user !== null && typeof user === 'object' && !Array.isArray(user)
          ? (user as unknown as Record<string, JsonValue>)['login']
          : undefined;
      if (loginValue !== login) continue;
      const body = typeof record['body'] === 'string' ? (record['body'] as string) : '';
      if (predicate === 'startswith' && !body.startsWith(wanted)) continue;
      if (predicate === 'contains' && !body.includes(wanted)) continue;
      outLines.push(JSON.stringify({ id: record['id'] ?? null, url: record['html_url'] ?? null }));
    }
  }
  return keep();
}

function asArrayValue(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error('gh script: expected an array');
  return value;
}

function postedJson(): string {
  return JSON.stringify({ id: 77, html_url: 'https://github.com/x/r/pull/77' });
}

function successStep(returncode: number, stdout: string, stderr: string): GhStep {
  return { kind: 'success', returncode, stdout, stderr };
}

function defaultCompare(): GhStep {
  return successStep(
    0,
    JSON.stringify([{ filename: 'src/a.py', status: 'modified', patch: DEFAULT_PATCH }]),
    '',
  );
}

const DEFAULT_PATCH = '@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n@@ -40,2 +41,6 @@\n x\n+y\n';

function postedStep(): GhStep {
  return successStep(0, postedJson(), '');
}

function scriptStep(value: JsonValue): GhStep {
  const object = requireObject(value, 'gh step');
  const raised = object.get('raise');
  if (raised !== undefined) {
    const kind = requireString(raised, 'gh step raise');
    if (kind !== 'timeout' && kind !== 'oserror') {
      throw new Error(`gh step: unknown raise ${kind}`);
    }
    return { kind, detail: requireString(object.get('detail'), 'gh step detail') };
  }
  return {
    kind: 'success',
    returncode: requireNumber(object.get('returncode'), 'gh step returncode'),
    stdout: requireString(object.get('stdout'), 'gh step stdout'),
    stderr: requireString(object.get('stderr'), 'gh step stderr'),
  };
}

function stepResult(argv: readonly string[], step: GhStep): GhResult {
  if (step.kind === 'timeout') throw new GhTimeoutError(timeoutDetail(argv));
  if (step.kind === 'oserror') throw new GhSpawnError(step.detail ?? '');
  return ghProcess(step.returncode ?? 0, step.stdout ?? '', step.stderr ?? '');
}

function ghProcess(returncode: number, stdout: string, stderr: string): GhResult {
  return { returncode: processCode(returncode), stdout, stderr };
}

/** The port models returncode as JSON; the replay materialises it. */
function processCode(returncode: number): JsonValue {
  return JsonNumber.int(BigInt(returncode));
}

/** Python `str(subprocess.TimeoutExpired(argv, 60))`. */
function timeoutDetail(argv: readonly string[]): string {
  return `Command '['${argv.join("', '")}]' timed out after 60 seconds`;
}

function inputValue(entry: PrReviewCase, key: string): JsonValue {
  const value = entry.input.get(key);
  if (value === undefined) throw new Error(`${entry.family}/${entry.name}: missing ${key}`);
  return expandInput(value);
}

function asJsonObject(value: JsonValue, what: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error(`${what}: expected an object`);
  return value;
}

function asArray(value: JsonValue, what: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}

/** The findings list a vector carries, already in the pure module's shape. */
function asFindings(value: JsonValue): Finding[] {
  return asArray(value, 'findings').map((finding, index) => {
    const object = asJsonObject(finding, `findings[${index}]`);
    return {
      severity: object.has('severity') ? (object.get('severity') as JsonValue) : null,
      path: object.has('path') ? (object.get('path') as JsonValue) : null,
      start: object.has('start') ? (object.get('start') as JsonValue) : null,
      end: object.has('end') ? (object.get('end') as JsonValue) : null,
      title: object.has('title') ? (object.get('title') as JsonValue) : null,
      text: object.has('text') ? (object.get('text') as JsonValue) : null,
    };
  });
}

/** The hunks map a vector carries: {path: [[lo, hi], ...]}. */
function asHunks(value: JsonValue): Record<string, ReadonlyArray<HunkRange>> | null {
  if (value === null) return null;
  const object = asJsonObject(value, 'hunks');
  const map: Record<string, ReadonlyArray<HunkRange>> = {};
  for (const [path, ranges] of object.entries) {
    map[path] = asArray(ranges, `hunks[${path}]`).map((range) => {
      const pair = asArray(range, 'range');
      return { lo: jsonNumberOf(pair[0]), hi: jsonNumberOf(pair[1]) };
    });
  }
  return map;
}

interface HunkRange {
  readonly lo: number;
  readonly hi: number;
}

/** A safe JSON integer as the lossless model value. */
function int(value: number): JsonValue {
  return JsonNumber.int(BigInt(value));
}

function jsonNumberOf(value: JsonValue | undefined): number {
  if (typeof value === 'number') return value;
  if (value instanceof JsonNumber && value.kind === 'int') {
    const converted = Number(value.integer);
    if (Number.isSafeInteger(converted)) return converted;
  }
  throw new Error('range: expected an integer');
}

async function runCase(entry: PrReviewCase): Promise<{ outcome: Outcome; calls?: GhCall[] }> {
  switch (entry.family) {
    case 'marker':
      return {
        outcome: await capture(() => marker(requireString(inputValue(entry, 'run_id'), 'run_id'))),
      };
    case 'load_findings': {
      const text = inputValue(entry, 'text');
      if (typeof text !== 'string') {
        // Python receives a non-str where a Path is expected; the port keeps
        // the same recorded failure by rejecting before any read.
        return {
          outcome: await capture(() => {
            throw new PrReviewTypeError(
              `expected str, bytes or os.PathLike object, not ${pythonTypeName(text)}`,
            );
          }),
        };
      }
      return { outcome: await capture(() => loadFindings(text)) };
    }
    case 'one_line':
      return { outcome: await capture(() => oneLine(inputValue(entry, 'text'))) };
    case 'code_span':
      return { outcome: await capture(() => codeSpan(inputValue(entry, 'text'))) };
    case 'clean_text': {
      const text = inputValue(entry, 'text');
      const title = entry.input.has('title') ? inputValue(entry, 'title') : '';
      return { outcome: await capture(() => cleanText(text, title)) };
    }
    case 'right_ranges': {
      const outcome = await capture(() => rightRanges(inputValue(entry, 'patch')));
      if (!outcome.ok) return { outcome };
      // Python tuples arrive as JSON pairs; the port keeps named bounds.
      const ranges = outcome.value as ReadonlyArray<{ lo: number; hi: number }>;
      return { outcome: { ok: true, value: ranges.map((r) => [r.lo, r.hi]) } };
    }
    case 'build_review': {
      // The pure module takes already-typed arguments. The oracle's dynamic
      // shape failures (list instead of dict, str instead of dict) are Python
      // type errors from indexing; reproduce them at this boundary with the
      // recorded message instead of inventing port behaviour.
      const metaValue = inputValue(entry, 'meta');
      const findingsValue = inputValue(entry, 'findings');
      // The recorded message is the fixture's claim about Python's error;
      // throwing the boundary literal (not `message || literal`) keeps the
      // comparison falsifiable: a wrong recorded message fails the case.
      if (!(metaValue instanceof JsonObject)) {
        return {
          outcome: await capture(() => {
            throw new PrReviewTypeError('list indices must be integers or slices, not str');
          }),
        };
      }
      if (!Array.isArray(findingsValue) || !findingsValue.every((f) => f instanceof JsonObject)) {
        return {
          outcome: await capture(() => {
            throw new PrReviewTypeError("string indices must be integers, not 'str'");
          }),
        };
      }
      const meta = asJsonObject(metaValue, 'meta');
      const findings = asFindings(findingsValue);
      const hunks = asHunks(inputValue(entry, 'hunks'));
      return { outcome: await capture(() => buildReview(meta, findings, hunks)) };
    }
    case 'deliver': {
      const gh = ScriptedGh.fromConfig(asJsonObject(inputValue(entry, 'gh'), 'gh'));
      const findings = loadFindings(requireString(inputValue(entry, 'events'), 'events'));
      const meta = asJsonObject(inputValue(entry, 'meta'), 'meta');
      const login = optionalString(entry.input.has('login') ? entry.input.get('login') : undefined);
      // Python's identity check rejects non-int pr values (7.5, true) with
      // ValueError before any gh call; reproduce that type strictness here.
      const prValue = inputValue(entry, 'pr');
      const prIsInt = prValue instanceof JsonNumber && prValue.kind === 'int';
      const outcome = await capture(() => {
        if (!prIsInt) {
          throw new PrReviewValueError('invalid PR review delivery identity');
        }
        return deliver({
          repo: requireString(inputValue(entry, 'repo'), 'repo'),
          pr: requireNumber(prValue, 'pr'),
          meta,
          findings,
          gh: gh.port,
          login: login ?? null,
        });
      });
      return { outcome, calls: gh.calls };
    }
    default:
      throw new Error(`unknown pr-review vector family: ${entry.family}`);
  }
}

function pythonTypeName(value: JsonValue): string {
  if (value === null) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'str';
  if (value instanceof JsonNumber) return value.kind;
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

async function capture(action: () => unknown): Promise<Outcome> {
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
  if (
    error instanceof PrReviewValueError ||
    error instanceof PrReviewRuntimeError ||
    error instanceof PrReviewAttributeError ||
    error instanceof PrReviewTypeError
  ) {
    return error.pythonError;
  }
  return error instanceof Error ? error.name : 'UnknownError';
}

function assertCase(entry: PrReviewCase, result: { outcome: Outcome; calls?: GhCall[] }): void {
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
  if (typeof actual !== 'object' || actual === null) {
    throw new Error(`${label}: expected an object`);
  }
  // A JsonObject actual compares entry-wise; a plain record compares by keys.
  if (actual instanceof JsonObject) {
    const expectedKeys = expected.entries.map(([key]) => key);
    expect(
      actual.entries.map(([key]) => key),
      `${label}: keys`,
    ).toEqual(expectedKeys);
    for (const [key, value] of expected.entries) {
      expectValue(actual.get(key) as JsonValue, value, `${label}.${key}`);
    }
    return;
  }
  const actualObject = actual as Record<string, unknown>;
  const expectedKeys = expected.entries.map(([key]) => key);
  expect(Object.keys(actualObject), `${label}: keys`).toEqual(expectedKeys);
  for (const [key, value] of expected.entries) {
    expectValue(actualObject[key], value, `${label}.${key}`);
  }
}

for (const family of [
  'marker',
  'load_findings',
  'one_line',
  'code_span',
  'clean_text',
  'right_ranges',
  'build_review',
  'deliver',
] as const) {
  describe(`${family} matches the Python oracle`, () => {
    for (const entry of cases.filter((candidate) => candidate.family === family)) {
      test(entry.name, async () => {
        assertCase(entry, await runCase(entry));
      });
    }
  });
}

// The oracle exercises anchor() through build_review payloads; keep one direct
// structural check so the exported helper stays covered beyond the vectors.
describe('anchor structural coverage', () => {
  test('clamps to the first overlapping hunk', () => {
    const finding: Finding = {
      severity: 'minor',
      path: 'f',
      start: int(15),
      end: int(35),
      title: 't',
      text: 'x',
    };
    expect(
      anchor(finding, {
        f: [
          { lo: 10, hi: 20 },
          { lo: 30, hi: 40 },
        ],
      }),
    ).toEqual({
      path: 'f',
      line: int(20),
      side: 'RIGHT',
      start_line: int(15),
      start_side: 'RIGHT',
    });
  });

  test('single-line finding carries no start_line', () => {
    const finding: Finding = {
      severity: 'minor',
      path: 'f',
      start: int(31),
      end: int(31),
      title: 't',
      text: 'x',
    };
    expect(
      anchor(finding, {
        f: [
          { lo: 10, hi: 20 },
          { lo: 30, hi: 40 },
        ],
      }),
    ).toEqual({
      path: 'f',
      line: int(31),
      side: 'RIGHT',
    });
  });

  test('non-overlapping and missing paths refuse', () => {
    const finding: Finding = {
      severity: 'm',
      path: 'f',
      start: int(21),
      end: int(25),
      title: '',
      text: '',
    };
    expect(
      anchor(finding, {
        f: [
          { lo: 10, hi: 20 },
          { lo: 30, hi: 40 },
        ],
      }),
    ).toBeUndefined();
    expect(anchor({ ...finding, path: 'g' }, { f: [{ lo: 1, hi: 2 }] })).toBeUndefined();
  });
});

// Keep the POST stdin byte-exact for one created case: the fixture records the
// argv/stdin pair, and the replay above asserts it through assertCalls.
describe('POST payload parity', () => {
  test('created-anchored posts the oracle payload bytes', () => {
    const entry = cases.find((candidate) => candidate.name === 'created-anchored');
    if (entry === undefined) throw new Error('created-anchored vector missing');
    const gh = ScriptedGh.fromConfig(asJsonObject(inputValue(entry, 'gh'), 'gh'));
    const findings = loadFindings(requireString(inputValue(entry, 'events'), 'events'));
    const meta = asJsonObject(inputValue(entry, 'meta'), 'meta');
    const outcome = deliver({
      repo: requireString(inputValue(entry, 'repo'), 'repo'),
      pr: requireNumber(inputValue(entry, 'pr'), 'pr'),
      meta,
      findings,
      gh: gh.port,
      login: null,
    });
    expect(outcome.state).toBe('created');
    const post = gh.calls.find((call) => call.argv.includes('--method'));
    expect(post).toBeDefined();
    const expected = requireObject(
      arrayField(entry.expect, 'calls')
        .map((call) => requireObject(call, 'call'))
        .find((call) => arrayField(call, 'argv').includes('--method')) as JsonValue,
      'expected post',
    );
    expect(post?.inputText).toBe(requireString(expected.get('input_text'), 'post input_text'));
  });
});

// neutraliseMentions fence/mention invariants beyond single vectors.
describe('neutralisation invariants', () => {
  test('mention neutralisation and fence closing compose', () => {
    expect(neutraliseMentions('ping @user and `@user` stays')).toBe('ping @‍user and `@user` stays');
    expect(neutraliseMentions('```py\n@user')).toBe('```py\n@user\n```');
  });
});
