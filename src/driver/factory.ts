// The driver factory (ADR-0002 §2.5): role + provider → a constructed,
// wrapped lane instance. Ops resolve a DriverRequest here instead of
// constructing lane classes directly (the S4b migration deletes those
// construction sites); plan data never names a lane class.
//
// RESOLUTION RULES (frozen):
//   - DEFAULT BINDINGS ARE CONSERVATIVE: every role maps to lane 'ai-sdk'
//     for the default providers (zai / anthropic / openai / deepseek) — the
//     in-process lane with no host-CLI dependency. The subprocess,
//     claude-agent and acp lanes are NEVER defaults: a host-CLI or
//     vendor-process lane only runs when the deployment BINDS it.
//   - Configured bindings (role → provider → lane, '*' = any provider) win
//     over defaults; a provider that is neither a default provider nor bound
//     for the requested role is a DispatchError('config') — the factory
//     never silently falls back (a guessed lane is a wrong lane).
//   - DEPRECATED ALIAS: modelSpec.provider 'ai-sdk' (the self-host DRIVER
//     handle, review-debt #186) normalises to provider 'zai' on the SAME
//     lane, with a `cq:`-prefixed stderr notice. The resolved.modelSpec
//     carries the NORMALISED spec — ops put it on the invocation, so the
//     alias never reaches a lane or a journal. Removed next major.
//   - WRAPPER ORDER, innermost first: the lane, then the reap-on-settle
//     wrapper (when requested), then the served-model assertion outermost.
//     Both inner wrappers forward the `RunOptions` second parameter
//     unchanged (a dropping wrapper compiles and silently kills
//     cancellation; conformance leg b-v catches that).
//   - SESSION RETENTION: 'keep' (the default) wraps nothing — session
//     records are worker evidence. 'reap-on-settle' deletes, after the run
//     settles WHATEVER the verdict, ONLY the FRESH record that run created:
//     the run created a record iff it resolved with a sessionId AND the
//     invocation carried NO sessionRef. A sessionRef-resumed record is
//     NEVER reaped (it predates the run and may carry later turns).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpDriver } from './acp/index.js';
import type { AcpDriverOptions } from './acp/index.js';
import { AiSdkDriver } from './ai-sdk/index.js';
import type { AiSdkDriverOptions } from './ai-sdk/index.js';
import { ClaudeAgentDriver } from './claude-agent/index.js';
import type { ClaudeAgentDriverOptions } from './claude-agent/index.js';
import { DispatchError } from './errors.js';
import type { PerMillionRates } from './pricing/index.js';
import { withServedModelAssertion } from './served-model.js';
import type { LaneId, ServedModelPolicy } from './served-model.js';
import { SubprocessDriver } from './subprocess/index.js';
import type { SubprocessDriverOptions } from './subprocess/index.js';
import type { Driver, ModelSpec, WorkerResult } from './types.js';
import type { HarnessConfig } from '../harness/config.js';
import { SessionStore } from '../harness/session.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Why a worker is being dispatched. The four shipped roles are frozen
 * vocabulary; the `(string & {})` keeps literal completion while admitting
 * deployment-defined roles.
 */
export type WorkerRole =
  | 'fixer'
  | 'conflict-resolver'
  | 'remediator'
  | 'classifier'
  | (string & {});

/** One dispatch request: the role, the model, and per-run wrapping knobs. */
export interface DriverRequest {
  role: WorkerRole;
  modelSpec: ModelSpec;
  /** The harness the lane binds its tool surface to (where the lane accepts one). Default: defaultHarnessConfig. */
  harness?: HarnessConfig;
  /**
   * Session-record retention for this run (§2.5): 'keep' (the default) keeps
   * the record; 'reap-on-settle' deletes the FRESH record this run created
   * once the run settles, whatever the verdict.
   */
  sessionRetention?: 'keep' | 'reap-on-settle';
}

/** The resolved, constructed, wrapped driver plus the facts it resolved on. */
export interface ResolvedDriver {
  readonly driver: Driver;
  readonly lane: LaneId;
  /** The spec the lane/invocation must carry: the provider alias is already normalised away. */
  readonly modelSpec: ModelSpec;
}

/** The factory seam: resolve a request to a driver. Throws, never falls back. */
export interface DriverFactory {
  resolve(request: DriverRequest): ResolvedDriver;
}

/** Plan-data construction knobs for the subprocess lane (its serializable option subset). */
export type SubprocessLaneConfig = Pick<
  SubprocessDriverOptions,
  'binary' | 'routingTable' | 'termGraceMs' | 'killGraceMs' | 'envAllowlist' | 'sessionsDir'
>;

/** Plan-data construction knobs for the acp lane (its serializable option subset). */
export type AcpLaneConfig = Pick<
  AcpDriverOptions,
  | 'command'
  | 'endpoint'
  | 'endpointTable'
  | 'envNames'
  | 'modelEnv'
  | 'workspaceRoot'
  | 'termGraceMs'
  | 'killGraceMs'
  | 'cancelWriteGraceMs'
  | 'sessionsDir'
>;

/** Plan-data construction knobs for the claude-agent lane (its serializable option subset). */
export type ClaudeAgentLaneConfig = Pick<
  ClaudeAgentDriverOptions,
  'endpointTable' | 'envAllowlist' | 'sessionsDir'
>;

/**
 * Construction knobs for the ai-sdk lane. `providers` is an in-process
 * factory registry — constructor DATA of a hosted deployment (never plan
 * JSON: it is not serializable), and the injection seam that keeps factory
 * tests offline.
 */
export type AiSdkLaneConfig = Pick<
  AiSdkDriverOptions,
  'providers' | 'sandboxConfig' | 'sessionsDir'
>;

/** Factory configuration — plain data a deployment composes (never plan JSON). */
export interface DriverFactoryConfig {
  /** Role → provider → lane overrides ('*' = any provider). Absent roles fall back to the conservative defaults. */
  bindings?: Readonly<Record<string, Readonly<Record<string, LaneId>>>>;
  /** Sessions directory for the backing SessionStore, when a lane config does not name its own. */
  sessionsDir?: string;
  /** Price lookup carried into lane construction (every lane accepts one) for the derived-only costUSD rule. */
  pricing?: (spec: ModelSpec) => PerMillionRates | undefined;
  /** Per-lane served-model policy for the assertion wrapper (ADR-0002 §2.6). */
  servedModel?: ServedModelPolicy;
  /** Per-lane construction knobs. */
  lanes?: {
    subprocess?: SubprocessLaneConfig;
    acp?: AcpLaneConfig;
    claudeAgent?: ClaudeAgentLaneConfig;
    aiSdk?: AiSdkLaneConfig;
  };
}

// ---------------------------------------------------------------------------
// Defaults + helpers
// ---------------------------------------------------------------------------

/** The providers the conservative default binding serves (lane 'ai-sdk'). */
const DEFAULT_PROVIDERS: readonly string[] = ['zai', 'anthropic', 'openai', 'deepseek'];

/** The default lane for the default providers — the in-process lane. */
const DEFAULT_LANE: LaneId = 'ai-sdk';

/**
 * Mirrors every lane's private `defaultSessionsDir()` (they all share it):
 * the effective dir when neither the lane config nor the factory names one.
 */
const DEFAULT_SESSIONS_DIR = join(tmpdir(), 'cq-harness', 'sessions');

/**
 * Resolve the lane for a (role, provider) pair: configured bindings win
 * (exact provider, then the '*' wildcard), then the conservative default —
 * else a DispatchError('config') naming both. Never a silent fallback.
 */
function laneForRole(
  role: WorkerRole,
  provider: string,
  bindings: DriverFactoryConfig['bindings'],
): LaneId {
  const byRole = bindings?.[role];
  const configured =
    byRole !== undefined && Object.prototype.hasOwnProperty.call(byRole, provider)
      ? byRole[provider]
      : byRole?.['*'];
  if (configured !== undefined) return configured;
  if (DEFAULT_PROVIDERS.includes(provider)) return DEFAULT_LANE;
  throw new DispatchError(
    'config',
    `driver factory: no lane binding for role '${role}' on provider '${provider}' — bind it in DriverFactoryConfig.bindings ('${provider}' is not a default provider, and the factory never falls back)`,
  );
}

/** The lane-config sessionsDir override, else the factory's, else the lanes' shared default. */
function sessionsDirFor(lane: LaneId, config: DriverFactoryConfig): string {
  const laneDir =
    lane === 'subprocess'
      ? config.lanes?.subprocess?.sessionsDir
      : lane === 'claude-agent'
        ? config.lanes?.claudeAgent?.sessionsDir
        : lane === 'acp'
          ? config.lanes?.acp?.sessionsDir
          : config.lanes?.aiSdk?.sessionsDir;
  return laneDir ?? config.sessionsDir ?? DEFAULT_SESSIONS_DIR;
}

/**
 * Construct the bare lane instance for one request from the factory's
 * plan-data knobs. Constructors are INERT (no env reads, no spawns); a bad
 * knob surfaces at construction, a bad secret only at run() — the lanes'
 * own fail-loud rules. The harness and pricing ride through where the lane
 * accepts them.
 */
function constructLane(lane: LaneId, request: DriverRequest, config: DriverFactoryConfig): Driver {
  const sessionsDir = sessionsDirFor(lane, config);
  const harness = request.harness !== undefined ? { harnessConfig: request.harness } : {};
  const pricing = config.pricing !== undefined ? { pricing: config.pricing } : {};
  switch (lane) {
    case 'subprocess': {
      const cfg = config.lanes?.subprocess;
      return new SubprocessDriver({
        ...(cfg?.binary !== undefined ? { binary: cfg.binary } : {}),
        ...(cfg?.routingTable !== undefined ? { routingTable: cfg.routingTable } : {}),
        ...(cfg?.termGraceMs !== undefined ? { termGraceMs: cfg.termGraceMs } : {}),
        ...(cfg?.killGraceMs !== undefined ? { killGraceMs: cfg.killGraceMs } : {}),
        ...(cfg?.envAllowlist !== undefined ? { envAllowlist: cfg.envAllowlist } : {}),
        sessionsDir,
        ...harness,
        ...pricing,
      });
    }
    case 'claude-agent': {
      const cfg = config.lanes?.claudeAgent;
      return new ClaudeAgentDriver({
        ...(cfg?.endpointTable !== undefined ? { endpointTable: cfg.endpointTable } : {}),
        ...(cfg?.envAllowlist !== undefined ? { envAllowlist: cfg.envAllowlist } : {}),
        sessionsDir,
        ...harness,
        ...pricing,
      });
    }
    case 'ai-sdk': {
      const cfg = config.lanes?.aiSdk;
      return new AiSdkDriver({
        ...(cfg?.providers !== undefined ? { providers: cfg.providers } : {}),
        ...(cfg?.sandboxConfig !== undefined ? { sandboxConfig: cfg.sandboxConfig } : {}),
        sessionsDir,
        ...harness,
        ...pricing,
      });
    }
    case 'acp': {
      const cfg = config.lanes?.acp;
      return new AcpDriver({
        ...(cfg?.command !== undefined ? { command: cfg.command } : {}),
        ...(cfg?.endpoint !== undefined ? { endpoint: cfg.endpoint } : {}),
        ...(cfg?.endpointTable !== undefined ? { endpointTable: cfg.endpointTable } : {}),
        ...(cfg?.envNames !== undefined ? { envNames: cfg.envNames } : {}),
        ...(cfg?.modelEnv !== undefined ? { modelEnv: cfg.modelEnv } : {}),
        ...(cfg?.workspaceRoot !== undefined ? { workspaceRoot: cfg.workspaceRoot } : {}),
        ...(cfg?.termGraceMs !== undefined ? { termGraceMs: cfg.termGraceMs } : {}),
        ...(cfg?.killGraceMs !== undefined ? { killGraceMs: cfg.killGraceMs } : {}),
        ...(cfg?.cancelWriteGraceMs !== undefined
          ? { cancelWriteGraceMs: cfg.cancelWriteGraceMs }
          : {}),
        sessionsDir,
        // The acp lane takes no harness config (its knobs are command +
        // workspaceRoot); pricing still rides through.
        ...pricing,
      });
    }
  }
}

/**
 * The reap-on-settle wrapper (§2.5): after the run settles — WHATEVER the
 * verdict — delete ONLY the FRESH record that run created. The run created
 * a record iff it resolved with a `sessionId` AND the invocation carried NO
 * `sessionRef`; a sessionRef-resumed record predates the run and is never
 * reaped. Cleanup is best-effort: a reap failure is swallowed, the verdict
 * outranks it (the same posture as the lanes' persistence).
 */
function withReapOnSettle(driver: Driver, sessionsDir: string): Driver {
  return {
    async run(invocation, options): Promise<WorkerResult> {
      const result = await driver.run(invocation, options);
      if (invocation.sessionRef === undefined && result.sessionId !== undefined) {
        try {
          await new SessionStore(sessionsDir).remove(result.sessionId);
        } catch {
          // deliberately swallowed — the verdict outranks the cleanup
        }
      }
      return result;
    },
  };
}

/** Create a driver factory over the given (optional) configuration. */
export function createDriverFactory(config: DriverFactoryConfig = {}): DriverFactory {
  return {
    resolve(request: DriverRequest): ResolvedDriver {
      // Deprecated provider alias (review-debt #186): normalise FIRST, so
      // the alias never reaches a binding lookup, a lane, or a journal.
      let provider = request.modelSpec.provider;
      let modelSpec = request.modelSpec;
      if (provider === 'ai-sdk') {
        process.stderr.write(
          "cq: modelSpec.provider 'ai-sdk' is deprecated and is removed in the next major — it now means the 'ai-sdk' lane on provider 'zai'; put the normalised spec (provider 'zai') on the invocation\n",
        );
        provider = 'zai';
        modelSpec = { ...modelSpec, provider: 'zai' };
      }
      const lane = laneForRole(request.role, provider, config.bindings);
      const inner = constructLane(lane, request, config);
      const reaping =
        request.sessionRetention === 'reap-on-settle'
          ? withReapOnSettle(inner, sessionsDirFor(lane, config))
          : inner;
      return {
        driver: withServedModelAssertion(reaping, {
          lane,
          ...(config.servedModel !== undefined ? { policy: config.servedModel } : {}),
        }),
        lane,
        modelSpec,
      };
    },
  };
}
