/**
 * Read-only validation of the retained review receipts the health observation
 * samples, over injected filesystem seams.
 *
 * Ports `_newest`, `receipt_schema`, `local_review_schema`, `schema_problem`,
 * `receipt_family`, `local_review_problem`, `receipt_problem` and
 * `receipt_validation` from `apps/crq-python/ops/deploy-controller.py`.
 * Inactive and unimported: nothing here reads a file; the caller supplies
 * every read, including the one that statically resolves the deployment's
 * review_receipt.py constants (a Python `ast` walk, left to the real effects).
 */
import { createHash } from 'node:crypto';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../../policy/crq/ledger.js';
import { receiptJsonBytes, receiptJsonDigest } from '../../../policy/crq/pythonJson.js';
import { OSError, PythonError } from './errors.js';
export { OSError, PythonError };

export const RECEIPT_SAMPLE = 10;
export const RECEIPT_POLICY = 'affected-current-additions-v1';
export const RECEIPT_TARGETS: readonly string[] = ['promoted-main', 'merge-queue'];
export const RECEIPT_VERSION = 1;
export const RECEIPT_COUNTED_OUTCOMES: readonly string[] = [
  'terminal-clean',
  'terminal-with-findings',
  'partial-scope',
];
export const RECEIPT_RESOLUTIONS: readonly string[] = ['same-path-current', 'git-rename-M50'];
export const RECEIPT_DISPOSITIONS: readonly string[] = [
  'included',
  'renamed',
  'deleted',
  'unsupported',
  'ambiguous',
  'excluded-with-reason',
];
export const FAMILY_MERGED = 'merged-current';
export const FAMILY_PUSH = 'push-range';
export const FAMILY_LOCAL = 'local-review-full-diff';
export const PUSH_DISPOSITIONS: readonly string[] = [
  ...RECEIPT_DISPOSITIONS,
  'excluded-config',
  'deferred-split',
];
export const LOCAL_REVIEW_SCHEMA = 'policy/review-operation.schema.json';

const RECEIPT_NAME_RE = /^[0-9a-f]{64}\.json$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^(?:[0-9a-f-]{8,64}|[A-Za-z0-9][A-Za-z0-9._+-]*-[0-9]{8}T[0-9]{6}Z)$/;
// Python `\w` is Unicode-aware for str patterns.
const REPO_RE = /^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u;

/** The deployment's receipt constants plus where they came from. */
export interface ReceiptSchema {
  readonly schema_source: string;
  readonly policy: string;
  readonly version: number;
  readonly targets: readonly string[];
  /** The deployment's local-review receipt rule; null when unavailable. */
  readonly local_review: JsonObject | null;
  readonly local_review_source: string;
}

/** What the deployment's `review_receipt.py` yields when read statically. */
export interface DeploymentConstants {
  readonly policy: unknown;
  readonly version: unknown;
  /** The keys of the `SELECTORS` dict literal. */
  readonly selectors: unknown;
}

export interface ReceiptSchemaEffects {
  /**
   * Statically resolve `POLICY`, `VERSION` and `SELECTORS` from the
   * deployment's `review_receipt.py` (never executing it). Throws when they
   * cannot be resolved.
   */
  deploymentConstants(): Promise<DeploymentConstants>;
  /** Read a file under the checkout root as bytes; throws `OSError`. */
  readFile(relpath: string): Promise<Uint8Array>;
}

export interface ReceiptValidationEffects extends ReceiptSchemaEffects {
  stateDir(): string;
  isDir(path: string): Promise<boolean>;
  /** Names of a directory's entries (`Path.iterdir()`); throws `OSError`. */
  listNames(path: string): Promise<readonly string[]>;
  /** `Path.stat().st_mtime_ns`; throws `OSError` when unstattable. */
  mtimeNs(path: string): Promise<bigint>;
  /** `Path.read_bytes()`; throws `OSError`. */
  readReceipt(path: string): Promise<Uint8Array>;
}

// ---- small Python helpers --------------------------------------------------

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, (c) => c.codePointAt(0) ?? 0);
  const b = Array.from(right, (c) => c.codePointAt(0) ?? 0);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
const head = (text: string, n: number): string => Array.from(text).slice(0, n).join('');
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nameOf = (e: unknown): string => (e instanceof Error ? e.name : 'Error');

const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is JsonNumber => v instanceof JsonNumber && v.kind === 'int';
/** `doc.get(key)`: None when absent. */
const field = (doc: JsonObject, key: string): JsonValue => doc.get(key) ?? null;
const text = (v: unknown): v is string => isStr(v) && v !== '';
const hex = (pattern: RegExp, v: unknown): boolean => isStr(v) && pattern.test(v);

/** Python truthiness of a JSON value. */
function truthy(v: JsonValue): boolean {
  if (v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'string') return v !== '';
  if (v instanceof JsonNumber) return v.kind === 'int' ? v.integer !== 0n : v.float !== 0;
  if (Array.isArray(v)) return v.length > 0;
  return v.entries.length > 0;
}

/** A Python number comparison operand: `int`, `float` or `bool`. */
function operand(v: JsonValue | undefined): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof JsonNumber) return v.kind === 'int' ? Number(v.integer) : (v.float as number);
  throw new PythonError('TypeError', "'<' not supported between instances");
}

/** Python `json.loads(bytes)`; `null` for a `ValueError`. UTF-8 only (BOM tolerated). */
function loadBytes(data: Uint8Array): JsonValue | typeof INVALID {
  try {
    // A UTF-8 BOM is accepted for bytes input (`utf-8-sig`), unlike for str input.
    const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
    return parseJsonValue(body, { parseConstant: () => null });
  } catch {
    return INVALID;
  }
}
const INVALID = Symbol('invalid-json');

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---- _newest ----------------------------------------------------------------

/** Python `_newest`: the `limit` most recently modified entries, ties by name. */
export async function newest(
  names: readonly string[],
  limit: number,
  mtimeNs: (name: string) => Promise<bigint>,
): Promise<string[]> {
  const keyed: { name: string; mtime: bigint }[] = [];
  for (const name of names) {
    let mtime: bigint;
    try {
      mtime = await mtimeNs(name);
    } catch (error) {
      if (!(error instanceof OSError)) throw error;
      mtime = -1n;
    }
    keyed.push({ name, mtime });
  }
  keyed.sort((a, b) =>
    a.mtime === b.mtime ? codePointCompare(a.name, b.name) : a.mtime > b.mtime ? -1 : 1,
  );
  return keyed.slice(0, Math.max(0, limit)).map((k) => k.name);
}

// ---- schemas ------------------------------------------------------------------

/**
 * Python `local_review_schema`: the deployment's local-review receipt rule,
 * read as JSON data. There is no builtin copy.
 */
export async function localReviewSchema(
  effects: Pick<ReceiptSchemaEffects, 'readFile'>,
): Promise<{ local_review: JsonObject | null; local_review_source: string }> {
  try {
    const bytes = await effects.readFile(LOCAL_REVIEW_SCHEMA);
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw new PythonError('UnicodeDecodeError', messageOf(error));
    }
    let document: JsonValue;
    try {
      document = parseJsonValue(body, { parseConstant: () => null });
    } catch (error) {
      throw new PythonError('JSONDecodeError', messageOf(error));
    }
    const rules: JsonValue[] = [];
    const variants = subscript(document, 'oneOf');
    if (!Array.isArray(variants)) throw new PythonError('TypeError', 'oneOf is not a list');
    for (const variant of variants) {
      const properties = subscript(variant, 'properties');
      if (subscript(properties, 'type') instanceof JsonObject) {
        const type = subscript(properties, 'type') as JsonObject;
        const value = subscript(properties, 'value');
        if (type.get('const') === 'receipt') rules.push(value);
      } else {
        throw new PythonError('AttributeError', "object has no attribute 'get'");
      }
    }
    const [rule] = rules;
    if (rules.length !== 1 || !(rule instanceof JsonObject))
      throw new PythonError('ValueError', 'expected exactly one receipt variant');
    return { local_review: rule, local_review_source: `deployment:${LOCAL_REVIEW_SCHEMA}` };
  } catch (error) {
    if (error instanceof OSError || error instanceof PythonError)
      return {
        local_review: null,
        local_review_source: `unavailable: ${error.name}: ${head(error.message, 80)}`,
      };
    throw error;
  }
}

/** Python `x[key]` on a JSON value: `KeyError` / `TypeError` as Python raises them. */
function subscript(value: JsonValue | undefined, key: string): JsonValue {
  if (!(value instanceof JsonObject))
    throw new PythonError('TypeError', 'indices must be integers');
  const found = value.get(key);
  if (found === undefined) throw new PythonError('KeyError', `'${key}'`);
  return found;
}

/**
 * Python `receipt_schema`: policy/version/targets from this deployment's
 * `review_receipt.py`, falling back to the builtin copy with the reason in
 * `schema_source`; plus the local-review rule.
 */
export async function receiptSchema(effects: ReceiptSchemaEffects): Promise<ReceiptSchema> {
  let base: Pick<ReceiptSchema, 'schema_source' | 'policy' | 'version' | 'targets'>;
  try {
    const c = await effects.deploymentConstants();
    if (!Array.isArray(c.selectors))
      throw new PythonError('ValueError', 'review_receipt.SELECTORS is not a dict literal');
    const targets = c.selectors as unknown[];
    if (
      !isStr(c.policy) ||
      typeof c.version !== 'number' ||
      !Number.isInteger(c.version) ||
      targets.length === 0 ||
      !targets.every(isStr)
    )
      throw new PythonError('ValueError', 'unexpected constant types');
    base = {
      schema_source: 'deployment:apps/crq-python/review_receipt.py',
      policy: c.policy,
      version: c.version,
      targets: targets as string[],
    };
  } catch (error) {
    base = {
      schema_source: `builtin (deployment constants unavailable: ${nameOf(error)}: ${head(messageOf(error), 80)})`,
      policy: RECEIPT_POLICY,
      version: RECEIPT_VERSION,
      targets: RECEIPT_TARGETS,
    };
  }
  return { ...base, ...(await localReviewSchema(effects)) };
}

// ---- schema_problem -------------------------------------------------------------

const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  'oneOf',
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'minLength',
  'pattern',
]);

type Kind = 'object' | 'array' | 'string' | 'integer' | 'boolean' | 'null';
const SCHEMA_TYPES: ReadonlySet<string> = new Set([
  'object',
  'array',
  'string',
  'integer',
  'boolean',
  'null',
]);

/** Python `type(value)` as the schema vocabulary names it; a float has no name. */
function kindOf(value: JsonValue): Kind | 'float' {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (value instanceof JsonNumber) return value.kind === 'int' ? 'integer' : 'float';
  return Array.isArray(value) ? 'array' : 'object';
}

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return new RegExp(`^(?:${pattern})$`);
  }
}

/**
 * Python `schema_problem`: the checked-in schema vocabulary, failing closed on
 * any other keyword, returning the first violation with its location.
 */
export function schemaProblem(value: JsonValue, rule: JsonValue, at = ''): string | null {
  const where = at || 'receipt';
  if (!(rule instanceof JsonObject))
    throw new PythonError('TypeError', 'schema rule is not a dict');
  if (rule.entries.some(([key]) => !SCHEMA_KEYWORDS.has(key)))
    return `${where}: unsupported schema keyword`;
  const oneOf = rule.get('oneOf');
  if (oneOf !== undefined) {
    if (!Array.isArray(oneOf)) throw new PythonError('TypeError', 'oneOf is not a list');
    const matches = oneOf.filter((branch) => schemaProblem(value, branch, at) === null).length;
    return matches === 1 ? null : `${where}: does not match exactly one variant`;
  }
  const expected = rule.get('type');
  if (
    expected !== undefined &&
    !(
      expected === null ||
      expected === false ||
      expected === '' ||
      (Array.isArray(expected) && expected.length === 0)
    )
  ) {
    const names = Array.isArray(expected) ? expected : [expected];
    const allowed = names.map((name) => {
      if (!isStr(name) || !SCHEMA_TYPES.has(name))
        throw new PythonError('KeyError', JSON.stringify(name));
      return name;
    });
    if (!allowed.includes(kindOf(value))) return `${where}: type mismatch`;
  }
  const constant = rule.get('const');
  const enumeration = rule.get('enum');
  if (
    (constant !== undefined && !ledgerValueEqual(value, constant)) ||
    (enumeration !== undefined && !enumContains(enumeration, value))
  )
    return `${where}: value mismatch`;
  if (value instanceof JsonObject) {
    const required = rule.get('required') ?? [];
    if (!Array.isArray(required) || !required.every(isStr))
      throw new PythonError('TypeError', 'required is not a list of strings');
    const missing = [...new Set(required as string[])]
      .filter((key) => !value.has(key))
      .sort(codePointCompare);
    if (missing.length) return `${where}: missing ${missing.join(',')}`;
    const properties = rule.get('properties') ?? new JsonObject([]);
    if (!(properties instanceof JsonObject))
      throw new PythonError('TypeError', 'properties is not a dict');
    const unknown = value.entries
      .map(([key]) => key)
      .filter((key) => !properties.has(key))
      .sort(codePointCompare);
    if (rule.get('additionalProperties') === false && unknown.length)
      return `${where}: unknown ${unknown.join(',')}`;
    const shared = value.entries
      .map(([key]) => key)
      .filter((key) => properties.has(key))
      .sort(codePointCompare);
    for (const key of shared) {
      const problem = schemaProblem(
        value.get(key) as JsonValue,
        properties.get(key) as JsonValue,
        `${at ? `${at}.` : ''}${key}`,
      );
      if (problem) return problem;
    }
  }
  if (Array.isArray(value)) {
    const max = rule.has('maxItems') ? operand(rule.get('maxItems')) : value.length;
    const min = rule.has('minItems') ? operand(rule.get('minItems')) : 0;
    if (value.length < min || value.length > max) return `${where}: array bound`;
    const items = rule.get('items') ?? new JsonObject([]);
    for (const [index, item] of value.entries()) {
      const problem = schemaProblem(item, items, `${where}[${String(index)}]`);
      if (problem) return problem;
    }
  }
  if (typeof value === 'string') {
    const minLength = rule.has('minLength') ? operand(rule.get('minLength')) : 0;
    const pattern = rule.get('pattern');
    if (
      Array.from(value).length < minLength ||
      (pattern !== undefined && !(isStr(pattern) && compilePattern(pattern).test(value)))
    )
      return `${where}: string bound`;
  }
  if (isInt(value) && rule.has('minimum') && operand(value) < operand(rule.get('minimum')))
    return `${where}: below minimum`;
  return null;
}

/** Python `value in rule["enum"]` for the list form the vocabulary uses. */
function enumContains(enumeration: JsonValue, value: JsonValue): boolean {
  if (!Array.isArray(enumeration))
    throw new PythonError('TypeError', 'argument of type is not iterable');
  return enumeration.some((candidate) => ledgerValueEqual(value, candidate));
}

// ---- receipts -------------------------------------------------------------------

/** Python `receipt_family`: which writer produced a parsed receipt (never a verdict). */
export function receiptFamily(doc: JsonObject): string {
  if (doc.has('kind') || doc.has('v')) {
    const kind = doc.get('kind');
    return isStr(kind) && kind !== '' ? kind : 'unknown';
  }
  const source = doc.get('source');
  if (source instanceof JsonObject && source.get('type') === FAMILY_PUSH) return FAMILY_PUSH;
  return FAMILY_MERGED;
}

/** `review_receipt.digest`: sha256 of the canonical JSON encoding. */
function canonicalDigest(value: JsonValue): string {
  return receiptJsonDigest(value);
}

/** Python `local_review_problem`. */
export function localReviewProblem(doc: JsonObject, rule: JsonObject | null): string | null {
  if (rule === null) return 'local-review: unverified, deployment receipt schema unavailable';
  const problem = schemaProblem(doc, rule);
  if (problem) return `local-review schema: ${problem}`;
  if (subscript(doc, 'identity') !== canonicalDigest(subscript(doc, 'identity_inputs')))
    return 'local-review identity: identity is not the digest of identity_inputs';
  const adequate = truthy(subscript(doc, 'scope_adequate'));
  const outcome = subscript(doc, 'outcome');
  if (adequate && outcome !== (truthy(subscript(doc, 'findings')) ? 'findings' : 'clean'))
    return 'local-review outcome: adequate scope with an outcome that contradicts findings';
  if (!adequate && (outcome === 'clean' || outcome === 'findings'))
    return 'local-review outcome: verdict recorded without adequate scope';
  return null;
}

function pushSourceProblem(source: JsonValue, schema: ReceiptSchema): string | null {
  if (
    !(
      source instanceof JsonObject &&
      source.get('type') === FAMILY_PUSH &&
      text(source.get('repo')) &&
      REPO_RE.test(source.get('repo') as string) &&
      hex(HEX40, source.get('base')) &&
      hex(HEX40, source.get('head')) &&
      source.get('policy') === schema.policy
    )
  )
    return 'target: source binding is not a v1 push-range subject';
  const filter = source.get('paths_filter');
  if (
    filter !== undefined &&
    filter !== null &&
    !(Array.isArray(filter) && filter.length > 0 && filter.every(text))
  )
    return 'target: malformed push-range paths_filter';
  if (source.has('pin') && !hex(HEX40, source.get('pin')))
    return 'target: push-range pin is not a 40-hex SHA';
  return null;
}

const BUILTIN_SCHEMA: ReceiptSchema = {
  schema_source: 'builtin',
  policy: RECEIPT_POLICY,
  version: RECEIPT_VERSION,
  targets: RECEIPT_TARGETS,
  local_review: null,
  local_review_source: 'unavailable',
};

/**
 * Python `receipt_problem`: why a retained receipt is not a valid receipt of
 * its family, or `null`. Never grants review credit.
 */
export function receiptProblem(
  name: string,
  data: Uint8Array,
  schema: ReceiptSchema = BUILTIN_SCHEMA,
): string | null {
  if (`${sha256Hex(data)}.json` !== name)
    return 'content identity: sha256 does not match the receipt name';
  const doc = loadBytes(data);
  if (doc === INVALID) return 'malformed: not valid JSON';
  if (!(doc instanceof JsonObject)) return 'malformed: not a JSON object';
  const family = receiptFamily(doc);
  if (family === FAMILY_LOCAL) return localReviewProblem(doc, schema.local_review);
  if (family !== FAMILY_MERGED && family !== FAMILY_PUSH)
    return `unsupported receipt family: ${head(family, 60)}`;
  if (!ledgerValueEqual(field(doc, 'version'), JsonNumber.int(schema.version)))
    return 'unsupported receipt version';
  const runId = field(doc, 'run_id');
  if (!text(field(doc, 'item_id'))) return 'run identity: missing item_id';
  if (runId !== null && !(text(runId) && runId.length <= 255 && RUN_ID_RE.test(runId)))
    return 'run identity: malformed run_id';
  const requestId = field(doc, 'request_id');
  if (!(requestId === null || isStr(requestId))) return 'run identity: malformed request_id';
  const startedAt = field(doc, 'started_at');
  if (!(startedAt === null || isStr(startedAt))) return 'run identity: malformed started_at';
  const source = field(doc, 'source');
  const capture = field(doc, 'capture');
  if (family === FAMILY_PUSH) {
    const problem = pushSourceProblem(source, schema);
    if (problem) return problem;
  } else if (
    !(
      source instanceof JsonObject &&
      text(source.get('repo')) &&
      REPO_RE.test(source.get('repo') as string) &&
      isInt(source.get('pr')) &&
      (source.get('pr') as JsonNumber).integer! > 0n &&
      hex(HEX40, source.get('merge_sha')) &&
      isStr(source.get('target_selector')) &&
      schema.targets.includes(source.get('target_selector') as string) &&
      source.get('policy') === schema.policy
    )
  )
    return 'target: source binding is not a v1 merged-current subject';
  const dispositions = family === FAMILY_PUSH ? PUSH_DISPOSITIONS : RECEIPT_DISPOSITIONS;
  if (
    !(
      capture instanceof JsonObject &&
      hex(HEX40, capture.get('target')) &&
      hex(HEX40, capture.get('tree'))
    )
  )
    return 'target: captured target/tree is not a pinned 40-hex SHA';
  const paths = capture.get('paths');
  if (
    !(
      Array.isArray(paths) &&
      paths.every(
        (entry) =>
          entry instanceof JsonObject &&
          text(entry.get('source_path')) &&
          text(entry.get('path')) &&
          isStr(entry.get('resolution')) &&
          RECEIPT_RESOLUTIONS.includes(entry.get('resolution') as string) &&
          isStr(entry.get('disposition')) &&
          dispositions.includes(entry.get('disposition') as string),
      )
    )
  )
    return 'target: malformed captured path manifest';
  if (capture.get('scope_digest') !== sha256Hex(receiptJsonBytes(paths)))
    return 'target: scope digest does not match the path manifest';
  if (
    !(
      hex(HEX64, capture.get('equivalence')) &&
      capture.get('policy') === schema.policy &&
      capture.get('projection') === 'current-affected-files/full-file-addition-projection' &&
      capture.get('reviewer') === 'coderabbit-review-agent-committed-v1' &&
      text(capture.get('reviewer_version')) &&
      isStr(capture.get('captured_at'))
    )
  )
    return 'target: unsupported capture policy/reviewer';
  const outcome = field(doc, 'outcome');
  const counted = field(doc, 'counted');
  const cls = field(doc, 'classification');
  if (!text(outcome) || outcome === 'pending' || outcome === 'reviewing')
    return 'terminal outcome: missing or non-terminal outcome';
  if (typeof counted !== 'boolean') return 'terminal outcome: counted is not a boolean';
  if (!(cls === null || cls instanceof JsonObject))
    return 'terminal outcome: malformed classification';
  if (
    counted &&
    !(
      RECEIPT_COUNTED_OUTCOMES.includes(outcome) &&
      runId !== null &&
      cls instanceof JsonObject &&
      cls.get('counted') === true &&
      cls.get('outcome') === 'completed'
    )
  )
    return 'terminal outcome: counted without a completed classified run';
  const findings = field(doc, 'findings');
  const artifacts = field(doc, 'artifacts');
  if (
    !(
      Array.isArray(findings) &&
      findings.every((f) => f instanceof JsonObject) &&
      artifacts instanceof JsonObject &&
      artifacts.entries.every(([, v]) => hex(HEX64, v)) &&
      doc.get('remediation') === 'disabled/deferred' &&
      doc.get('independent_acceptance') === false &&
      doc.get('cli_functional_acceptance') === 'pending-D1'
    )
  )
    return 'malformed: findings/artifacts/acceptance fields';
  return null;
}

export interface InvalidReceipt {
  readonly receipt: string;
  readonly family: string;
  readonly reason: string;
}
export interface ReceiptValidation {
  readonly sampled: number;
  readonly valid_count: number;
  readonly invalid: readonly InvalidReceipt[];
  readonly valid: boolean | null;
  readonly families: Readonly<Record<string, number>>;
  readonly schema_source: string;
  readonly local_review_schema_source: string;
}

/**
 * Python `receipt_validation`: validate a bounded sample of retained receipts.
 * `valid` is its own verdict: `null` when nothing was sampled, never a tick
 * failure and never review credit. `null` when there is no receipts directory.
 */
export async function receiptValidation(
  effects: ReceiptValidationEffects,
): Promise<ReceiptValidation | null> {
  const root = `${effects.stateDir()}/receipts`;
  if (!(await effects.isDir(root))) return null;
  const candidates = (await effects.listNames(root)).filter((n) => RECEIPT_NAME_RE.test(n));
  const names = await newest(candidates, RECEIPT_SAMPLE, (n) => effects.mtimeNs(`${root}/${n}`));
  const schema = await receiptSchema(effects);
  const invalid: InvalidReceipt[] = [];
  const families = new Map<string, number>();
  for (const name of names) {
    let family = 'unreadable';
    let problem: string | null;
    try {
      const data = await effects.readReceipt(`${root}/${name}`);
      problem = receiptProblem(name, data, schema);
      const doc = loadBytes(data);
      family = doc === INVALID || !(doc instanceof JsonObject) ? 'malformed' : receiptFamily(doc);
    } catch (error) {
      if (!(error instanceof OSError)) throw error;
      problem = `unreadable: ${head(error.message, 80)}`;
    }
    families.set(family, (families.get(family) ?? 0) + 1);
    if (problem) invalid.push({ receipt: name.slice(0, -5), family, reason: problem });
  }
  return {
    sampled: names.length,
    valid_count: names.length - invalid.length,
    invalid,
    valid: names.length ? invalid.length === 0 : null,
    families: Object.fromEntries(families),
    schema_source: schema.schema_source,
    local_review_schema_source: schema.local_review_source,
  };
}
