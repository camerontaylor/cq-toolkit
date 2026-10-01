import { CONFIG_REGISTRY, type ConfigKey, type ConfigScalar } from './registry.js';

export type ConfigProfile = 'conservative' | 'solo-maintainer';
export type ConfigLayer = 'default' | 'profile' | 'env' | 'call';
export interface ResolvedConfigEntry {
  readonly value: ConfigScalar | readonly string[];
  readonly layer: ConfigLayer;
  readonly env?: string;
  readonly relaxed: boolean;
}
export interface ResolvedConfig {
  readonly profile: ConfigProfile;
  readonly entries: Readonly<Record<string, ResolvedConfigEntry>>;
}
export interface ResolveConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly values?: Readonly<Record<string, string | boolean | readonly string[]>>;
  readonly optIn?: readonly string[];
}

const byEnv = new Map(CONFIG_REGISTRY.map((key) => [key.env, key]));
const byId = new Map(CONFIG_REGISTRY.map((key) => [key.id, key]));

function nonblank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function parse(key: ConfigKey, raw: string | boolean | readonly string[]): ConfigScalar | readonly string[] {
  if (key.type === 'list') {
    const parts = Array.isArray(raw) ? [...raw] : String(raw).split(',').map((part) => part.trim());
    if (parts.some((part) => part.length === 0)) throw new Error(`${key.env}: empty list item`);
    if (parts.includes('none') && parts.length !== 1) throw new Error(`${key.env}: 'none' must be the only item`);
    return parts.includes('none') ? [] : [...new Set(parts)].sort();
  }
  const value = String(raw);
  if (!key.values.includes(value)) throw new Error(`${key.env}: unsupported value '${value}'`);
  return value;
}

function same(a: ConfigScalar | readonly string[], b: ConfigScalar | readonly string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function tighter(key: ConfigKey, value: ConfigScalar | readonly string[], baseline: ConfigScalar | readonly string[]): boolean {
  if (same(value, baseline)) return true;
  if (key.order !== 'tighter') return key.order === 'neutral';
  if (key.id === 'sandbox') return value === 'required';
  if (key.id === 'sandbox.network') return value === 'model-only';
  if (key.id === 'run.tool') return value === 'off';
  return false;
}

/** Resolve the registered subset using built-in → profile/env → explicit call precedence. */
export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? {};
  for (const name of Object.keys(env)) {
    if (name.startsWith('CQ_') && name !== 'CQ_PROFILE' && !byEnv.has(name)) {
      throw new Error(`unknown configuration variable ${name}`);
    }
  }
  const profileValue = nonblank(env.CQ_PROFILE);
  if (profileValue !== undefined && profileValue !== 'conservative' && profileValue !== 'solo-maintainer') {
    throw new Error(`CQ_PROFILE: unsupported profile '${profileValue}'`);
  }
  const profile: ConfigProfile = profileValue === 'solo-maintainer' ? profileValue : 'conservative';
  const allowed = new Set(options.optIn ?? []);
  for (const id of allowed) if (!byId.has(id)) throw new Error(`unknown opt-in key '${id}'`);
  const entries: Record<string, ResolvedConfigEntry> = {};
  for (const key of CONFIG_REGISTRY) {
    const builtin = parse(key, key.builtin);
    const profileRaw = profile === 'solo-maintainer' ? key.soloMaintainer : undefined;
    let current = profileRaw === undefined ? builtin : parse(key, profileRaw);
    let layer: ConfigLayer = profileRaw === undefined ? 'default' : 'profile';
    let sourceEnv: string | undefined = profileRaw === undefined ? undefined : 'CQ_PROFILE';
    const envRaw = nonblank(env[key.env]);
    if (envRaw !== undefined) {
      current = parse(key, envRaw);
      layer = 'env';
      sourceEnv = key.env;
    }
    const callRaw = options.values?.[key.id];
    if (callRaw !== undefined) {
      if (!key.perCall) throw new Error(`${key.id}: has no per-call layer`);
      const next = parse(key, callRaw);
      if (!tighter(key, next, current) && !allowed.has(key.id)) {
        throw new Error(`${key.id}: less-conservative per-call value requires explicit opt-in`);
      }
      current = next;
      layer = 'call';
      sourceEnv = undefined;
    }
    entries[key.id] = Object.freeze({ value: current, layer, ...(sourceEnv ? { env: sourceEnv } : {}), relaxed: !tighter(key, current, builtin) });
  }
  return Object.freeze({ profile, entries: Object.freeze(entries) });
}
