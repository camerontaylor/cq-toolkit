import {
  CONFIG_REGISTRY,
  CALL_ONLY_CONFIG,
  FOREIGN_ENV_NAMES,
  PROVIDER_IDS,
  type ConfigKey,
  providerKeysFor,
} from './registry.js';
import { LANE_IDS } from '../driver/served-model.js';
import { isAbsolute, relative, resolve as resolvePath, sep, win32 as pathWin32 } from 'node:path';

export type ConfigProfile = 'conservative' | 'solo-maintainer';
export type ConfigLayer = 'default' | 'profile' | 'env' | 'call';
export type ConfigValue =
  | string
  | number
  | boolean
  | readonly string[]
  | Readonly<Record<string, string>>
  | null;
export interface ResolvedConfigEntry {
  readonly value: ConfigValue;
  readonly layer: ConfigLayer;
  readonly env?: string;
  readonly relaxed: boolean;
  readonly changed: boolean;
}
export interface ResolvedConfig {
  readonly registryVersion: 1;
  readonly profile: ConfigProfile;
  readonly entries: Readonly<Record<string, ResolvedConfigEntry>>;
  readonly secrets: Readonly<Record<string, { readonly layer: 'env'; readonly set: true }>>;
  readonly credentials: Readonly<Record<string, 'set'>>;
  readonly foreign: Readonly<Record<string, string>>;
}
export interface ResolveConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly values?: Readonly<
    Record<string, string | boolean | number | readonly string[] | Readonly<Record<string, string>>>
  >;
  /** Each entry is an exact per-call id, optionally with an authorizing value. */
  readonly optIn?: readonly string[];
  readonly eventName?: string;
  /** Canonical workspace root supplied by the integrating caller. */
  readonly workspaceRootRealpath?: string;
  /** Caller-verified realpaths, keyed by config env name; required for outsideWorkspace paths. */
  readonly verifiedRealpaths?: Readonly<
    Record<string, { readonly input: string; readonly realpath: string }>
  >;
  /** Host platform semantics for environment names and paths; defaults to process.platform. */
  readonly platform?: 'posix' | 'win32';
}

const byId = new Map(CONFIG_REGISTRY.map((key) => [key.id, key]));
const secretSuffixes = [
  '_API_KEY',
  '_TOKEN',
  '_AUTH_TOKEN',
  '_SECRET',
  '_KEY',
  '_PASSWORD',
  '_CREDENTIALS',
  '_URL',
  'PRIVATE_KEY',
];
const deniedPassthrough = new Set([
  'PATH',
  'NODE_OPTIONS',
  'SSH_AUTH_SOCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DATABASE_URL',
]);

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[right.length]!;
}

function closestName(name: string): string | undefined {
  let closest: string | undefined;
  let best = Infinity;
  for (const candidate of CONFIG_REGISTRY.map((key) => key.env).filter((envName) =>
    envName.startsWith('CQ_'),
  )) {
    const score = distance(name, candidate);
    if (score < best) {
      best = score;
      closest = candidate;
    }
  }
  return best <= Math.max(3, Math.floor(name.length / 4)) ? closest : undefined;
}

function nonblank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function isSecret(name: string): boolean {
  return secretSuffixes.some((suffix) => name.endsWith(suffix));
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Caller-owned records are read for own properties only; inherited ones are not configuration. */
function ownEntries<V>(record: Readonly<Record<string, V>>): Record<string, V> {
  // The copy keeps a null prototype: an ordinary object would let a polluted
  // Object.prototype property be read back as configuration on a direct lookup.
  const copy: Record<string, V> = Object.create(null) as Record<string, V>;
  for (const [name, value] of Object.entries(record)) copy[name] = value;
  return copy;
}

function validForeignBaseUrl(value: string): boolean {
  if (!/^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function credentialUrl(raw: string | undefined): boolean {
  // URL consumers commonly trim, and the parser admits special schemes with
  // missing slashes, so screen every scheme-shaped value. A Windows drive
  // path (`C:\cache#v1`) is a filename whose `#` is not a URL fragment.
  const value = raw?.trim();
  if (!value || /^[A-Za-z]:(?:\\|\/(?!\/))/.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value))
    return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  } catch {
    return true;
  }
}

/**
 * Windows environment names are case-insensitive, but a copied process.env
 * snapshot is not. Use this lookup for every resolver environment read.
 */
function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: 'posix' | 'win32',
): string | undefined {
  if (platform !== 'win32') return env[name];
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === upper) return env[key];
  return undefined;
}

/**
 * A Windows root-relative path (`\bin\gh.exe`) is win32-absolute yet resolves
 * against the current drive, so only drive-qualified or full UNC paths count.
 */
function isConfigAbsolute(value: string, platform: 'posix' | 'win32'): boolean {
  if (platform !== 'win32') return isAbsolute(value);
  return pathWin32.isAbsolute(value) && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'));
}

function unsafePassthrough(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: 'posix' | 'win32',
): boolean {
  const upper = name.toUpperCase();
  return (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    // Windows environment names are case-insensitive; compare case-folded everywhere.
    upper.startsWith('CQ_') ||
    deniedPassthrough.has(upper) ||
    upper.startsWith('AWS_') ||
    upper.startsWith('AZURE_') ||
    upper.startsWith('GOOGLE_') ||
    upper.startsWith('GCP_') ||
    isSecret(upper) ||
    credentialUrl(envValue(env, name, platform))
  );
}

const pathVariable = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function expandPath(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  key: ConfigKey,
  platform: 'posix' | 'win32',
): string {
  // `$NAME` and `${NAME}` are separate complete forms; any other `$` or brace
  // syntax (`${A:-b}`, `${A`, `$A}`) is rejected rather than partially expanded.
  if (/[${}]/.test(value.replace(pathVariable, '')))
    throw new Error(`${key.env}: expected an expanded absolute path`);
  const expanded = value.replace(
    pathVariable,
    (_match, braced: string | undefined, bare: string | undefined) => {
      const replacement = nonblank(envValue(env, (braced ?? bare)!, platform));
      if (!replacement || !isAbsolute(replacement))
        throw new Error(`${key.env}: unresolved absolute path variable`);
      return replacement;
    },
  );
  if (expanded.includes('$') || !isAbsolute(expanded))
    throw new Error(`${key.env}: expected an expanded absolute path`);
  return resolvePath(expanded);
}

function assertOutsideWorkspace(
  key: ConfigKey,
  input: string,
  options: ResolveConfigOptions,
): string | undefined {
  if (!key.outsideWorkspace) return undefined;
  const root = options.workspaceRootRealpath;
  const evidence = options.verifiedRealpaths?.[key.env];
  if (
    !root ||
    !isAbsolute(root) ||
    !evidence ||
    evidence.input !== input ||
    !isAbsolute(evidence.realpath)
  )
    throw new Error(`${key.env}: verified workspace path evidence required`);
  const rel = relative(resolvePath(root), resolvePath(evidence.realpath));
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
    throw new Error(`${key.env}: path must resolve outside the workspace`);
  return resolvePath(evidence.realpath);
}

function parseListItems(label: string, raw: unknown): string[] {
  if (typeof raw !== 'string' && !isStringArray(raw))
    throw new Error(`${label}: expected a string or string list`);
  const parts = isStringArray(raw) ? [...raw] : raw.split(',').map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) throw new Error(`${label}: empty list item`);
  if (parts.includes('none') && parts.length !== 1)
    throw new Error(`${label}: 'none' must be the only item`);
  if (parts.includes('none')) return [];
  if (new Set(parts).size !== parts.length) throw new Error(`${label}: duplicate list item`);
  return [...parts].sort();
}

function parse(
  key: ConfigKey,
  raw: string | boolean | number | readonly string[] | Readonly<Record<string, string>> | null,
  platform: 'posix' | 'win32',
): ConfigValue {
  if (raw === null) return null;
  if (key.type === 'list') {
    const unique = parseListItems(key.env, raw);
    if (unique.length === 0) return [];
    if (key.values && unique.some((value) => !key.values?.includes(value)))
      throw new Error(`${key.env}: unsupported list value`);
    if (
      key.id === 'merge.trustedBots' &&
      unique.some((value) => !/^[A-Za-z0-9-]+\[bot\]$/.test(value))
    )
      throw new Error(`${key.env}: expected bot logins ending in [bot]`);
    if (
      key.id === 'merge.trustedBots' &&
      // Login identity is case-insensitive, so compare case-folded.
      unique.some((value) =>
        [
          'github-actions[bot]',
          'cq-verdict[bot]',
          'cq-promoter[bot]',
          'cq-automation[bot]',
        ].includes(value.toLowerCase()),
      )
    )
      throw new Error(`${key.env}: structurally excluded bot identity`);
    if (
      key.id === 'run.envPassthrough' &&
      unique.some((name) => unsafePassthrough(name, {}, platform))
    )
      throw new Error(`${key.env}: policy and secret variables cannot be passed through`);
    if (
      key.id === 'driver.acp.envNames' &&
      unique.some(
        (name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.toUpperCase().startsWith('CQ_'),
      )
    )
      throw new Error(`${key.env}: CQ_* policy variables cannot be passed to ACP`);
    return unique;
  }
  if (key.type === 'map' || key.type === 'bindings') {
    const objectEntries =
      typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw) : undefined;
    if (objectEntries?.some(([, value]) => typeof value !== 'string'))
      throw new Error(`${key.env}: map values must be strings`);
    const entries = isStringArray(raw)
      ? raw
      : objectEntries
        ? objectEntries.map(([k, v]) => `${k}:${v}`)
        : String(raw).split(',');
    const result: Record<string, string> = {};
    for (const entry of entries) {
      const split = String(entry).indexOf(':');
      if (split < 1 || split === String(entry).length - 1)
        throw new Error(`${key.env}: expected key:value entries`);
      const name = String(entry).slice(0, split).trim();
      const value = String(entry)
        .slice(split + 1)
        .trim();
      const valid =
        key.type === 'bindings'
          ? /^(?:\*|[a-z0-9-]+)\/(?:\*|[a-z0-9-]+)$/.test(name) &&
            (LANE_IDS as readonly string[]).includes(value)
          : key.env.endsWith('_WINDOW_FRACTIONS')
            ? /^[a-z0-9*-]+$/.test(name) && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)
            : /^[a-z0-9*-]+$/.test(name) && /^[a-z0-9*-]+$/.test(value);
      if (!valid) throw new Error(`${key.env}: invalid map token`);
      if (Object.hasOwn(result, name)) throw new Error(`${key.env}: duplicate map entry '${name}'`);
      result[name] = value;
    }
    return result;
  }
  if (key.type === 'aliases') {
    const objectEntries =
      typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw) : undefined;
    if (objectEntries?.some(([, value]) => typeof value !== 'string'))
      throw new Error(`${key.env}: alias values must be strings`);
    const entries = isStringArray(raw)
      ? raw
      : objectEntries
        ? objectEntries.map(([k, v]) => `${k}=${v}`)
        : String(raw)
            .split(',')
            .filter((part) => part.trim() !== '');
    const result: Record<string, string> = {};
    for (const rawEntry of entries) {
      const entry = String(rawEntry).trim();
      const split = entry.indexOf('=');
      if (split < 0) throw new Error(`${key.env}: expected lane/provider/requested=served entries`);
      const name = entry.slice(0, split);
      const served = entry.slice(split + 1);
      const parts = name.split('/');
      if (
        parts.length !== 3 ||
        parts.some((part) => !part) ||
        !(LANE_IDS as readonly string[]).includes(parts[0]!) ||
        !/^[a-z0-9-]+$/.test(parts[1]!) ||
        !served ||
        /[=,|]/.test(served)
      ) {
        throw new Error(`${key.env}: invalid served-alias entry`);
      }
      if (Object.hasOwn(result, name)) throw new Error(`${key.env}: duplicate served-alias entry`);
      result[name] = served;
    }
    return result;
  }
  if (key.type === 'bool') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    throw new Error(`${key.env}: expected lowercase true or false`);
  }
  if (['int', 'ms', 'usd'].includes(key.type)) {
    const source = String(raw);
    const pattern = key.type === 'usd' ? /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/ : /^(?:0|[1-9]\d*)$/;
    if (!pattern.test(source)) throw new Error(`${key.env}: invalid ${key.type} value`);
    const value = Number(source);
    if (
      !Number.isFinite(value) ||
      (key.type !== 'usd' && !Number.isSafeInteger(value)) ||
      (key.min !== undefined && value < key.min) ||
      (key.max !== undefined && value > key.max)
    ) {
      throw new Error(`${key.env}: value out of range`);
    }
    return value;
  }
  const value = String(raw);
  if (key.values && !key.values.includes(value))
    throw new Error(`${key.env}: unsupported value '${value}'`);
  if (
    /^CQ_PROVIDER_[A-Z0-9_]+_PROFILE$/.test(key.env) &&
    value !== 'bundled' &&
    !value.startsWith('custom:')
  )
    throw new Error(`${key.env}: expected 'bundled' or 'custom:<absolute-path>'`);
  if (key.type === 'model' && !/^[a-z0-9-]+\/.+$/.test(value))
    throw new Error(`${key.env}: expected provider/model`);
  if (key.type === 'url') {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${key.env}: expected URL without userinfo or query`);
    }
    const proxy = key.env === 'CQ_SANDBOX_PROXY_URL';
    if (
      (!proxy && parsed.protocol !== 'https:') ||
      (proxy && !['https:', 'http:'].includes(parsed.protocol)) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !parsed.hostname
    )
      throw new Error(
        `${key.env}: expected ${proxy ? 'HTTP(S)' : 'HTTPS'} URL without credentials or query`,
      );
    if (key.env.endsWith('_QUOTA_ENDPOINT')) {
      if (!key.usageEndpointHost)
        throw new Error(
          `${key.env}: no bundled credential-bearing usage endpoint host is registered`,
        );
      if (parsed.hostname.toLowerCase() !== key.usageEndpointHost || parsed.port)
        throw new Error(`${key.env}: host must match the bundled provider usage endpoint`);
    }
  }
  // A separator-bearing or drive-prefixed gh path is relative somewhere, and
  // consumers resolve such paths against different working directories.
  if (
    key.env === 'CQ_GH_BIN' &&
    /[\\/]|^[A-Za-z]:/.test(value) &&
    !isConfigAbsolute(value, platform)
  )
    throw new Error(`${key.env}: expected a bare executable name or an absolute path`);
  if (key.type === 'argv') {
    let argv: unknown;
    try {
      argv = JSON.parse(value);
    } catch {
      throw new Error(`${key.env}: expected JSON argv`);
    }
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((part) => typeof part !== 'string' || part.length === 0) ||
      // A drive prefix (`C:claude.exe`) is drive-relative on Windows, so it is path-like too.
      (typeof argv[0] === 'string' &&
        /[\\/]|^[A-Za-z]:/.test(argv[0]) &&
        !isConfigAbsolute(argv[0], platform))
    )
      throw new Error(`${key.env}: expected non-empty string argv`);
    return argv as string[];
  }
  if (key.type === 'window') validateWindow(key, value);
  return value;
}

function isDefaultSentinel(key: ConfigKey, raw: unknown): boolean {
  return (
    (key.env === 'CQ_DRIVER_SUBPROCESS_ROUTING' && raw === '<default-routing-table>') ||
    (key.env === 'CQ_DRIVER_ACP_COMMAND' && raw === '<endpoint-argv>')
  );
}

/** Parse and expand one layer's value; workspace evidence is checked once, on the final value. */
function resolveValue(
  key: ConfigKey,
  raw: string | boolean | number | readonly string[] | Readonly<Record<string, string>> | null,
  env: Readonly<Record<string, string | undefined>>,
  platform: 'posix' | 'win32',
  allowDefaultSentinel = false,
): ConfigValue {
  if (allowDefaultSentinel && isDefaultSentinel(key, raw)) return raw;
  const value = parse(key, raw, platform);
  if (
    key.outsideWorkspace &&
    key.type === 'string' &&
    typeof value === 'string' &&
    value.startsWith('custom:')
  )
    return `custom:${expandPath(value.slice('custom:'.length), env, key, platform)}`;
  if (key.type === 'path' && typeof value === 'string')
    return expandPath(value, env, key, platform);
  return value;
}

/** Canonicalize the effective value of an outside-workspace key against caller evidence. */
function verifyWorkspacePath(
  key: ConfigKey,
  value: ConfigValue,
  options: ResolveConfigOptions,
): ConfigValue {
  if (!key.outsideWorkspace || typeof value !== 'string' || isDefaultSentinel(key, value))
    return value;
  if (key.type === 'path') return assertOutsideWorkspace(key, value, options) ?? value;
  if (key.type === 'string' && value.startsWith('custom:')) {
    const path = value.slice('custom:'.length);
    return `custom:${assertOutsideWorkspace(key, path, options) ?? path}`;
  }
  return value;
}

function validateWindow(key: ConfigKey, value: string): void {
  const match =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:[-+](?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))* (\d{2}):(\d{2})-(\d{2}):(\d{2}) (UTC|[A-Za-z_]+\/[A-Za-z0-9_+\-/]+)(?:; (?:mult=(\d+(?:\.\d+)?)|off=(\d+(?:\.\d+)?))(?:; (?:mult=(\d+(?:\.\d+)?)|off=(\d+(?:\.\d+)?)))?)?$/.exec(
      value,
    );
  if (
    !match ||
    (match[6] !== undefined && match[8] !== undefined) ||
    (match[7] !== undefined && match[9] !== undefined) ||
    Number(match[1]) > 23 ||
    Number(match[2]) > 59 ||
    Number(match[3]) > 23 ||
    Number(match[4]) > 59 ||
    (match[1] === match[3] && match[2] === match[4]) ||
    [match[6], match[7], match[8], match[9]].some(
      (part) => part !== undefined && !Number.isFinite(Number(part)),
    ) ||
    [match[6], match[8]].some((part) => part !== undefined && Number(part) <= 0) ||
    [match[7], match[9]].some((part) => part !== undefined && Number(part) < 0)
  )
    throw new Error(`${key.env}: invalid quota window`);
  if (match[5] !== 'UTC') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: match[5] });
    } catch {
      throw new Error(`${key.env}: invalid quota window timezone`);
    }
  }
}

function equal(a: ConfigValue, b: ConfigValue): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

function isSubset(a: ConfigValue, b: ConfigValue): boolean {
  return isStringArray(a) && isStringArray(b) && a.every((value) => b.includes(value));
}

function mergeable(key: ConfigKey): boolean {
  return key.type === 'map' || key.type === 'bindings' || key.type === 'aliases';
}

function overlay(key: ConfigKey, lower: ConfigValue, higher: ConfigValue): ConfigValue {
  if (
    mergeable(key) &&
    lower &&
    higher &&
    typeof lower === 'object' &&
    typeof higher === 'object' &&
    !isStringArray(lower) &&
    !isStringArray(higher)
  ) {
    return Object.freeze({ ...lower, ...higher });
  }
  return higher;
}

function tighter(key: ConfigKey, value: ConfigValue, baseline: ConfigValue): boolean {
  if (equal(value, baseline)) return true;
  if (key.id === 'sandbox') return value === 'required';
  if (key.id === 'sandbox.network') return value === 'model-only';
  if (key.id === 'run.tool') return value === 'off';
  if (key.id === 'driver.sessionRetention') return value === 'reap-on-settle';
  if (key.id === 'merge.protectedPaths') return value === 'human';
  switch (key.order) {
    case 'true':
      return value === true;
    case 'false':
      return value === false;
    case 'smaller':
      return (
        typeof value === 'number' &&
        (baseline === null || (typeof baseline === 'number' && value <= baseline))
      );
    case 'limit':
      return (
        typeof value === 'number' &&
        (baseline === null || (typeof baseline === 'number' && value <= baseline))
      );
    case 'larger':
      return typeof value === 'number' && typeof baseline === 'number' && value >= baseline;
    case 'subset':
      return isSubset(value, baseline);
    case 'union':
      return isSubset(baseline, value);
    case 'neutral':
      return true;
    case 'unordered':
    case 'none':
      return false;
  }
}

function callOnlyEqual(id: string, typed: unknown, value: string): boolean {
  if (CALL_ONLY_CONFIG[id as keyof typeof CALL_ONLY_CONFIG]?.type === 'list') {
    try {
      return equal(
        parseListItems(id, isStringArray(typed) ? typed : String(typed)),
        parseListItems(id, value),
      );
    } catch {
      return false;
    }
  }
  return String(typed) === value;
}

function parseOptIns(optIns: readonly string[]): {
  ids: Set<string>;
  values: Map<string, string>;
} {
  const ids = new Set<string>();
  const values = new Map<string, string>();
  for (const entry of optIns) {
    const split = entry.indexOf('=');
    const id = split < 0 ? entry : entry.slice(0, split);
    if (!byId.has(id) && !Object.hasOwn(CALL_ONLY_CONFIG, id))
      throw new Error(`unknown opt-in key '${id}'`);
    ids.add(id);
    if (split >= 0) values.set(id, entry.slice(split + 1));
  }
  return { ids, values };
}

/** Resolve config exactly once from a caller-owned env snapshot. */
export function resolveConfig(input: ResolveConfigOptions = {}): ResolvedConfig {
  // Caller records are read for own properties only, and the copies keep a
  // null prototype: an inherited property — from the caller's record or from a
  // polluted Object.prototype — never passed the own-key validation below, so
  // it is not configuration.
  const ownInput = Object.assign(Object.create(null) as ResolveConfigOptions, input);
  const options: ResolveConfigOptions = Object.assign(Object.create(null) as ResolveConfigOptions, {
    ...ownInput,
    ...(ownInput.env ? { env: ownEntries(ownInput.env) } : {}),
    ...(ownInput.values ? { values: ownEntries(ownInput.values) } : {}),
    ...(ownInput.verifiedRealpaths
      ? { verifiedRealpaths: ownEntries(ownInput.verifiedRealpaths) }
      : {}),
  });
  const platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  const env = options.env ?? ownEntries<string | undefined>({});
  const customProviderIds = Object.keys(env)
    .filter(
      (name) =>
        /^CQ_PROVIDER_[A-Z0-9_]+_PROFILE$/.test(name) &&
        !PROVIDER_IDS.some(
          (id) => name === `CQ_PROVIDER_${id.toUpperCase().replaceAll('-', '_')}_PROFILE`,
        ),
    )
    .map((name) =>
      name.slice('CQ_PROVIDER_'.length, -'_PROFILE'.length).toLowerCase().replaceAll('_', '-'),
    )
    .filter(
      (id) =>
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) &&
        nonblank(
          envValue(env, `CQ_PROVIDER_${id.toUpperCase().replaceAll('-', '_')}_PROFILE`, platform),
        )?.startsWith('custom:'),
    );
  const registry = [...CONFIG_REGISTRY, ...providerKeysFor(customProviderIds)];
  const registryByEnv = new Map(registry.map((key) => [key.env, key]));
  const secrets: Record<string, { layer: 'env'; set: true }> = {};
  const credentials: Record<string, 'set'> = {};
  const foreign: Record<string, string> = {};
  const unknownNames: string[] = [];
  for (const name of Object.keys(env)) {
    // Windows environment lookups are case-insensitive, so a noncanonical CQ_*
    // spelling would silently alias its canonical variable; fail closed instead.
    if (/^cq_/i.test(name) && !name.startsWith('CQ_'))
      throw new Error(`${name}: expected canonical CQ_* spelling`);
    if (name.startsWith('CQ_APPROVAL_KEY')) throw new Error(`${name}: reserved and denied`);
    if (isSecret(name) && nonblank(envValue(env, name, platform)) !== undefined) {
      if (name.startsWith('CQ_')) secrets[name] = { layer: 'env', set: true };
      else credentials[name] = 'set';
    }
    if (name.startsWith('CQ_') && name !== 'CQ_PROFILE' && !registryByEnv.has(name))
      unknownNames.push(name);
  }
  if (unknownNames.length) {
    throw new Error(
      unknownNames
        .map((name) => {
          const nearest = closestName(name);
          return `unknown configuration variable ${name}${nearest ? `; did you mean ${nearest}?` : ''}`;
        })
        .join('\n'),
    );
  }
  for (const name of FOREIGN_ENV_NAMES) {
    const value = envValue(env, name, platform);
    if (nonblank(value) === undefined) continue;
    if (isSecret(name)) credentials[name] = 'set';
    else foreign[name] = value!;
  }
  for (const name of [
    'ZAI_BASE_URL',
    'ZAI_ANTHROPIC_BASE_URL',
    'DEEPSEEK_ANTHROPIC_BASE_URL',
    'ANTHROPIC_BASE_URL',
  ]) {
    const value = nonblank(envValue(env, name, platform));
    if (value && !validForeignBaseUrl(value))
      throw new Error(`${name}: expected HTTPS URL without userinfo or query`);
  }
  const profileRaw = nonblank(envValue(env, 'CQ_PROFILE', platform));
  if (
    profileRaw !== undefined &&
    profileRaw !== 'conservative' &&
    profileRaw !== 'solo-maintainer'
  ) {
    throw new Error(`CQ_PROFILE: unsupported profile '${profileRaw}'`);
  }
  const profile: ConfigProfile = profileRaw === 'solo-maintainer' ? profileRaw : 'conservative';
  const eventName = options.eventName ?? envValue(env, 'GITHUB_EVENT_NAME', platform);
  if (
    eventName === 'pull_request' &&
    Object.keys(env).some(
      (name) =>
        name.startsWith('CQ_APPROVAL_') && nonblank(envValue(env, name, platform)) !== undefined,
    )
  ) {
    throw new Error('CQ_APPROVAL_* is trusted-only and cannot be set by a pull_request workflow');
  }
  const { ids: optIns, values: optInValues } = parseOptIns(options.optIn ?? []);
  for (const id of Object.keys(options.values ?? {})) {
    if (!byId.has(id) && !Object.hasOwn(CALL_ONLY_CONFIG, id))
      throw new Error(`unknown per-call configuration key '${id}'`);
  }
  for (const [id, value] of optInValues) {
    const typed = options.values?.[id];
    if (typed === undefined) continue;
    const key = byId.get(id);
    // Compare parsed values so typed records and reordered lists match their string form.
    if (
      key
        ? !equal(parse(key, typed, platform), parse(key, value, platform))
        : !callOnlyEqual(id, typed, value)
    )
      throw new Error(`${id}: opt-in value disagrees with typed value`);
  }

  const entries: Record<string, ResolvedConfigEntry> = {};
  for (const key of registry) {
    const raw = nonblank(envValue(env, key.env, platform));
    const callRaw =
      options.values?.[key.id] ??
      optInValues.get(key.id) ??
      (optIns.has(key.id) && key.type === 'bool' ? true : undefined);
    const overridden =
      raw !== undefined ||
      callRaw !== undefined ||
      (profile === 'solo-maintainer' && key.solo !== undefined);
    let defaultValue: ConfigValue;
    if (key.blank === null) {
      defaultValue =
        key.type === 'list'
          ? []
          : key.type === 'map' || key.type === 'bindings' || key.type === 'aliases'
            ? {}
            : null;
    } else {
      try {
        defaultValue = resolveValue(key, key.blank, env, platform, true);
      } catch (error) {
        // A path default whose variable (XDG_STATE_HOME, TMPDIR) is unset only
        // matters when it is the effective value; an override replaces it.
        if (key.type !== 'path' || !overridden) throw error;
        defaultValue = key.blank;
      }
    }
    const seeded =
      profile === 'solo-maintainer' && key.solo !== undefined
        ? resolveValue(key, key.solo, env, platform)
        : undefined;
    let current = seeded === undefined ? defaultValue : overlay(key, defaultValue, seeded);
    let layer: ConfigLayer = seeded === undefined ? 'default' : 'profile';
    let sourceEnv: string | undefined = seeded === undefined ? undefined : 'CQ_PROFILE';
    if (raw !== undefined) {
      if (key.reserved) throw new Error(`${key.env}: reserved; not yet honoured`);
      const projectValue =
        key.id === 'automation.token' ? null : resolveValue(key, raw, env, platform);
      if (key.id === 'merge.trustedAssociations' && !isSubset(projectValue, defaultValue))
        throw new Error(`${key.env}: project values may only narrow the fixed association set`);
      if (key.order === 'union' && !isSubset(defaultValue, projectValue)) {
        throw new Error(`${key.env}: project values may only add exclusions`);
      }
      if (
        key.id === 'run.envPassthrough' &&
        isStringArray(projectValue) &&
        projectValue.some((name) => unsafePassthrough(name, env, platform))
      ) {
        throw new Error(`${key.env}: policy and secret variables cannot be passed through`);
      }
      current = overlay(key, current, projectValue);
      layer = 'env';
      sourceEnv = key.env;
    }
    if (callRaw !== undefined) {
      if (!key.perCall) throw new Error(`${key.id}: has no per-call layer`);
      const next = resolveValue(key, callRaw, env, platform);
      if (
        key.id === 'run.envPassthrough' &&
        isStringArray(next) &&
        next.some((name) => unsafePassthrough(name, env, platform))
      )
        throw new Error(`${key.env}: policy and secret variables cannot be passed through`);
      // Maps merge by entry, so judge the merged result rather than the partial call value.
      const merged = overlay(key, current, next);
      if (!tighter(key, merged, current) && !optIns.has(key.id))
        throw new Error(`${key.id}: less-conservative per-call value requires explicit opt-in`);
      current = merged;
      layer = 'call';
      sourceEnv = undefined;
    }
    const relaxed = !tighter(key, current, defaultValue);
    entries[key.id] = Object.freeze({
      value: deepFreeze(verifyWorkspacePath(key, current, options)),
      layer,
      ...(sourceEnv ? { env: sourceEnv } : {}),
      relaxed,
      changed: !equal(current, defaultValue),
    });
  }
  for (const providerId of [...PROVIDER_IDS, ...customProviderIds]) {
    const known = entries[`provider.${providerId}.limitsKnown`]?.value;
    if (known === true && entries[`provider.${providerId}.capAmount`]?.value === null) {
      throw new Error(
        `CQ_PROVIDER_${providerId.toUpperCase().replaceAll('-', '_')}_LIMITS_KNOWN requires a declared cap`,
      );
    }
  }
  for (const [id, spec] of Object.entries(CALL_ONLY_CONFIG)) {
    const raw =
      options.values?.[id] ??
      optInValues.get(id) ??
      (optIns.has(id) && spec.type === 'bool' ? true : undefined);
    if (raw === undefined) continue;
    let value: ConfigValue;
    if (spec.type === 'bool') {
      if (raw !== true && raw !== false && raw !== 'true' && raw !== 'false')
        throw new Error(`${id}: expected boolean value`);
      value = raw === true || raw === 'true';
    } else if (spec.type === 'list') {
      value = parseListItems(id, raw);
    } else {
      value = String(raw);
      if ('values' in spec && !spec.values.some((supported: string) => supported === value))
        throw new Error(`${id}: unsupported value '${value}'`);
      if (id === 'budget.breakLock' && !value) throw new Error(`${id}: run id is required`);
    }
    // Every call-only key is a governance relaxation unless it is inert.
    const inert = value === false || (isStringArray(value) && value.length === 0);
    if (!inert && !optIns.has(id))
      throw new Error(`${id}: call-only relaxation requires explicit opt-in`);
    entries[id] = Object.freeze({
      value: deepFreeze(value),
      layer: 'call',
      relaxed: !inert,
      changed: true,
    });
  }
  return Object.freeze({
    registryVersion: 1,
    profile,
    entries: Object.freeze(entries),
    secrets: deepFreeze(secrets),
    credentials: Object.freeze(credentials),
    foreign: Object.freeze(foreign),
  });
}
