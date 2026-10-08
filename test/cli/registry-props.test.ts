// T4.2 registry properties suite — test/cli/registry-props.test.ts.
//
// ws-a acceptance "Any op invokable standalone from TS with plain-object
// input; result JSON-serializable (property test over the shipped op
// registry as families land)".
//
// For EVERY shipped registry entry (all families, resolved through the same
// lazy central registry the CLI uses):
//   1. a schema-derived plain-object input ROUND-TRIPS through JSON —
//      `JSON.parse(JSON.stringify(input))` deep-equals the generated object,
//      so every op boundary takes a lossless plain-data input;
//   2. when the schema accepts that input, the schema's parsed RESULT
//      JSON-serializes (round-trips again) — the validated value the op runs
//      on is plain data;
//   3. the entry's importer resolves to an op function (lazy, side-effect
//      free at bind time);
//   4. the op is INVOKED and its returned OpResult is JSON-lossless: it
//      passes the frozen OpResultSchema, satisfies the CLI's own
//      `assertJsonLossless` walk, and round-trips through JSON.
//
// HERMETIC INVOCATION (item 4, the auditor's FAIL): every entry is invoked
// under a fail-fast sandbox — a fresh temp cwd (relative paths in the
// generated input stay inside it), PATH pointed at an EMPTY bin dir (so
// git/gh/npx/agent binaries ENOENT immediately), CQ_GH_BIN pointed at a
// missing binary (the review/merge/pr/ratchet gh seam), HOME redirected into
// the sandbox, every model-provider credential (ANTHROPIC/OPENAI/DEEPSEEK/
// ZAI/CLAUDE/*_API_KEY) stripped, and both GITHUB_TOKEN and GH_TOKEN removed.
// A returned result is then asserted lossless. An op that instead THROWS its
// fail-loud contract is accepted — EXCEPT a `TypeError` (a bug, not a
// contract) or the harness's own invocation timeout (the op could not finish
// under the sandbox): both fail the case. The per-entry outcomes are
// recorded, and the suite asserts a floor of entries actually RETURNED a
// result, so the serialization property is not vacuous. NO entry needs an
// exclusion, so no ownerless deferral exists; if a future entry cannot run
// under this sandbox it must be added with BOTH a reason here and the owning
// workstream/plan §5 row (the WS-C..H family suites own the real effectful
// behavior today).
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { assertJsonLossless } from '../../src/cli/output.js';
import { OpResultSchema } from '../../src/kernel/schema.js';
import { clusterErrorsOp } from '../../src/ops/analyze/clusterErrors.js';
import { collectFailuresOp } from '../../src/ops/analyze/collectFailures.js';
import { hackDetector } from '../../src/ops/gates/hackDetector.js';
import { regressionGate } from '../../src/ops/gates/regressionGate.js';
import { checkDiffMonotonicity } from '../../src/ops/ratchet/monotonicGuard.js';
import { list } from '../../src/registry/index.js';

const entries = await list();

interface SchemaLike {
  def?: Record<string, unknown>;
  shape?: Record<string, unknown>;
}

/**
 * Build a plain-object SAMPLE from a zod 4 schema by walking its `.def`.
 * Deliberately permissive: refinements (branch-prefix rules, cross-field
 * couplings) are not satisfied — the property here is JSON-round-tripping,
 * not validity — and unknown/unsupported shapes degrade to `{}` rather than
 * throwing. Object schemas always yield a plain `{}`-prototype record.
 */
function sampleFor(schema: unknown, depth = 0): unknown {
  if (depth > 8) return {};
  const like = schema as SchemaLike;
  const def = like.def;
  if (def === undefined || typeof def['type'] !== 'string') return {};
  const inner = (): unknown => sampleFor(def['innerType'] ?? def['in'] ?? def['schema'], depth + 1);
  switch (def['type']) {
    case 'string':
      return 'x';
    case 'number':
    case 'bigint':
      return 0;
    case 'boolean':
      return true;
    case 'literal': {
      const values = def['values'];
      return Array.isArray(values) ? values[0] : null;
    }
    case 'enum': {
      const enumEntries = def['entries'];
      if (enumEntries !== null && typeof enumEntries === 'object') {
        return Object.values(enumEntries as Record<string, unknown>)[0];
      }
      return 'x';
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
      return inner();
    case 'array':
      return [];
    case 'record':
      return {};
    case 'tuple': {
      const items = def['items'];
      return Array.isArray(items) ? items.map((item) => sampleFor(item, depth + 1)) : [];
    }
    case 'union': {
      const options = def['options'];
      if (Array.isArray(options) && options.length > 0) return sampleFor(options[0], depth + 1);
      return {};
    }
    case 'pipe':
      return inner();
    case 'object': {
      const shape = like.shape;
      if (shape === undefined) return {};
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shape)) out[key] = sampleFor(child, depth + 1);
      return out;
    }
    default:
      return {};
  }
}

/** A plain object: `{}`-prototype or null-prototype, never an array/class. */
function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A timeout is the harness's own bound, distinct from an op's fail-loud throw. */
class TimeoutError extends Error {
  constructor(ms: number) {
    super(`op invocation exceeded ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Bound one op invocation; a timeout rejects with {@link TimeoutError}. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const cases = entries.map((entry) => [entry.name, entry] as const);

describe('every registry entry: schema-generated plain-object input round-trips', () => {
  test('the shipped registry exposes a non-trivial entry set', () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  test.each(cases)('%s', async (_name, entry) => {
    const input = sampleFor(entry.inputSchema);
    expect(isPlainObject(input)).toBe(true);
    const roundTripped: unknown = JSON.parse(JSON.stringify(input));
    expect(roundTripped).toEqual(input);

    const parsed = entry.inputSchema.safeParse(roundTripped);
    if (parsed.success) {
      // The parse result (the value the op actually receives) is lossless
      // plain data too.
      expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(parsed.data);
    }

    const op = await entry.importer();
    expect(typeof op).toBe('function');
  });
});

describe('pure sample: op results are JSON-serializable (OpResultSchema + the CLI walk)', () => {
  const samples: Array<[string, () => Promise<unknown>]> = [
    ['gates.regressionGate', () => regressionGate({ base: emptyTscSet(), final: emptyTscSet() })],
    ['gates.hackDetector', () => hackDetector({ diff: '' })],
    ['analyze.collectFailures', () => collectFailuresOp({ sets: [] })],
    ['analyze.clusterErrors', () => clusterErrorsOp({ set: emptyTscSet() })],
    ['ratchet.monotonicGuard', async () => ({ status: 'ok', value: checkDiffMonotonicity('') })],
  ];

  test.each(samples)(
    '%s: result passes OpResultSchema and round-trips JSON',
    async (_name, run) => {
      const result = await run();
      expect(OpResultSchema.safeParse(result).success).toBe(true);
      assertJsonLossless(result);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    },
  );

  function emptyTscSet(): { tool: string; failures: never[]; exitCode: number } {
    return { tool: 'tsc', failures: [], exitCode: 0 };
  }
});

describe('every registry entry: the op result JSON-serializes (hermetic fail-fast invocation)', () => {
  /** The floor of entries that must actually RETURN a result (not vacuous). */
  const MIN_RETURNED_RESULTS = 20;

  type InvocationOutcome =
    | { name: string; kind: 'result' }
    | { name: string; kind: 'throw'; error: string }
    | { name: string; kind: 'timeout'; error: string }
    | { name: string; kind: 'type-error'; error: string };

  const outcomes: InvocationOutcome[] = [];
  let savedCwd = '';
  let savedEnv: NodeJS.ProcessEnv = {};
  let sandbox = '';

  beforeAll(async () => {
    savedCwd = process.cwd();
    savedEnv = { ...process.env };
    sandbox = await mkdtemp(join(tmpdir(), 'cq-registry-props-'));
    await mkdir(join(sandbox, 'empty-bin'), { recursive: true });
    process.chdir(sandbox);
    // Fail-fast sandbox (see the header): relative writes stay in the temp
    // cwd, every external binary ENOENTs, and no credential is reachable.
    process.env.PATH = join(sandbox, 'empty-bin');
    process.env.HOME = sandbox;
    process.env.CQ_GH_BIN = join(sandbox, 'definitely-missing-gh');
    process.env.CQ_AUTOMATION_TOKEN = 'hermetic-test-token';
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    for (const key of Object.keys(process.env)) {
      if (/(API_KEY|ANTHROPIC|OPENAI|DEEPSEEK|ZAI|Z_AI|CLAUDE)/i.test(key)) delete process.env[key];
    }
  });

  afterAll(async () => {
    if (savedCwd !== '') process.chdir(savedCwd);
    if (Object.keys(savedEnv).length > 0) {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
    if (sandbox !== '') await rm(sandbox, { recursive: true, force: true });

    // B: the serialization property must NOT be vacuous. A timeout or a
    // TypeError already failed its own case; re-assert the aggregate so a
    // regression that makes every op throw cannot pass silently.
    const returned = outcomes.filter((outcome) => outcome.kind === 'result').length;
    const timedOut = outcomes.filter((outcome) => outcome.kind === 'timeout');
    const typeErrors = outcomes.filter((outcome) => outcome.kind === 'type-error');
    expect(timedOut.map((outcome) => outcome.name)).toEqual([]);
    expect(typeErrors.map((outcome) => `${outcome.name}: ${outcome.error}`)).toEqual([]);
    expect(returned).toBeGreaterThanOrEqual(MIN_RETURNED_RESULTS);
  });

  test.each(cases)(
    '%s: returned OpResult is JSON-lossless (a throw is an accepted fail-loud)',
    async (name, entry) => {
      const input = sampleFor(entry.inputSchema);
      const op = await entry.importer();
      let result: unknown;
      try {
        result = await withTimeout(op(input), 10_000);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (error instanceof TimeoutError) {
          // The harness's own bound: the op could not finish under the
          // hermetic sandbox — not a fail-loud contract. FAIL the case.
          outcomes.push({ name, kind: 'timeout', error: errorMessage });
          throw error;
        }
        if (error instanceof TypeError) {
          // A TypeError is a bug (bad property access, bad call), never the
          // documented fail-loud contract. FAIL the case.
          outcomes.push({ name, kind: 'type-error', error: errorMessage });
          throw error;
        }
        // Fail-loud contract: no result exists, so there is nothing to
        // serialize. Never a fabricated artifact.
        outcomes.push({ name, kind: 'throw', error: errorMessage });
        return;
      }
      outcomes.push({ name, kind: 'result' });
      expect(OpResultSchema.safeParse(result).success).toBe(true);
      assertJsonLossless(result);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    },
    20_000,
  );
});
