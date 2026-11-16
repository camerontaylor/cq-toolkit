/**
 * Host overlay validation and application, ported from
 * `apps/crq-python/ops/prepare-host.py`: `CONFIG_KEYS`, `host_path`,
 * `outside`, `leaves`, `validate`, `apply`, `changed_fields`, `drift_check`,
 * `encode`, `digest` and `render`.
 *
 * Inactive and unimported. The overlay and the committed config are parsed
 * `JsonValue`s (int/float/bool distinctions matter to `type(x) is int`); the
 * only filesystem fact validation needs, `Path.resolve()`, is an injected
 * synchronous seam; reads are async seams.
 */
import { createHash } from 'node:crypto';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../../policy/crq/ledger.js';
import { pythonJsonText } from '../../../policy/crq/pythonJson.js';
import { ValueError, PythonError } from './errors.js';
export { ValueError, PythonError };

export const CONFIG = 'apps/crq-python/config.json';

/** A closed leaf allowlist, NOT arbitrary recursive config.update(). */
export const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'clone',
  'worktree_root',
  'timeout_bin',
  'paseo_hosts',
  'repos',
  'notify.hosts',
  'alerts.alert_agent_host',
  'alerts.alert_agent_id',
  'promotion.record_url_template',
  'promotion.alert_agent_host',
  'promotion.alert_agent_id',
  'promotion.signer.spool.dir',
  'promotion.signer.spool.ssh_alias',
  'promotion.signer.spool.ssh_key',
  'repair.enabled',
  'repair.cq_bin',
  'repair.paseo_host',
  'repair.blackout.enabled',
  'repair.max_concurrent_items',
]);
/** Allowlisted but optional: absent means the committed value applies. */
export const OPTIONAL_KEYS: ReadonlySet<string> = new Set([
  'repos',
  'notify.hosts',
  'alerts.alert_agent_id',
  'promotion.record_url_template',
  'promotion.alert_agent_id',
  'promotion.signer.spool.dir',
  'promotion.signer.spool.ssh_alias',
  'promotion.signer.spool.ssh_key',
  'repair.blackout.enabled',
  'repair.max_concurrent_items',
]);
export const HOST_KEYS: ReadonlySet<string> = new Set([
  'schema_version',
  'deploy_root',
  'record_dir',
  'config',
  'fleet_reader',
]);
export const PATH_KEYS: ReadonlySet<string> = new Set([
  'clone',
  'worktree_root',
  'timeout_bin',
  'repair.cq_bin',
  'promotion.signer.spool.dir',
  'promotion.signer.spool.ssh_key',
]);

/** `Path.resolve()`: a synchronous seam, because it follows symlinks. */
export type Resolve = (path: string) => string;

const isStr = (v: unknown): v is string => typeof v === 'string';
const fullmatch = (pattern: string, value: string): boolean =>
  new RegExp(`^(?:${pattern})$`, 'su').test(value);

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, (c) => c.codePointAt(0) ?? 0);
  const b = Array.from(right, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Python truthiness of a JSON value. */
export function truthy(v: JsonValue | undefined): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'string') return v !== '';
  if (v instanceof JsonNumber) return v.kind === 'int' ? v.integer !== 0n : v.float !== 0;
  if (Array.isArray(v)) return v.length > 0;
  return v.entries.length > 0;
}

/** `pathlib` lexical normalisation of an absolute POSIX path. */
function normalize(path: string): string {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  return `/${parts.join('/')}`;
}

/** Python `not path.resolve().is_relative_to(root.resolve())`. */
export function outside(path: string, root: string, resolve: Resolve): boolean {
  const a = normalize(resolve(path));
  const b = normalize(resolve(root));
  const inside = b === '/' || a === b || a.startsWith(`${b}/`);
  return !inside;
}

/** No systemd specifiers, whitespace, shell syntax or traversal in unit paths. */
export function hostPath(value: unknown): string {
  if (!isStr(value) || !fullmatch('/[A-Za-z0-9_./-]+', value))
    throw new ValueError('host paths must be absolute, without whitespace or specifiers');
  if (value.split('/').includes('..')) throw new ValueError('parent traversal is not a host path');
  return normalize(value);
}

/** Python `leaves`: the allowlisted leaves of an overlay config, in order. */
export function leaves(value: JsonValue, prefix = ''): [string, JsonValue][] {
  if (!(value instanceof JsonObject) || value.entries.length === 0)
    throw new ValueError('overlay config must contain only allowlisted leaves');
  const out: [string, JsonValue][] = [];
  for (const [key, item] of value.entries) {
    const name = prefix + key;
    if (CONFIG_KEYS.has(name)) out.push([name, item]);
    else if (item instanceof JsonObject && item.entries.length > 0)
      out.push(...leaves(item, `${name}.`));
    else throw new ValueError(`overlay key refused: ${name}`);
  }
  return out;
}

const dictOf = (entries: [string, JsonValue][]): Map<string, JsonValue> => new Map(entries);
const isInt = (v: JsonValue | undefined): v is JsonNumber =>
  v instanceof JsonNumber && v.kind === 'int';
const nonEmptyStr = (v: JsonValue): v is string => isStr(v) && v !== '';

/**
 * Whether Python `template.format(item='record-validation')` succeeds.
 * Fail-closed subset: fields are `{item}` with an optional `!r|!s|!a`
 * conversion and a flat str format spec; escapes `{{`/`}}` are literal.
 * Attribute/index access, positional fields and nested spec fields, some of
 * which Python accepts, are treated as invalid.
 */
export function formatsWithItem(template: string): boolean {
  let i = 0;
  while (i < template.length) {
    const ch = template[i] as string;
    if (ch === '}') {
      if (template[i + 1] !== '}') return false;
      i += 2;
    } else if (ch === '{') {
      if (template[i + 1] === '{') {
        i += 2;
        continue;
      }
      const end = template.indexOf('}', i + 1);
      if (end < 0) return false;
      const field = template.slice(i + 1, end);
      if (field.includes('{')) return false;
      const m = /^([^!:]*)(?:!([^:]))?(?::(.*))?$/su.exec(field);
      if (!m || m[1] !== 'item') return false;
      if (m[2] !== undefined && !'rsa'.includes(m[2])) return false;
      if (m[3] !== undefined && !/^(?:.?[<>^])?0?[0-9]*(?:\.[0-9]+)?s?$/su.test(m[3])) return false;
      i = end + 1;
    } else i += 1;
  }
  return true;
}

function checkLeaf(name: string, value: JsonValue, deploy: string, resolve: Resolve): void {
  if (name === 'repair.blackout.enabled' || name === 'repair.enabled') {
    if (typeof value !== 'boolean') throw new ValueError(`${name} must be JSON true or false`);
  } else if (name === 'repair.max_concurrent_items') {
    if (!isInt(value) || !(value.integer! >= 1n && value.integer! <= 10n))
      throw new ValueError('repair.max_concurrent_items must be an integer from 1 to 10');
  } else if (name === 'paseo_hosts') {
    if (!Array.isArray(value) || !value.every(nonEmptyStr) || new Set(value).size < 2)
      throw new ValueError(
        'paseo_hosts must contain at least two distinct nonempty endpoint strings',
      );
  } else if (name === 'notify.hosts') {
    if (
      !Array.isArray(value) ||
      value.length > 32 ||
      !value.every((v) => {
        if (!isStr(v) || Array.from(v).length > 259) return false;
        if (!fullmatch('[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?:[0-9]{1,5}', v))
          return false;
        const port = Number(v.slice(v.lastIndexOf(':') + 1));
        return port >= 1 && port <= 65535;
      })
    )
      throw new ValueError('notify.hosts must be at most 32 host:port strings with ports 1..65535');
  } else if (name === 'repos') {
    if (!Array.isArray(value)) throw new ValueError('repos must be a list');
    const seen = new Set<string>();
    for (const entry of value) {
      if (!(entry instanceof JsonObject)) throw new ValueError('repos entries must be objects');
      const repo = entry.get('repo');
      if (!isStr(repo) || !fullmatch('[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo))
        throw new ValueError('repos entries need an owner/name repo');
      if (seen.has(repo)) throw new ValueError('repos entries must be unique');
      seen.add(repo);
      const clone = entry.get('clone');
      if (clone !== undefined && clone !== null) {
        const clonePath = hostPath(clone);
        if (!outside(clonePath, deploy, resolve) || !outside(deploy, clonePath, resolve))
          throw new ValueError('repos clone must be separate from deployment clone');
      }
    }
  } else if (PATH_KEYS.has(name)) {
    // The accepted legacy renderer records a literal ~/ key path.
    hostPath(
      name === 'promotion.signer.spool.ssh_key' && isStr(value) && value.startsWith('~/')
        ? value.slice(1)
        : value,
    );
  } else if (name === 'alerts.alert_agent_id' || name === 'promotion.alert_agent_id') {
    if (
      !isStr(value) ||
      !fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value)
    )
      throw new ValueError('alert_agent_id must be a lowercase Paseo agent UUID');
  } else if (name === 'promotion.signer.spool.ssh_alias') {
    if (
      !isStr(value) ||
      !fullmatch('[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.:-]*', value)
    )
      throw new ValueError('spool ssh_alias must be a literal user@host');
  } else if (!nonEmptyStr(value) || /[\n\r\0]/.test(value)) {
    throw new ValueError('overlay host values must be nonempty strings');
  }
}

/** Python `validate`: returns the overlay unchanged or throws `ValueError`. */
export function validate(overlay: JsonValue, resolve: Resolve): JsonObject {
  if (
    !(overlay instanceof JsonObject) ||
    overlay.entries.length !== HOST_KEYS.size ||
    !overlay.entries.every(([key]) => HOST_KEYS.has(key))
  )
    throw new ValueError('overlay top-level keys must match the fixed schema');
  const version = overlay.get('schema_version');
  if (!isInt(version) || version.integer !== 1n)
    throw new ValueError('unsupported overlay schema_version');
  const deploy = hostPath(overlay.get('deploy_root'));
  const records = hostPath(overlay.get('record_dir'));
  if (!outside(records, deploy, resolve))
    throw new ValueError('deploy records must be outside the checkout');
  const config = overlay.get('config') as JsonValue;
  for (const [name, value] of leaves(config)) checkLeaf(name, value, deploy, resolve);
  // Paths/endpoints needed by the model-free runner must be explicit.
  const supplied = dictOf(leaves(config));
  const required = [...CONFIG_KEYS].filter(
    (k) =>
      !OPTIONAL_KEYS.has(k) &&
      k !== 'alerts.alert_agent_host' &&
      k !== 'promotion.alert_agent_host',
  );
  const missing = required.filter((k) => !supplied.has(k)).sort(codePointCompare);
  if (missing.length) throw new ValueError(`missing host config keys: ${missing.join(', ')}`);
  if (!supplied.has('alerts.alert_agent_host') && !supplied.has('promotion.alert_agent_host'))
    throw new ValueError('missing host config keys: alerts.alert_agent_host');
  const template = supplied.get('promotion.record_url_template');
  if (template !== undefined && !(isStr(template) && formatsWithItem(template)))
    throw new ValueError('invalid promotion record URL template');
  for (const name of ['clone', 'worktree_root']) {
    const path = normalize(supplied.get(name) as string);
    if (!outside(path, deploy, resolve) || !outside(deploy, path, resolve))
      throw new ValueError('review clone/worktrees must be separate from deployment clone');
  }
  const fleet = overlay.get('fleet_reader');
  if (
    !(fleet instanceof JsonObject) ||
    fleet.entries.length !== 2 ||
    !fleet.has('ssh_host') ||
    !fleet.has('source')
  )
    throw new ValueError('fleet_reader accepts only ssh_host and source');
  const sshHost = fleet.get('ssh_host');
  if (!isStr(sshHost) || !fullmatch('[A-Za-z0-9][A-Za-z0-9_.@-]*', sshHost))
    throw new ValueError('invalid fleet-reader ssh host');
  hostPath(fleet.get('source'));
  return overlay;
}

/** `config.set(parts, value)` on an immutable tree, replacing in place or appending. */
export function withKey(obj: JsonObject, key: string, value: JsonValue): JsonObject {
  const found = obj.has(key);
  const entries = obj.entries.map(([k, v]): [string, JsonValue] =>
    k === key ? [k, value] : [k, v],
  );
  if (!found) entries.push([key, value]);
  return new JsonObject(entries);
}

function setPath(root: JsonObject, parts: readonly string[], value: JsonValue): JsonObject {
  const rec = (node: JsonObject, i: number, parent: string): JsonObject => {
    const part = parts[i] as string;
    if (i === parts.length - 1) return withKey(node, part, value);
    const here = parent ? `${parent}.${part}` : part;
    // The committed config owns the shape: a missing block is refused, never created.
    const child = node.get(part);
    if (!(child instanceof JsonObject))
      throw new ValueError(`overlay parent missing from committed config: ${here}`);
    return withKey(node, part, rec(child, i + 1, here));
  };
  return rec(root, 0, '');
}

/** Python `apply`: the committed config with the overlay's leaves applied. */
export function apply(configValue: JsonValue, overlay: JsonObject): JsonObject {
  if (!(configValue instanceof JsonObject))
    throw new PythonError('AttributeError', "object has no attribute 'get'");
  let config = configValue;
  const renamed = config.get('alerts') instanceof JsonObject;
  // Transitional promotion leaves first, so the current alerts keys win.
  const entries = leaves(overlay.get('config') as JsonValue).sort(
    (a, b) => Number(!a[0].startsWith('promotion.')) - Number(!b[0].startsWith('promotion.')),
  );
  for (const [name, value] of entries) {
    let parts = name.split('.');
    if (renamed && parts[0] === 'promotion') {
      // A new-shape config has no promotion consumer: keep the alert recipient, ignore the rest.
      if (parts.length === 2 && (parts[1] === 'alert_agent_id' || parts[1] === 'alert_agent_host'))
        config = withKey(
          config,
          'alerts',
          withKey(config.get('alerts') as JsonObject, parts[1], value),
        );
      continue;
    }
    // Phase 0.1 renamed the alert leaves; a pre-rename target still reads them from promotion.
    if (parts[0] === 'alerts' && !renamed) parts = ['promotion', parts[1] as string];
    config = setPath(config, parts, value);
  }
  // Spend authorization is policy, not an overlay escape hatch.
  const repair = config.get('repair');
  if (repair === undefined) throw new PythonError('KeyError', "'repair'");
  if (!(repair instanceof JsonObject)) throw new PythonError('TypeError', 'repair is not a dict');
  const enabled = repair.get('enabled');
  if (enabled === undefined) throw new PythonError('KeyError', "'enabled'");
  if (enabled === true && !truthy(repair.get('spend_authorization')))
    throw new ValueError('repair enabled without committed spend authorization');
  return config;
}

/** Python `changed_fields`: field names, never private values. */
export function changedFields(left: JsonValue, right: JsonValue, prefix = ''): string[] {
  if (left instanceof JsonObject && right instanceof JsonObject) {
    const keys = [...new Set([...left.entries, ...right.entries].map(([k]) => k))].sort(
      codePointCompare,
    );
    const result: string[] = [];
    for (const key of keys) {
      const name = prefix + key;
      const l = left.get(key);
      const r = right.get(key);
      if (l === undefined || r === undefined) result.push(name);
      else result.push(...changedFields(l, r, `${name}.`));
    }
    return result;
  }
  return ledgerValueEqual(left, right) ? [] : [prefix.replace(/\.+$/, '') || '<serialization>'];
}

function loadBytes(data: Uint8Array): JsonValue | undefined {
  try {
    return parseJsonValue(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data),
      {
        parseConstant: () => null,
      },
    );
  } catch {
    return undefined;
  }
}

/** Python `drift_check`: refuse when the live config bytes differ from the candidate. */
export async function driftCheck(
  expected: Uint8Array,
  readLive: () => Promise<Uint8Array>,
): Promise<void> {
  const actual = await readLive();
  if (Buffer.compare(Buffer.from(expected), Buffer.from(actual)) === 0) return;
  const candidate = loadBytes(expected);
  const live = loadBytes(actual);
  const names =
    candidate === undefined || live === undefined
      ? ['<invalid JSON>']
      : changedFields(candidate, live);
  throw new ValueError(
    `config drift; refusing switch: ${(names.length ? names : ['<serialization>']).join(', ')}`,
  );
}

/** Same config serialisation as `crq_repair.atomic`: indent 2, ASCII, insertion order, newline. */
export function encode(value: JsonValue): Uint8Array {
  return Buffer.from(
    pythonJsonText(value, { asciiOnly: true, sortKeys: false, indent: 2, trailingNewline: true }),
    'utf8',
  );
}

export function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface RenderEffects {
  /** `git show <sha>:<path>` text; throws when git fails. */
  gitShow(sha: string, path: string): Promise<string>;
}

/** Python `render`: the committed config with the overlay applied, as bytes. */
export async function render(
  effects: RenderEffects,
  overlay: JsonObject,
  sha = 'HEAD',
): Promise<Uint8Array> {
  const committed = parseJsonValue(await effects.gitShow(sha, CONFIG), {
    parseConstant: () => null,
  });
  return encode(apply(committed, overlay));
}
