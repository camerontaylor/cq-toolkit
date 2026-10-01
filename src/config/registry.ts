/** Initial pure configuration registry. Keep this independent of entry points. */
export type ConfigScalar = string | boolean;
export type ConfigOrder = 'tighter' | 'unordered' | 'neutral';
export type ConfigType = 'enum' | 'list';

export interface ConfigKey {
  readonly env: string;
  readonly id: string;
  readonly type: ConfigType;
  readonly values: readonly string[];
  readonly builtin: ConfigScalar;
  readonly soloMaintainer?: ConfigScalar;
  readonly order: ConfigOrder;
  readonly perCall: boolean;
}

export const CONFIG_REGISTRY = [
  { env: 'CQ_SANDBOX', id: 'sandbox', type: 'enum', values: ['required', 'off'], builtin: 'required', soloMaintainer: 'off', order: 'tighter', perCall: true },
  { env: 'CQ_SANDBOX_BACKEND', id: 'sandbox.backend', type: 'enum', values: ['auto', 'landlock', 'bwrap', 'container', 'seatbelt', 'cc-native'], builtin: 'auto', order: 'unordered', perCall: true },
  { env: 'CQ_SANDBOX_NETWORK', id: 'sandbox.network', type: 'enum', values: ['model-only', 'allow'], builtin: 'model-only', soloMaintainer: 'allow', order: 'tighter', perCall: true },
  { env: 'CQ_RUN_TOOL', id: 'run.tool', type: 'enum', values: ['on', 'off'], builtin: 'on', order: 'tighter', perCall: true },
  { env: 'CQ_RUN_ENV_PASSTHROUGH', id: 'run.envPassthrough', type: 'list', values: [], builtin: '', order: 'unordered', perCall: true },
] as const satisfies readonly ConfigKey[];

export const CONFIG_SCHEMA = {
  version: 1,
  namespace: 'CQ_*',
  profileEnv: 'CQ_PROFILE',
  profiles: ['conservative', 'solo-maintainer'],
  keys: CONFIG_REGISTRY,
} as const;
