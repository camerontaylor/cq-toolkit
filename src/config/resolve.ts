import {
  CONFIG_REGISTRY,
  CALL_ONLY_CONFIG,
  FOREIGN_ENV_NAMES,
  PROVIDER_IDS,
  PROVIDER_KEYS,
  type ConfigKey,
  providerKeysFor,
} from './registry.js';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

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
}

const byId = new Map(CONFIG_REGISTRY.map((key) => [key.id, key]));
const providerKeySuffixes = [...PROVIDER_KEYS].sort((a, b) => b.length - a.length);
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

function credentialUrl(value: string | undefined): boolean {
  if (!value || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  } catch {
    return true;
  }
}

function unsafePassthrough(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    name.startsWith('CQ_') ||
    deniedPassthrough.has(name) ||
    name.startsWith('AWS_') ||
    name.startsWith('AZURE_') ||
    name.startsWith('GOOGLE_') ||
    name.startsWith('GCP_') ||
    isSecret(name) ||
    credentialUrl(env[name])
  );
}

function expandPath(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  key: ConfigKey,
): string {
  const expanded = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_match, name: string) => {
    const replacement = nonblank(env[name]);
    if (!replacement || !isAbsolute(replacement))
      throw new Error(`${key.env}: unresolved absolute path variable`);
    return replacement;
  });
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

function providerName(name: string, env: Readonly<Record<string, string | undefined>>): boolean {
  if (!name.startsWith('CQ_PROVIDER_')) return false;
  return providerKeySuffixes.some((suffix) => {
    const encodedId = name.slice('CQ_PROVIDER_'.length, -suffix.length);
    const id = encodedId.toLowerCase().replaceAll('_', '-');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return false;
    if (PROVIDER_IDS.includes(id as (typeof PROVIDER_IDS)[number])) return true;
    return nonblank(env[`CQ_PROVIDER_${encodedId}_PROFILE`])?.startsWith('custom:') === true;
  });
}

function parse(
  key: ConfigKey,
  raw: string | boolean | number | readonly string[] | Readonly<Record<string, string>> | null,
): ConfigValue {
  if (raw === null) return null;
  if (key.type === 'list') {
    const parts = isStringArray(raw)
      ? [...raw]
      : String(raw)
          .split(',')
          .map((part) => part.trim());
    if (parts.some((part) => part.length === 0)) throw new Error(`${key.env}: empty list item`);
    if (parts.includes('none') && parts.length !== 1)
      throw new Error(`${key.env}: 'none' must be the only item`);
    if (parts.includes('none')) return [];
    if (new Set(parts).size !== parts.length) throw new Error(`${key.env}: duplicate list item`);
    const unique = [...new Set(parts)].sort();
    if (key.values && unique.some((value) => !key.values?.includes(value)))
      throw new Error(`${key.env}: unsupported list value`);
    if (
      key.id === 'merge.trustedBots' &&
      unique.some((value) => !/^[A-Za-z0-9-]+\[bot\]$/.test(value))
    )
      throw new Error(`${key.env}: expected bot logins ending in [bot]`);
    if (
      key.id === 'merge.trustedBots' &&
      unique.some((value) =>
        [
          'github-actions[bot]',
          'cq-verdict[bot]',
          'cq-promoter[bot]',
          'cq-automation[bot]',
        ].includes(value),
      )
    )
      throw new Error(`${key.env}: structurally excluded bot identity`);
    if (key.id === 'run.envPassthrough' && unique.some((name) => unsafePassthrough(name, {})))
      throw new Error(`${key.env}: policy and secret variables cannot be passed through`);
    if (
      key.id === 'driver.acp.envNames' &&
      unique.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith('CQ_'))
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
          ? /^(?:\*|[a-z0-9-]+)\/(?:\*|[a-z0-9-]+)$/.test(name) && /^[a-z][a-z0-9-]*$/.test(value)
          : key.env.endsWith('_WINDOW_FRACTIONS')
            ? /^[a-z0-9*-]+$/.test(name) && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)
            : /^[a-z0-9*-]+$/.test(name) && /^[a-z0-9*-]+$/.test(value);
      if (!valid) throw new Error(`${key.env}: invalid map token`);
      if (name in result) throw new Error(`${key.env}: duplicate map entry '${name}'`);
      result[name] = value;
    }
    return result;
  }
  if (key.type === 'aliases') {
    const entries = isStringArray(raw)
      ? raw
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
        !/^[a-z0-9-]+$/.test(parts[0]!) ||
        !/^[a-z0-9-]+$/.test(parts[1]!) ||
        !served ||
        /[=,|]/.test(served)
      ) {
        throw new Error(`${key.env}: invalid served-alias entry`);
      }
      if (name in result) throw new Error(`${key.env}: duplicate served-alias entry`);
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
      (key.type === 'int' && !Number.isSafeInteger(value)) ||
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
      (typeof argv[0] === 'string' && argv[0].includes('/') && !isAbsolute(argv[0]))
    )
      throw new Error(`${key.env}: expected non-empty string argv`);
    return argv as string[];
  }
  if (key.type === 'window') validateWindow(key, value);
  return value;
}

function resolveValue(
  key: ConfigKey,
  raw: string | boolean | number | readonly string[] | Readonly<Record<string, string>> | null,
  env: Readonly<Record<string, string | undefined>>,
  options: ResolveConfigOptions,
  allowDefaultSentinel = false,
): ConfigValue {
  if (
    allowDefaultSentinel &&
    ((key.env === 'CQ_DRIVER_SUBPROCESS_ROUTING' && raw === '<default-routing-table>') ||
      (key.env === 'CQ_DRIVER_ACP_COMMAND' && raw === '<endpoint-argv>'))
  )
    return raw;
  let value = parse(key, raw);
  if (
    key.outsideWorkspace &&
    key.type === 'string' &&
    typeof value === 'string' &&
    value.startsWith('custom:')
  ) {
    const path = expandPath(value.slice('custom:'.length), env, key);
    return `custom:${assertOutsideWorkspace(key, path, options) ?? path}`;
  }
  if (key.type === 'path' && typeof value === 'string') {
    value = expandPath(value, env, key);
    value = assertOutsideWorkspace(key, value, options) ?? value;
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
  return JSON.stringify(a) === JSON.stringify(b);
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

function parseOptIns(optIns: readonly string[]): {
  ids: Set<string>;
  values: Map<string, string>;
} {
  const ids = new Set<string>();
  const values = new Map<string, string>();
  for (const entry of optIns) {
    const split = entry.indexOf('=');
    const id = split < 0 ? entry : entry.slice(0, split);
    if (!byId.has(id) && !(id in CALL_ONLY_CONFIG)) throw new Error(`unknown opt-in key '${id}'`);
    ids.add(id);
    if (split >= 0) values.set(id, entry.slice(split + 1));
  }
  return { ids, values };
}

/** Resolve config exactly once from a caller-owned env snapshot. */
export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? {};
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
        nonblank(env[`CQ_PROVIDER_${id.toUpperCase().replaceAll('-', '_')}_PROFILE`])?.startsWith(
          'custom:',
        ),
    );
  const registry = [...CONFIG_REGISTRY, ...providerKeysFor(customProviderIds)];
  const registryByEnv = new Map(registry.map((key) => [key.env, key]));
  const secrets: Record<string, { layer: 'env'; set: true }> = {};
  const credentials: Record<string, 'set'> = {};
  const foreign: Record<string, string> = {};
  const unknownNames: string[] = [];
  for (const name of Object.keys(env)) {
    if (name.startsWith('CQ_APPROVAL_KEY')) throw new Error(`${name}: reserved and denied`);
    if (isSecret(name) && env[name] !== undefined && env[name] !== '') {
      if (name.startsWith('CQ_')) secrets[name] = { layer: 'env', set: true };
      else credentials[name] = 'set';
    }
    if (
      name.startsWith('CQ_') &&
      name !== 'CQ_PROFILE' &&
      !registryByEnv.has(name) &&
      !providerName(name, env)
    )
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
    if (env[name] !== undefined && isSecret(name)) credentials[name] = 'set';
    else if (env[name] !== undefined && env[name] !== '') foreign[name] = env[name];
  }
  for (const name of [
    'ZAI_BASE_URL',
    'ZAI_ANTHROPIC_BASE_URL',
    'DEEPSEEK_ANTHROPIC_BASE_URL',
    'ANTHROPIC_BASE_URL',
  ]) {
    const value = nonblank(env[name]);
    if (value && !/^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(value))
      throw new Error(`${name}: expected HTTPS URL without userinfo or query`);
  }
  const profileRaw = nonblank(env.CQ_PROFILE);
  if (
    profileRaw !== undefined &&
    profileRaw !== 'conservative' &&
    profileRaw !== 'solo-maintainer'
  ) {
    throw new Error(`CQ_PROFILE: unsupported profile '${profileRaw}'`);
  }
  const profile: ConfigProfile = profileRaw === 'solo-maintainer' ? profileRaw : 'conservative';
  const eventName = options.eventName ?? env.GITHUB_EVENT_NAME;
  if (
    eventName === 'pull_request' &&
    Object.keys(env).some(
      (name) => name.startsWith('CQ_APPROVAL_') && nonblank(env[name]) !== undefined,
    )
  ) {
    throw new Error('CQ_APPROVAL_* is trusted-only and cannot be set by a pull_request workflow');
  }
  const { ids: optIns, values: optInValues } = parseOptIns(options.optIn ?? []);
  for (const id of Object.keys(options.values ?? {})) {
    if (!byId.has(id) && !(id in CALL_ONLY_CONFIG))
      throw new Error(`unknown per-call configuration key '${id}'`);
  }
  for (const [id, value] of optInValues) {
    const typed = options.values?.[id];
    if (typed !== undefined && String(typed) !== value)
      throw new Error(`${id}: opt-in value disagrees with typed value`);
  }

  const entries: Record<string, ResolvedConfigEntry> = {};
  for (const key of registry) {
    const defaultValue =
      key.blank === null
        ? key.type === 'list'
          ? []
          : key.type === 'map' || key.type === 'bindings' || key.type === 'aliases'
            ? {}
            : null
        : resolveValue(key, key.blank, env, options, true);
    const seeded =
      profile === 'solo-maintainer' && key.solo !== undefined
        ? resolveValue(key, key.solo, env, options)
        : undefined;
    let current = seeded === undefined ? defaultValue : overlay(key, defaultValue, seeded);
    let layer: ConfigLayer = seeded === undefined ? 'default' : 'profile';
    let sourceEnv: string | undefined = seeded === undefined ? undefined : 'CQ_PROFILE';
    const raw = nonblank(env[key.env]);
    if (raw !== undefined) {
      if (key.reserved) throw new Error(`${key.env}: reserved; not yet honoured`);
      const projectValue =
        key.id === 'automation.token' ? null : resolveValue(key, raw, env, options);
      if (key.id === 'merge.trustedAssociations' && !isSubset(projectValue, defaultValue))
        throw new Error(`${key.env}: project values may only narrow the fixed association set`);
      if (key.order === 'union' && !isSubset(defaultValue, projectValue)) {
        throw new Error(`${key.env}: project values may only add exclusions`);
      }
      if (
        key.id === 'run.envPassthrough' &&
        isStringArray(projectValue) &&
        projectValue.some((name) => unsafePassthrough(name, env))
      ) {
        throw new Error(`${key.env}: policy and secret variables cannot be passed through`);
      }
      current = overlay(key, current, projectValue);
      layer = 'env';
      sourceEnv = key.env;
    }
    const callRaw =
      options.values?.[key.id] ??
      optInValues.get(key.id) ??
      (optIns.has(key.id) && key.type === 'bool' ? true : undefined);
    if (callRaw !== undefined) {
      if (!key.perCall) throw new Error(`${key.id}: has no per-call layer`);
      const next = resolveValue(key, callRaw, env, options);
      if (
        key.id === 'run.envPassthrough' &&
        isStringArray(next) &&
        next.some((name) => unsafePassthrough(name, env))
      )
        throw new Error(`${key.env}: policy and secret variables cannot be passed through`);
      if (!tighter(key, next, current) && !optIns.has(key.id))
        throw new Error(`${key.id}: less-conservative per-call value requires explicit opt-in`);
      current = overlay(key, current, next);
      layer = 'call';
      sourceEnv = undefined;
    }
    const relaxed = !tighter(key, current, defaultValue);
    entries[key.id] = Object.freeze({
      value: deepFreeze(current),
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
      value = isStringArray(raw) ? [...raw] : String(raw).split(',').filter(Boolean).sort();
    } else {
      value = String(raw);
      if ('values' in spec && !spec.values.some((supported: string) => supported === value))
        throw new Error(`${id}: unsupported value '${value}'`);
      if (id === 'budget.breakLock' && !value) throw new Error(`${id}: run id is required`);
    }
    entries[id] = Object.freeze({
      value: deepFreeze(value),
      layer: 'call',
      relaxed: true,
      changed: true,
    });
  }
  return Object.freeze({
    registryVersion: 1,
    profile,
    entries: Object.freeze(entries),
    secrets: Object.freeze(secrets),
    credentials: Object.freeze(credentials),
    foreign: Object.freeze(foreign),
  });
}
