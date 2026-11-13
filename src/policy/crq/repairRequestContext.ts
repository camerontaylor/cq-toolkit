/**
 * Pure derivation of the C1 repair request context.
 *
 * Lifecycle position: after preparation has produced the prepared job and
 * before `planRepairDispatch` needs a `RepairRequestContext`. The Python
 * runtime builds this same context inline, in three places:
 *
 *   - `crq_repair.process_item` builds the pinned worktree path
 *     `<worktree_root>/crq-repair-<item>-<job>`;
 *   - `crq_repair.process` selects the rung role from
 *     `config.repair.roles` (`fixer` or `fixer_escalation`) and, for the
 *     escalation rung, appends `-A2` to the pinned worktree path;
 *   - `crq_repair._dispatch` gates the role driver and
 *     `crq_repair.drivers.cq.invoke` derives `repo`, `worktree`, `driver`
 *     (`role.model` split once on `/`) and `budget` (role overrides, base
 *     caps, the fixed 500000/200000 defaults and `int(wall_clock_min *
 *     60000)`).
 *
 * This module is that derivation and nothing else. It performs no git read,
 * no worktree creation, no directory creation, no config-file read (the
 * caller supplies the exact text), no clock read, no subprocess, no network
 * and no persistence. It returns the existing `RepairRequestContext` shape,
 * narrowed to the fields Python derives, so the later E2 dispatch slice can
 * compose `planRepairDispatch` from real values instead of a fixture.
 *
 * The worktree path is rendered exactly as Python renders it, including `..`
 * segments and slash-bearing ids; the prepared job/item values are
 * server-generated, and this module never creates or inspects that path.
 *
 * WHAT IS DELIBERATELY NOT DERIVED: `harness` and `promptOverride`. Python's
 * CQ harness constant is a different shape from the typed op's
 * `HarnessConfig`, and there is no Python prompt override. Both stay caller
 * owned. `pr` and the item body belong to the prepared job, not this context.
 *
 * STRICTNESS BEYOND THE PYTHON PAYLOAD: Python only fails when its inline
 * expressions fail (`KeyError`, `AttributeError`, `TypeError`, `ValueError`).
 * A few values it would serialise cannot satisfy the typed op's contract, so
 * this builder refuses them instead of forwarding them: an empty requested
 * role name, an empty or non-string repo, an empty provider/model part, a
 * non-positive or non-integer token cap, a non-finite or negative wall clock,
 * and an empty worktree root/item/job. Each has a fail-first test; none is
 * inferred from Python prose.
 *
 * The differential oracle is `apps/crq-python/repair_request_context_vectors.py`,
 * which records the production Python values and exceptions in
 * `apps/crq-python/fixtures/repair-request-context/cases.json`.
 */
import type { Budget, ModelSpec } from '../../driver/types.js';
import { JsonNumber, JsonObject, parseJsonValue, type JsonValue } from './jsonValue.js';
import type { RepairRequestContext } from './repairRequest.js';

/** Python's fixed CQ output-token cap when neither role nor base sets one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 500_000;
/** Python's fixed CQ context-token cap when neither role nor base sets one. */
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** Python `int(wall_clock_min * 60000)`. */
const WALL_CLOCK_MS_PER_MINUTE = 60_000;
/** The branch `cq.invoke` always sends for the pinned detached worktree. */
const DETACHED_BRANCH = 'detached';
/**
 * Python `process` appends `-A2` to the pinned worktree before dispatching the
 * `fixer_escalation` rung (`wt = Path(str(wt) + '-A2')`). The suffix is part of
 * the path `cq.invoke` sends, so the context must name it.
 */
const ESCALATION_ROLE_NAME = 'fixer_escalation';

/**
 * The local typed refusal vocabulary. These are precondition names, never
 * persisted and never matched as prose. They are not kernel statuses and not
 * worker failure classes.
 */
export type RepairRequestContextRefusal =
  | 'config-unreadable'
  | 'role-missing'
  | 'role-unknown'
  | 'role-invalid'
  | 'role-driver-unsupported'
  | 'budget-malformed'
  | 'repo-missing'
  | 'worktree-input-missing';

/** The pinned worktree inputs the prepared record already supplies. */
export interface PinnedRepairWorktreeInputs {
  /** The prepared job's `item` value (Python interpolates it into the path). */
  readonly item: string;
  /** The prepared job's `job` value (Python interpolates it into the path). */
  readonly job: string;
}

export interface BuildRepairRequestContextInput {
  /** Exact `config.json` text. The caller reads it; this module never does. */
  readonly configText: string;
  /** Role name to select from `config.repair.roles`, e.g. `fixer`. */
  readonly role: string;
  /** The prepared job's pinned-worktree values. */
  readonly pinned: PinnedRepairWorktreeInputs;
}

/** The three budget figures Python sends to `review.fixItem`. */
export interface DerivedRepairBudget extends Budget {
  readonly maxOutputTokens: number;
  readonly maxContextTokens: number;
  readonly wallClockMs: number;
}

/**
 * The derived context. It is assignable to `RepairRequestContext`; `harness`
 * and `promptOverride` remain caller owned and therefore absent here.
 */
export interface DerivedRepairRequestContext extends RepairRequestContext {
  readonly repo: string;
  readonly worktree: { readonly path: string; readonly branch: typeof DETACHED_BRANCH };
  readonly driver: ModelSpec;
  readonly budget: DerivedRepairBudget;
}

export type BuildRepairRequestContextResult =
  | { readonly ok: true; readonly value: DerivedRepairRequestContext }
  | { readonly ok: false; readonly refusal: RepairRequestContextRefusal };

function refusal(value: RepairRequestContextRefusal): BuildRepairRequestContextResult {
  return { ok: false, refusal: value };
}

function nonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Python `isinstance(value, int) and not isinstance(value, bool)` in range. */
function pythonInt(value: JsonValue | undefined): number | undefined {
  if (!(value instanceof JsonNumber) || value.kind !== 'int') return undefined;
  const integer = value.integer as bigint;
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(integer);
}

/** Python `int(minutes * 60000)` for a JSON int or float, without float drift. */
function wallClockMs(value: JsonValue | undefined): number | undefined {
  if (!(value instanceof JsonNumber)) return undefined;
  if (value.kind === 'int') {
    const minutes = value.integer as bigint;
    if (minutes < 0n) return undefined;
    const milliseconds = minutes * BigInt(WALL_CLOCK_MS_PER_MINUTE);
    if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(milliseconds);
  }
  const minutes = value.float as number;
  if (!Number.isFinite(minutes) || minutes < 0) return undefined;
  const milliseconds = minutes * WALL_CLOCK_MS_PER_MINUTE;
  if (!Number.isFinite(milliseconds) || milliseconds > Number.MAX_SAFE_INTEGER) return undefined;
  return Math.trunc(milliseconds);
}

/** Python `own.get(key, base.get(key, fallback))`, strict about the result. */
function tokenCap(
  own: JsonObject | undefined,
  base: JsonObject,
  key: 'max_output_tokens' | 'max_context_tokens',
  fallback: number,
): number | undefined {
  const value =
    own !== undefined && own.has(key) ? own.get(key) : base.has(key) ? base.get(key) : undefined;
  if (value === undefined) return fallback;
  const cap = pythonInt(value);
  if (cap === undefined || cap <= 0) return undefined;
  return cap;
}

/**
 * Python `PurePosixPath(root) / name` rendering. Python normalises repeated
 * separators and `.` segments, preserves a single or exactly-double leading
 * slash, keeps `..`, and treats an absolute name as the new base.
 */
function pythonPosixJoin(root: string, name: string): string {
  if (name.startsWith('/')) return normalisePosix(name);
  return normalisePosix(root.endsWith('/') ? `${root}${name}` : `${root}/${name}`);
}

function normalisePosix(value: string): string {
  let prefix = '';
  let rest = value;
  if (value.startsWith('//') && !value.startsWith('///')) {
    prefix = '//';
    rest = value.slice(2);
  } else if (value.startsWith('/')) {
    prefix = '/';
    rest = value.slice(1);
  }
  const parts = rest.split('/').filter((part) => part !== '' && part !== '.');
  return prefix + parts.join('/');
}

/**
 * Derive the exact request context Python builds for one prepared repair job.
 *
 * The order of refusals mirrors the production order: config and repair block,
 * pinned worktree inputs, role selection, driver gate, model split, repo, then
 * budget. A success value is a request input only; it is not dispatch
 * readiness, worktree existence or spend authorisation.
 */
export function buildRepairRequestContext(
  input: BuildRepairRequestContextInput,
): BuildRepairRequestContextResult {
  if (!nonEmptyString(input.role)) return refusal('role-missing');

  let document: JsonValue;
  try {
    document = parseJsonValue(input.configText);
  } catch {
    return refusal('config-unreadable');
  }
  if (!(document instanceof JsonObject)) return refusal('config-unreadable');
  const repair = document.get('repair');
  if (!(repair instanceof JsonObject)) return refusal('config-unreadable');

  const worktreeRoot = document.get('worktree_root');
  const item = input.pinned.item;
  const job = input.pinned.job;
  if (!nonEmptyString(worktreeRoot) || !nonEmptyString(item) || !nonEmptyString(job)) {
    return refusal('worktree-input-missing');
  }
  const worktreePath = pythonPosixJoin(worktreeRoot, `crq-repair-${item}-${job}`);

  const roles = repair.get('roles');
  if (!(roles instanceof JsonObject)) return refusal('role-unknown');
  const role = roles.get(input.role);
  if (!(role instanceof JsonObject)) return refusal('role-unknown');

  // Python mutates the pinned path for the escalation rung before dispatch.
  const dispatchedWorktreePath =
    input.role === ESCALATION_ROLE_NAME ? `${worktreePath}-A2` : worktreePath;

  const driverName = role.get('driver');
  if (driverName === undefined) return refusal('role-invalid');
  if (driverName !== 'cq') return refusal('role-driver-unsupported');

  const modelValue = role.get('model');
  if (typeof modelValue !== 'string') return refusal('role-invalid');
  const separator = modelValue.indexOf('/');
  if (separator <= 0 || separator === modelValue.length - 1) return refusal('role-invalid');
  const driver: ModelSpec = {
    provider: modelValue.slice(0, separator),
    model: modelValue.slice(separator + 1),
  };

  const repo = document.get('repo');
  if (!nonEmptyString(repo)) return refusal('repo-missing');

  const base = repair.get('budget');
  if (!(base instanceof JsonObject)) return refusal('budget-malformed');
  const ownBudget = role.has('budget') ? role.get('budget') : undefined;
  if (ownBudget !== undefined && !(ownBudget instanceof JsonObject)) {
    return refusal('budget-malformed');
  }
  const own = ownBudget instanceof JsonObject ? ownBudget : undefined;
  const maxOutputTokens = tokenCap(own, base, 'max_output_tokens', DEFAULT_MAX_OUTPUT_TOKENS);
  if (maxOutputTokens === undefined) return refusal('budget-malformed');
  const maxContextTokens = tokenCap(own, base, 'max_context_tokens', DEFAULT_MAX_CONTEXT_TOKENS);
  if (maxContextTokens === undefined) return refusal('budget-malformed');
  const milliseconds = wallClockMs(base.get('wall_clock_min'));
  if (milliseconds === undefined) return refusal('budget-malformed');

  return {
    ok: true,
    value: {
      repo,
      worktree: { path: dispatchedWorktreePath, branch: DETACHED_BRANCH },
      driver,
      budget: {
        maxOutputTokens,
        maxContextTokens,
        wallClockMs: milliseconds,
      },
    },
  };
}
