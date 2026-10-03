/** Pure RS-15 registry metadata. Runtime wiring is deliberately a later unit. */
export type ConfigType =
  | 'bool'
  | 'int'
  | 'ms'
  | 'usd'
  | 'enum'
  | 'list'
  | 'map'
  | 'bindings'
  | 'aliases'
  | 'string'
  | 'model'
  | 'path'
  | 'url'
  | 'argv'
  | 'window';
export type ConfigOrder =
  | 'true'
  | 'false'
  | 'smaller'
  | 'larger'
  | 'subset'
  | 'union'
  | 'unordered'
  | 'neutral'
  | 'limit'
  | 'none';
export interface ConfigKey {
  readonly env: string;
  readonly id: string;
  readonly domain: string;
  readonly type: ConfigType;
  readonly blank: string | null;
  readonly solo?: string;
  readonly order: ConfigOrder;
  readonly perCall: boolean;
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly secret?: boolean;
  readonly reserved?: boolean;
  readonly bounds?: Readonly<{ min?: number; max?: number }>;
  readonly layers: readonly ('default' | 'profile' | 'env' | 'call')[];
  readonly ci: 'vars' | 'secrets' | false;
  readonly outsideWorkspace: boolean;
  /** Exact HTTPS host used by this bundled provider's credential-bearing usage endpoint. */
  readonly usageEndpointHost?: string;
  readonly src: 'RS-15 Annex B';
  readonly doc: string;
}

const rows: readonly (readonly [
  string,
  string,
  ConfigType,
  string | null,
  string | undefined,
  ConfigOrder,
  boolean,
  values?: readonly string[],
])[] = [
  [
    'CQ_PROFILE',
    'profile',
    'enum',
    'conservative',
    undefined,
    'true',
    false,
    ['conservative', 'solo-maintainer'],
  ],
  [
    'CQ_MERGE_REQUIRE_HUMAN_APPROVAL',
    'merge.requireHumanApproval',
    'bool',
    'true',
    'false',
    'true',
    true,
  ],
  [
    'CQ_MERGE_ACCEPT_REVIEW_STATES',
    'merge.acceptReviewStates',
    'list',
    'APPROVED',
    'APPROVED,COMMENTED',
    'subset',
    true,
    ['APPROVED', 'COMMENTED'],
  ],
  ['CQ_MERGE_TRUSTED_BOTS', 'merge.trustedBots', 'list', null, 'coderabbitai[bot]', 'subset', true],
  [
    'CQ_MERGE_TRUSTED_ASSOCIATIONS',
    'merge.trustedAssociations',
    'list',
    'OWNER,MEMBER,COLLABORATOR',
    'OWNER,MEMBER,COLLABORATOR',
    'subset',
    false,
    ['OWNER', 'MEMBER', 'COLLABORATOR'],
  ],
  ['CQ_MERGE_SETTLE_MS', 'merge.settleMs', 'ms', '600000', '600000', 'larger', true],
  [
    'CQ_MERGE_PROTECTED_PATHS',
    'merge.protectedPaths',
    'enum',
    'human',
    'diff-check',
    'true',
    true,
    ['human', 'diff-check'],
  ],
  [
    'CQ_MERGE_BASE_BRANCH',
    'merge.baseBranch',
    'string',
    'merge-queue',
    undefined,
    'unordered',
    false,
  ],
  [
    'CQ_MERGE_PROTECTED_BRANCH',
    'merge.protectedBranch',
    'string',
    'main',
    undefined,
    'unordered',
    false,
  ],
  ['CQ_MERGE_EXCLUDED_LOGINS', 'merge.excludedLogins', 'list', null, undefined, 'union', false],
  ['CQ_EXTERNAL_INPUT', 'external.input', 'enum', 'ignore', 'ignore', 'none', false, ['ignore']],
  ['CQ_SANDBOX', 'sandbox', 'enum', 'required', 'off', 'true', true, ['required', 'off']],
  [
    'CQ_SANDBOX_BACKEND',
    'sandbox.backend',
    'enum',
    'auto',
    undefined,
    'unordered',
    true,
    ['auto', 'landlock', 'bwrap', 'container', 'seatbelt', 'cc-native'],
  ],
  [
    'CQ_SANDBOX_NETWORK',
    'sandbox.network',
    'enum',
    'model-only',
    'allow',
    'true',
    true,
    ['model-only', 'allow'],
  ],
  ['CQ_SANDBOX_PROXY_URL', 'sandbox.proxyUrl', 'url', null, undefined, 'none', false],
  ['CQ_RUN_TOOL', 'run.tool', 'enum', 'on', 'on', 'false', true, ['on', 'off']],
  ['CQ_RUN_ENV_PASSTHROUGH', 'run.envPassthrough', 'list', null, undefined, 'subset', true],
  ['CQ_RUN_COMMANDS', 'run.commands', 'list', null, undefined, 'subset', true],
  ['CQ_RUN_TIMEOUT_MS', 'run.timeoutMs', 'ms', '30000', undefined, 'smaller', true],
  ['CQ_BUDGET_ALLOW_ADVISORY', 'budget.allowAdvisory', 'bool', 'false', 'false', 'false', true],
  ['CQ_BUDGET_REQUIRE_CAP', 'budget.requireCap', 'bool', 'true', 'true', 'true', false],
  ['CQ_BUDGET_MAX_USD', 'budget.maxUsd', 'usd', null, undefined, 'limit', true],
  ['CQ_BUDGET_MAX_TOKENS', 'budget.maxTokens', 'int', null, undefined, 'limit', true],
  ['CQ_BUDGET_MIN_INNER_USD', 'budget.minInnerUsd', 'usd', '0.01', undefined, 'larger', true],
  ['CQ_BUDGET_MAX_DEFER_MS', 'budget.maxDeferMs', 'ms', '0', undefined, 'smaller', true],
  ['CQ_BUDGET_ZOMBIE_GRACE_MS', 'budget.zombieGraceMs', 'ms', '30000', undefined, 'smaller', true],
  ['CQ_BUDGET_INVOCATION_USD', 'budget.invocationUsd', 'usd', null, undefined, 'smaller', true],
  ['CQ_GOVERNOR_CONCURRENCY', 'governor.concurrency', 'int', '4', undefined, 'neutral', true],
  [
    'CQ_GOVERNOR_JOB_WALL_CLOCK_MS',
    'governor.jobWallClockMs',
    'ms',
    null,
    undefined,
    'limit',
    true,
  ],
  ['CQ_GOVERNOR_MAX_ATTEMPTS', 'governor.maxAttempts', 'int', null, undefined, 'limit', true],
  ['CQ_GOVERNOR_DISPATCH_QUOTA', 'governor.dispatchQuota', 'int', null, undefined, 'limit', true],
  [
    'CQ_GOVERNOR_IN_FLIGHT_CEILING',
    'governor.inFlightCeiling',
    'int',
    null,
    undefined,
    'limit',
    true,
  ],
  ['CQ_APPROVAL_SIGNERS', 'approval.signers', 'path', null, undefined, 'unordered', false],
  [
    'CQ_APPROVAL_LEDGER',
    'approval.ledger',
    'path',
    '$XDG_STATE_HOME/cq/approvals.ndjson',
    undefined,
    'neutral',
    false,
  ],
  ['CQ_APPROVAL_MAX_TTL_MS', 'approval.maxTtlMs', 'ms', '86400000', undefined, 'smaller', false],
  [
    'CQ_DRIVER_BINDINGS',
    'driver.bindings',
    'bindings',
    '*/zai:ai-sdk,*/anthropic:ai-sdk,*/openai:ai-sdk,*/deepseek:ai-sdk',
    '*/anthropic:claude-agent',
    'unordered',
    true,
  ],
  ['CQ_DRIVER_SERVED_ALIASES', 'driver.servedAliases', 'aliases', '', undefined, 'subset', true],
  [
    'CQ_DRIVER_SERVED_UNOBSERVED_OK',
    'driver.servedUnobservedOk',
    'list',
    null,
    undefined,
    'subset',
    true,
  ],
  [
    'CQ_DRIVER_SESSION_RETENTION',
    'driver.sessionRetention',
    'enum',
    null,
    undefined,
    'true',
    true,
    ['keep', 'reap-on-settle'],
  ],
  [
    'CQ_DRIVER_SESSIONS_DIR',
    'driver.sessionsDir',
    'path',
    '$TMPDIR/cq-harness/sessions',
    undefined,
    'neutral',
    true,
  ],
  [
    'CQ_DRIVER_SUBPROCESS_COMMAND',
    'driver.subprocess.command',
    'argv',
    '["claude"]',
    undefined,
    'unordered',
    false,
  ],
  [
    'CQ_DRIVER_SUBPROCESS_ROUTING',
    'driver.subprocess.routing',
    'path',
    '<default-routing-table>',
    undefined,
    'unordered',
    false,
  ],
  [
    'CQ_DRIVER_ACP_ENDPOINT',
    'driver.acp.endpoint',
    'enum',
    'zcode-acp-server',
    undefined,
    'unordered',
    false,
    ['zcode-acp-server', 'dsh-acp'],
  ],
  [
    'CQ_DRIVER_ACP_COMMAND',
    'driver.acp.command',
    'argv',
    '<endpoint-argv>',
    undefined,
    'unordered',
    false,
  ],
  ['CQ_DRIVER_ACP_ENV_NAMES', 'driver.acp.envNames', 'list', null, undefined, 'subset', false],
  ['CQ_JOURNAL_DIR', 'journal.dir', 'path', null, undefined, 'neutral', true],
  ['CQ_SELFHOST_MAX_USD', 'selfhost.maxUsd', 'usd', '1', undefined, 'smaller', true],
  [
    'CQ_SELFHOST_JOB_WALL_CLOCK_MS',
    'selfhost.jobWallClockMs',
    'ms',
    '300000',
    undefined,
    'smaller',
    true,
  ],
  [
    'CQ_SELFHOST_MODEL',
    'selfhost.model',
    'model',
    'zai/glm-5.3-flash',
    undefined,
    'unordered',
    true,
  ],
  ['CQ_GH_BIN', 'gh.bin', 'string', 'gh', undefined, 'unordered', false],
  ['CQ_GH_TIMEOUT_MS', 'gh.timeoutMs', 'ms', '600000', undefined, 'smaller', true],
  ['CQ_AUTOMATION_TOKEN', 'automation.token', 'string', null, undefined, 'none', false],
];

const staticKeys: readonly ConfigKey[] = rows.map(
  ([env, id, type, blank, solo, order, perCall, values]) => ({
    env,
    id,
    domain: id.split('.')[0]!,
    type,
    blank,
    order,
    perCall,
    ...(solo !== undefined ? { solo } : {}),
    ...(values ? { values } : {}),
    ...(env.endsWith('_TOKEN') ? { secret: true } : {}),
    ...(env === 'CQ_SANDBOX_PROXY_URL' ? { reserved: true } : {}),
    ...(env === 'CQ_RUN_TIMEOUT_MS'
      ? { min: 1_000, max: 1_800_000, bounds: { min: 1_000, max: 1_800_000 } }
      : {}),
    ...([
      'CQ_GOVERNOR_CONCURRENCY',
      'CQ_GOVERNOR_MAX_ATTEMPTS',
      'CQ_GOVERNOR_DISPATCH_QUOTA',
      'CQ_GOVERNOR_IN_FLIGHT_CEILING',
      'CQ_BUDGET_MAX_TOKENS',
    ].includes(env)
      ? { min: 1 }
      : {}),
    ...(env.endsWith('_MS') && !['CQ_BUDGET_MAX_DEFER_MS', 'CQ_RUN_TIMEOUT_MS'].includes(env)
      ? { min: 1 }
      : {}),
    ...(env.endsWith('_USD') && !['CQ_BUDGET_MAX_USD'].includes(env)
      ? { min: Number.MIN_VALUE }
      : {}),
    layers: env.endsWith('_TOKEN')
      ? ['env']
      : perCall
        ? ['default', 'profile', 'env', 'call']
        : ['default', 'profile', 'env'],
    ci: env.endsWith('_TOKEN')
      ? 'secrets'
      : ['path', 'argv'].includes(type) || ['CQ_GH_BIN', 'CQ_DRIVER_ACP_ENDPOINT'].includes(env)
        ? false
        : 'vars',
    outsideWorkspace: [
      'CQ_APPROVAL_SIGNERS',
      'CQ_APPROVAL_LEDGER',
      'CQ_DRIVER_SESSIONS_DIR',
      'CQ_DRIVER_SUBPROCESS_ROUTING',
    ].includes(env),
    src: 'RS-15 Annex B',
    doc: `RS-15 configuration key ${env}`,
  }),
);

export const PROVIDER_IDS = [
  'anthropic-api',
  'claude-subscription',
  'zai-glm-coding',
  'deepseek',
  'openai-api',
  'codex-chatgpt',
  'opencode-go',
] as const;
export const PROVIDER_KEYS = [
  'PROFILE',
  'LIMITS_KNOWN',
  'CAP_AMOUNT',
  'RPM',
  'PEAK_WINDOWS',
  'WINDOW_FRACTIONS',
  'QUOTA_ENDPOINT',
  'MAX_DEFER_MS',
] as const;
export const FOREIGN_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'ZAI_BASE_URL',
  'ZAI_ANTHROPIC_BASE_URL',
  'DEEPSEEK_ANTHROPIC_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'GH_REPO',
  'PATH',
] as const;
export const CALL_ONLY_CONFIG = {
  'budget.legacyJournal': { type: 'enum', values: ['reset'] },
  'budget.raiseCap': { type: 'bool' },
  'budget.ungovernedOverGoverned': { type: 'bool' },
  'budget.breakLock': { type: 'string' },
  'budget.releaseQuarantine': { type: 'list' },
  attended: { type: 'bool' },
} as const;
const providerMetadata: Readonly<
  Record<(typeof PROVIDER_KEYS)[number], readonly [ConfigType, string | null, ConfigOrder, boolean]>
> = {
  PROFILE: ['string', 'bundled', 'unordered', false],
  LIMITS_KNOWN: ['bool', 'false', 'false', false],
  CAP_AMOUNT: ['usd', null, 'smaller', false],
  RPM: ['int', null, 'smaller', false],
  PEAK_WINDOWS: ['window', null, 'larger', false],
  WINDOW_FRACTIONS: ['map', null, 'smaller', false],
  QUOTA_ENDPOINT: ['url', null, 'unordered', false],
  MAX_DEFER_MS: ['ms', null, 'smaller', false],
};
const providerUsageEndpointHosts: Readonly<Partial<Record<(typeof PROVIDER_IDS)[number], string>>> =
  {
    'opencode-go': 'opencode.ai',
    deepseek: 'api.deepseek.com',
  };
export function providerKeysFor(providerIds: readonly string[]): readonly ConfigKey[] {
  return providerIds.flatMap((providerId) =>
    PROVIDER_KEYS.map((suffix) => {
      const [type, blank, order, perCall] = providerMetadata[suffix];
      const id = providerId.toUpperCase().replaceAll('-', '_');
      return {
        env: `CQ_PROVIDER_${id}_${suffix}`,
        id: `provider.${providerId}.${suffix.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}`,
        domain: 'provider',
        type,
        blank,
        order,
        perCall,
        layers: ['default', 'profile', 'env'],
        ci: suffix === 'PROFILE' ? false : 'vars',
        outsideWorkspace: suffix === 'PROFILE',
        ...(suffix === 'QUOTA_ENDPOINT' &&
        providerUsageEndpointHosts[providerId as keyof typeof providerUsageEndpointHosts]
          ? {
              usageEndpointHost:
                providerUsageEndpointHosts[providerId as keyof typeof providerUsageEndpointHosts],
            }
          : {}),
        src: 'RS-15 Annex B',
        doc: `RS-15 provider key ${suffix}`,
      };
    }),
  );
}
const providerKeys: readonly ConfigKey[] = providerKeysFor(PROVIDER_IDS);
export const CONFIG_REGISTRY: readonly ConfigKey[] = [...staticKeys, ...providerKeys];
export const CONFIG_SCHEMA = Object.freeze({
  version: 1,
  namespace: 'CQ_*',
  profiles: ['conservative', 'solo-maintainer'],
  registry: CONFIG_REGISTRY,
  callOnly: CALL_ONLY_CONFIG,
  providerIds: PROVIDER_IDS,
  providerKeys: PROVIDER_KEYS,
  foreign: FOREIGN_ENV_NAMES,
});
