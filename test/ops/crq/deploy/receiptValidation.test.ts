import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../../src/policy/crq/jsonValue.js';
import { receiptJsonDigest } from '../../../../src/policy/crq/pythonJson.js';
import {
  OSError,
  localReviewProblem,
  localReviewSchema,
  newest,
  receiptFamily,
  receiptProblem,
  receiptSchema,
  receiptValidation,
  schemaProblem,
  type DeploymentConstants,
  type ReceiptSchema,
  type ReceiptValidationEffects,
} from '../../../../src/ops/crq/deploy/receiptValidation.js';

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const obj = (v: unknown): JsonObject => {
  const parsed = parseJsonValue(JSON.stringify(v));
  if (!(parsed instanceof JsonObject)) throw new Error('not object');
  return parsed;
};
const H40 = 'a'.repeat(40);
const paths = [
  { source_path: 'a.ts', path: 'a.ts', resolution: 'same-path-current', disposition: 'included' },
];
const scope = sha(
  new TextEncoder().encode(
    '[{"disposition":"included","path":"a.ts","resolution":"same-path-current","source_path":"a.ts"}]',
  ),
);
function merged(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    item_id: 'item',
    run_id: 'run-20261115T010203Z'.replace('run', 'r1'),
    request_id: null,
    started_at: null,
    source: {
      repo: 'o/r',
      pr: 5,
      merge_sha: H40,
      target_selector: 'merge-queue',
      policy: 'affected-current-additions-v1',
    },
    capture: {
      target: H40,
      tree: H40,
      paths,
      scope_digest: scope,
      equivalence: 'b'.repeat(64),
      policy: 'affected-current-additions-v1',
      projection: 'current-affected-files/full-file-addition-projection',
      reviewer: 'coderabbit-review-agent-committed-v1',
      reviewer_version: '1',
      captured_at: 'now',
    },
    outcome: 'terminal-clean',
    counted: false,
    classification: null,
    findings: [],
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
    ...over,
  };
}
const named = (doc: unknown): { name: string; data: Uint8Array } => {
  const data = enc(doc);
  return { name: `${sha(data)}.json`, data };
};
const schema: ReceiptSchema = {
  schema_source: 's',
  policy: 'affected-current-additions-v1',
  version: 1,
  targets: ['promoted-main', 'merge-queue'],
  local_review: null,
  local_review_source: 'x',
};
const problem = (doc: unknown, s = schema): string | null => {
  const { name, data } = named(doc);
  return receiptProblem(name, data, s);
};

describe('receiptProblem merged-current', () => {
  test('a well-formed receipt is valid', () => {
    expect(problem(merged())).toBeNull();
  });
  test('name must be the content digest', () => {
    const { data } = named(merged());
    expect(receiptProblem(`${'0'.repeat(64)}.json`, data, schema)).toMatch(/^content identity/);
  });
  test('malformed JSON and non-objects', () => {
    const bad = new TextEncoder().encode('{');
    expect(receiptProblem(`${sha(bad)}.json`, bad, schema)).toBe('malformed: not valid JSON');
    const list = enc([1]);
    expect(receiptProblem(`${sha(list)}.json`, list, schema)).toBe('malformed: not a JSON object');
    const nan = new TextEncoder().encode('NaN');
    expect(receiptProblem(`${sha(nan)}.json`, nan, schema)).toBe('malformed: not a JSON object');
    const latin = Uint8Array.of(0x22, 0xff, 0x22);
    expect(receiptProblem(`${sha(latin)}.json`, latin, schema)).toBe('malformed: not valid JSON');
  });
  test('bytes with a BOM parse like json.loads(bytes)', () => {
    const body = enc(merged());
    const data = Uint8Array.of(0xef, 0xbb, 0xbf, ...body);
    expect(receiptProblem(`${sha(data)}.json`, data, schema)).toBeNull();
  });
  test('unsupported family is truncated to 60 code points', () => {
    expect(problem({ kind: 'x'.repeat(80), v: 1 })).toBe(
      `unsupported receipt family: ${'x'.repeat(60)}`,
    );
    expect(problem({ v: 1 })).toBe('unsupported receipt family: unknown');
  });
  test('version', () => {
    expect(problem(merged({ version: 2 }))).toBe('unsupported receipt version');
    expect(problem(merged({ version: true }))).toBeNull(); // Python: True == 1
    expect(problem(merged({ version: 1.0 }))).toBeNull();
    const data = new TextEncoder().encode(
      JSON.stringify(merged()).replace('"version":1', '"version":1.0'),
    );
    expect(receiptProblem(`${sha(data)}.json`, data, schema)).toBeNull();
  });
  test('run identity', () => {
    expect(problem(merged({ item_id: '' }))).toBe('run identity: missing item_id');
    expect(problem(merged({ run_id: 'bad id' }))).toBe('run identity: malformed run_id');
    const long = (n: number): string => `r${'a'.repeat(n - 18)}-20261115T010203Z`;
    expect(problem(merged({ run_id: long(255) }))).toBeNull();
    expect(problem(merged({ run_id: long(256) }))).toBe('run identity: malformed run_id');
    expect(problem(merged({ run_id: null }))).toBeNull();
    expect(problem(merged({ request_id: 5 }))).toBe('run identity: malformed request_id');
    expect(problem(merged({ started_at: 5 }))).toBe('run identity: malformed started_at');
  });
  test('source binding', () => {
    const src = (over: Record<string, unknown>): unknown =>
      merged({ source: { ...(merged().source as object), ...over } });
    const msg = 'target: source binding is not a v1 merged-current subject';
    for (const over of [
      { repo: 'nope' },
      { repo: '' },
      { pr: 0 },
      { pr: 1.5 },
      { pr: true },
      { merge_sha: 'A'.repeat(40) },
      { target_selector: 'other' },
      { policy: 'x' },
    ])
      expect(problem(src(over))).toBe(msg);
    expect(problem(merged({ source: null }))).toBe(msg);
  });
  test('capture shape and manifest', () => {
    const cap = (over: Record<string, unknown>): unknown =>
      merged({ capture: { ...(merged().capture as object), ...over } });
    expect(problem(cap({ target: 'z' }))).toBe(
      'target: captured target/tree is not a pinned 40-hex SHA',
    );
    expect(problem(merged({ capture: null }))).toBe(
      'target: captured target/tree is not a pinned 40-hex SHA',
    );
    expect(problem(cap({ paths: 'x' }))).toBe('target: malformed captured path manifest');
    expect(problem(cap({ paths: [{ ...paths[0], disposition: 'deferred-split' }] }))).toBe(
      'target: malformed captured path manifest',
    );
    expect(problem(cap({ scope_digest: '0'.repeat(64) }))).toBe(
      'target: scope digest does not match the path manifest',
    );
    expect(problem(cap({ equivalence: 'x' }))).toBe('target: unsupported capture policy/reviewer');
    expect(problem(cap({ reviewer: 'other' }))).toBe('target: unsupported capture policy/reviewer');
    expect(problem(cap({ captured_at: 1 }))).toBe('target: unsupported capture policy/reviewer');
    expect(problem(cap({ reviewer_version: '' }))).toBe(
      'target: unsupported capture policy/reviewer',
    );
  });
  test('terminal outcome', () => {
    expect(problem(merged({ outcome: 'pending' }))).toBe(
      'terminal outcome: missing or non-terminal outcome',
    );
    expect(problem(merged({ outcome: 'reviewing' }))).toBe(
      'terminal outcome: missing or non-terminal outcome',
    );
    expect(problem(merged({ outcome: '' }))).toBe(
      'terminal outcome: missing or non-terminal outcome',
    );
    expect(problem(merged({ counted: 1 }))).toBe('terminal outcome: counted is not a boolean');
    expect(problem(merged({ classification: [] }))).toBe(
      'terminal outcome: malformed classification',
    );
    const counted = {
      counted: true,
      run_id: 'r1-20261115T010203Z',
      classification: { counted: true, outcome: 'completed' },
    };
    expect(problem(merged(counted))).toBeNull();
    const msg = 'terminal outcome: counted without a completed classified run';
    expect(problem(merged({ ...counted, outcome: 'other' }))).toBe(msg);
    expect(problem(merged({ ...counted, run_id: null }))).toBe(msg);
    expect(problem(merged({ ...counted, classification: null }))).toBe(msg);
    expect(
      problem(merged({ ...counted, classification: { counted: false, outcome: 'completed' } })),
    ).toBe(msg);
    expect(problem(merged({ ...counted, classification: { counted: true, outcome: 'x' } }))).toBe(
      msg,
    );
  });
  test('findings, artifacts and acceptance', () => {
    const msg = 'malformed: findings/artifacts/acceptance fields';
    for (const over of [
      { findings: 'x' },
      { findings: [1] },
      { artifacts: [] },
      { artifacts: { a: 'x' } },
      { remediation: 'x' },
      { independent_acceptance: true },
      { cli_functional_acceptance: 'x' },
    ])
      expect(problem(merged(over))).toBe(msg);
    expect(problem(merged({ artifacts: { a: 'c'.repeat(64) }, findings: [{}] }))).toBeNull();
  });
});

describe('receiptProblem push-range', () => {
  const push = (over: Record<string, unknown> = {}, src: Record<string, unknown> = {}): unknown =>
    merged({
      source: {
        type: 'push-range',
        repo: 'o/r',
        base: H40,
        head: H40,
        policy: schema.policy,
        ...src,
      },
      ...over,
    });
  const msg = 'target: source binding is not a v1 push-range subject';
  test('valid and source rules', () => {
    expect(problem(push())).toBeNull();
    for (const src of [{ repo: 'x' }, { base: 'x' }, { head: 'x' }, { policy: 'x' }])
      expect(problem(push({}, src))).toBe(msg);
    expect(problem(push({}, { paths_filter: [] }))).toBe(
      'target: malformed push-range paths_filter',
    );
    expect(problem(push({}, { paths_filter: ['a', ''] }))).toBe(
      'target: malformed push-range paths_filter',
    );
    expect(problem(push({}, { paths_filter: null }))).toBeNull();
    expect(problem(push({}, { paths_filter: ['a'] }))).toBeNull();
    expect(problem(push({}, { pin: 'x' }))).toBe('target: push-range pin is not a 40-hex SHA');
    expect(problem(push({}, { pin: H40 }))).toBeNull();
  });
  test('push dispositions extend the merged set', () => {
    const cap = merged().capture as { paths: unknown };
    const p = [{ ...paths[0], disposition: 'excluded-config' }];
    const digest = receiptJsonDigest(parseJsonValue(JSON.stringify(p)));
    const doc = push({ capture: { ...cap, paths: p, scope_digest: digest } });
    expect(problem(doc)).toBeNull();
    const asMerged = merged({ capture: { ...cap, paths: p, scope_digest: digest } });
    expect(problem(asMerged)).toBe('target: malformed captured path manifest');
  });
  test('family detection', () => {
    expect(receiptFamily(obj(merged()))).toBe('merged-current');
    expect(receiptFamily(obj(push()))).toBe('push-range');
    expect(receiptFamily(obj({ kind: 'k' }))).toBe('k');
    expect(receiptFamily(obj({ kind: '' }))).toBe('unknown');
    expect(receiptFamily(obj({ kind: 5, v: 1 }))).toBe('unknown');
    expect(receiptFamily(obj({ v: 1 }))).toBe('unknown');
  });
});

const rule = obj({
  type: 'object',
  required: ['type', 'identity', 'identity_inputs', 'scope_adequate', 'outcome', 'findings'],
  additionalProperties: false,
  properties: {
    type: { const: 'receipt' },
    identity: { type: 'string', pattern: '[0-9a-f]{64}' },
    identity_inputs: { type: 'object' },
    scope_adequate: { type: 'boolean' },
    outcome: { enum: ['clean', 'findings', 'partial'] },
    findings: { type: 'array', maxItems: 3 },
  },
});
function local(over: Record<string, unknown> = {}): JsonObject {
  const inputs = { a: 1 };
  return obj({
    type: 'receipt',
    identity: receiptJsonDigest(obj(inputs)),
    identity_inputs: inputs,
    scope_adequate: true,
    outcome: 'clean',
    findings: [],
    ...over,
  });
}

describe('local review receipts', () => {
  test('unverified without a rule', () => {
    expect(localReviewProblem(local(), null)).toBe(
      'local-review: unverified, deployment receipt schema unavailable',
    );
  });
  test('accepts a consistent receipt', () => {
    expect(localReviewProblem(local(), rule)).toBeNull();
  });
  test('schema, identity and outcome checks', () => {
    expect(localReviewProblem(local({ extra: 1 }), rule)).toBe(
      'local-review schema: receipt: unknown extra',
    );
    expect(localReviewProblem(local({ identity: '0'.repeat(64) }), rule)).toBe(
      'local-review identity: identity is not the digest of identity_inputs',
    );
    expect(localReviewProblem(local({ outcome: 'findings' }), rule)).toBe(
      'local-review outcome: adequate scope with an outcome that contradicts findings',
    );
    expect(localReviewProblem(local({ outcome: 'clean', findings: [1] }), rule)).toBe(
      'local-review outcome: adequate scope with an outcome that contradicts findings',
    );
    expect(localReviewProblem(local({ outcome: 'findings', findings: [1] }), rule)).toBeNull();
    expect(localReviewProblem(local({ scope_adequate: false }), rule)).toBe(
      'local-review outcome: verdict recorded without adequate scope',
    );
    expect(localReviewProblem(local({ scope_adequate: false, outcome: 'findings' }), rule)).toBe(
      'local-review outcome: verdict recorded without adequate scope',
    );
    expect(
      localReviewProblem(local({ scope_adequate: false, outcome: 'partial' }), rule),
    ).toBeNull();
  });
  test('local family dispatches to the rule', () => {
    const doc = { kind: 'local-review-full-diff', v: 1 };
    const { name, data } = named(doc);
    expect(receiptProblem(name, data, { ...schema, local_review: null })).toBe(
      'local-review: unverified, deployment receipt schema unavailable',
    );
    expect(receiptProblem(name, data, { ...schema, local_review: rule })).toMatch(
      /^local-review schema: /,
    );
  });
});

describe('schemaProblem vocabulary', () => {
  const p = (value: unknown, r: unknown): string | null =>
    schemaProblem(parseJsonValue(JSON.stringify(value)), parseJsonValue(JSON.stringify(r)));
  test('unknown keyword fails closed', () => {
    expect(p(1, { format: 'x' })).toBe('receipt: unsupported schema keyword');
  });
  test('oneOf needs exactly one match', () => {
    expect(p(1, { oneOf: [{ type: 'integer' }, { type: 'string' }] })).toBeNull();
    expect(p(1, { oneOf: [{ type: 'integer' }, { minimum: 0 }] })).toBe(
      'receipt: does not match exactly one variant',
    );
    expect(p(1, { oneOf: [{ type: 'string' }] })).toBe(
      'receipt: does not match exactly one variant',
    );
  });
  test('types', () => {
    expect(p(true, { type: 'integer' })).toBe('receipt: type mismatch');
    expect(p(1.5, { type: 'integer' })).toBe('receipt: type mismatch');
    expect(p(1, { type: ['string', 'integer'] })).toBeNull();
    expect(p(null, { type: 'null' })).toBeNull();
    expect(() => p(1, { type: 'number' })).toThrow();
  });
  test('const and enum use Python equality', () => {
    expect(p(1, { const: 1.0 })).toBeNull();
    expect(p(true, { const: 1 })).toBeNull();
    expect(p('a', { const: 'b' })).toBe('receipt: value mismatch');
    expect(p('a', { enum: ['b'] })).toBe('receipt: value mismatch');
  });
  test('objects', () => {
    const r = {
      required: ['b', 'a'],
      properties: { a: { type: 'string' }, b: {} },
      additionalProperties: false,
    };
    expect(p({}, r)).toBe('receipt: missing a,b');
    expect(p({ a: 'x', b: 1, c: 1, d: 1 }, r)).toBe('receipt: unknown c,d');
    expect(p({ a: 1, b: 1 }, r)).toBe('a: type mismatch');
    expect(p({ a: 'x', b: 1, c: 1 }, { properties: {} })).toBeNull();
  });
  test('arrays', () => {
    expect(p([1], { minItems: 2 })).toBe('receipt: array bound');
    expect(p([1, 2], { maxItems: 1 })).toBe('receipt: array bound');
    expect(p([1, 'x'], { items: { type: 'integer' } })).toBe('receipt[1]: type mismatch');
    expect(p([1], { items: { type: 'integer' }, minItems: 1, maxItems: 1 })).toBeNull();
  });
  test('strings are bounded by code points and full-matched', () => {
    expect(p('😀', { minLength: 1 })).toBeNull();
    expect(p('😀', { minLength: 2 })).toBe('receipt: string bound');
    expect(p('ab', { pattern: 'a' })).toBe('receipt: string bound');
    expect(p('ab', { pattern: 'a.' })).toBeNull();
  });
  test('minimum applies to ints only', () => {
    expect(p(1, { minimum: 2 })).toBe('receipt: below minimum');
    expect(p(2, { minimum: 2 })).toBeNull();
    expect(p(1.5, { minimum: 2 })).toBeNull();
    expect(p('x', { minimum: 2 })).toBeNull();
  });
  test('nested path labels', () => {
    expect(
      p(
        { a: [{ b: 1 }] },
        { properties: { a: { items: { properties: { b: { type: 'string' } } } } } },
      ),
    ).toBe('a[0].b: type mismatch');
  });
});

const bytes = (v: unknown): Uint8Array => enc(v);
const constants = (over: Partial<DeploymentConstants> = {}): DeploymentConstants => ({
  policy: 'p2',
  version: 2,
  selectors: ['t1'],
  ...over,
});
const localDoc = {
  oneOf: [
    { properties: { type: { const: 'other' }, value: { x: 1 } } },
    { properties: { type: { const: 'receipt' }, value: { type: 'object' } } },
  ],
};

describe('receiptSchema', () => {
  const eff = (
    c: () => Promise<DeploymentConstants>,
    read: (p: string) => Promise<Uint8Array>,
  ) => ({
    deploymentConstants: c,
    readFile: read,
  });
  const noFile = async (): Promise<Uint8Array> => {
    throw new OSError('no such file');
  };
  test('deployment constants win', async () => {
    const s = await receiptSchema(
      eff(
        async () => constants(),
        async () => bytes(localDoc),
      ),
    );
    expect(s).toMatchObject({
      schema_source: 'deployment:apps/crq-python/review_receipt.py',
      policy: 'p2',
      version: 2,
      targets: ['t1'],
      local_review_source: 'deployment:policy/review-operation.schema.json',
    });
    expect(s.local_review).toBeInstanceOf(JsonObject);
  });
  test('falls back to the builtin copy with the reason', async () => {
    const s = await receiptSchema(
      eff(async () => {
        throw new Error('z'.repeat(100));
      }, noFile),
    );
    expect(s.policy).toBe('affected-current-additions-v1');
    expect(s.version).toBe(1);
    expect(s.targets).toEqual(['promoted-main', 'merge-queue']);
    expect(s.schema_source).toBe(
      `builtin (deployment constants unavailable: Error: ${'z'.repeat(80)})`,
    );
    expect(s.local_review).toBeNull();
    expect(s.local_review_source).toBe('unavailable: OSError: no such file');
  });
  test.each([
    { policy: 5 },
    { version: '1' },
    { version: 1.5 },
    { selectors: [] },
    { selectors: [1] },
    { selectors: 'x' },
  ])('rejects unexpected constant types %j', async (bad) => {
    const s = await receiptSchema(
      eff(async () => constants(bad as Partial<DeploymentConstants>), noFile),
    );
    expect(s.schema_source).toMatch(/^builtin \(deployment constants unavailable: /);
  });
  test('local review schema errors name the exception', async () => {
    const read = (b: Uint8Array) => ({ readFile: async () => b });
    const src = async (b: Uint8Array): Promise<string> =>
      (await localReviewSchema(read(b))).local_review_source;
    expect(await src(new TextEncoder().encode('{'))).toMatch(/^unavailable: JSONDecodeError: /);
    expect(await src(Uint8Array.of(0xff))).toMatch(/^unavailable: UnicodeDecodeError: /);
    expect(await src(bytes({}))).toBe("unavailable: KeyError: 'oneOf'");
    expect(
      await src(bytes({ oneOf: [{ properties: { type: { const: 'x' }, value: {} } }] })),
    ).toMatch(/^unavailable: ValueError/);
    const two = { properties: { type: { const: 'receipt' }, value: {} } };
    expect(await src(bytes({ oneOf: [two, two] }))).toMatch(/^unavailable: ValueError/);
    expect(await src(bytes({ oneOf: [{ properties: { type: { const: 'receipt' } } }] }))).toBe(
      "unavailable: KeyError: 'value'",
    );
    expect(
      await src(bytes({ oneOf: [{ properties: { type: { const: 'receipt' }, value: [] } }] })),
    ).toMatch(/^unavailable: ValueError/);
  });
  test('non-Python errors from reads propagate', async () => {
    await expect(
      localReviewSchema({
        readFile: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
  });
});

describe('newest', () => {
  test('mtime descending, then code-point name, unstattable last', async () => {
    const m: Record<string, bigint | 'err'> = {
      a: 5n,
      b: 5n,
      c: 9n,
      e: 0n,
      d: 'err',
      '\u{1F600}': 5n,
      '～': 5n,
    };
    const out = await newest(Object.keys(m), 10, async (n) => {
      const v = m[n]!;
      if (v === 'err') throw new OSError('x');
      return v;
    });
    expect(out).toEqual(['c', 'a', 'b', '～', '\u{1F600}', 'e', 'd']);
    expect(await newest(['a', 'b', 'c'], 2, async () => 1n)).toEqual(['a', 'b']);
    expect(await newest(['a'], 0, async () => 1n)).toEqual([]);
  });
  test('only OSError is tolerated', async () => {
    await expect(
      newest(['a'], 1, async () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
  });
});

describe('receiptValidation', () => {
  function world(
    files: Record<string, Uint8Array | 'unreadable'>,
    mt: Record<string, bigint> = {},
  ): ReceiptValidationEffects {
    return {
      stateDir: () => '/state',
      isDir: async (p) => p === '/state/receipts',
      listNames: async () => ['notes.txt', ...Object.keys(files)],
      mtimeNs: async (p) => mt[p.split('/').pop()!] ?? 0n,
      readReceipt: async (p) => {
        const v = files[p.split('/').pop()!];
        if (v === undefined || v === 'unreadable') throw new OSError('denied '.repeat(20));
        return v;
      },
      deploymentConstants: async () =>
        constants({
          policy: 'affected-current-additions-v1',
          version: 1,
          selectors: ['merge-queue'],
        }),
      readFile: async () => bytes(localDoc),
    };
  }
  test('null without a receipts directory', async () => {
    const e = world({});
    expect(await receiptValidation({ ...e, isDir: async () => false })).toBeNull();
  });
  test('nothing sampled is null, not valid', async () => {
    const r = await receiptValidation(world({}));
    expect(r).toMatchObject({ sampled: 0, valid_count: 0, invalid: [], valid: null, families: {} });
  });
  test('classifies valid, invalid, malformed and unreadable receipts', async () => {
    const good = named(merged());
    const bad = named(merged({ version: 9 }));
    const junk = new TextEncoder().encode('{');
    const junkName = `${sha(junk)}.json`;
    const lost = `${'e'.repeat(64)}.json`;
    const r = (await receiptValidation(
      world({
        [good.name]: good.data,
        [bad.name]: bad.data,
        [junkName]: junk,
        [lost]: 'unreadable',
      }),
    ))!;
    expect(r.sampled).toBe(4);
    expect(r.valid_count).toBe(1);
    expect(r.valid).toBe(false);
    expect(r.families).toEqual({ 'merged-current': 2, malformed: 1, unreadable: 1 });
    const byName = Object.fromEntries(r.invalid.map((i) => [i.receipt, i]));
    expect(byName[bad.name.slice(0, -5)]).toEqual({
      receipt: bad.name.slice(0, -5),
      family: 'merged-current',
      reason: 'unsupported receipt version',
    });
    expect(byName[junkName.slice(0, -5)]?.family).toBe('malformed');
    expect(byName[lost.slice(0, -5)]).toMatchObject({
      family: 'unreadable',
      reason: `unreadable: ${'denied '.repeat(20).slice(0, 80)}`,
    });
    expect(r.schema_source).toBe('deployment:apps/crq-python/review_receipt.py');
    expect(r.local_review_schema_source).toBe('deployment:policy/review-operation.schema.json');
  });
  test('all valid is true', async () => {
    const good = named(merged());
    expect((await receiptValidation(world({ [good.name]: good.data })))?.valid).toBe(true);
  });
  test('samples only the ten newest well-named receipts', async () => {
    const files: Record<string, Uint8Array> = {};
    const mt: Record<string, bigint> = {};
    for (let i = 0; i < 12; i++) {
      const g = named(merged({ item_id: `i${String(i)}` }));
      files[g.name] = g.data;
      mt[g.name] = BigInt(i);
    }
    files['short.json'] = new Uint8Array();
    const r = (await receiptValidation(world(files, mt)))!;
    expect(r.sampled).toBe(10);
    expect(r.valid).toBe(true);
  });
  test('non-OSError escapes', async () => {
    const e = world({ [`${'a'.repeat(64)}.json`]: new Uint8Array() });
    await expect(
      receiptValidation({
        ...e,
        readReceipt: async () => {
          throw new Error('bug');
        },
      }),
    ).rejects.toThrow('bug');
  });
});
