// github-settings — the pure half of the D13 settings drift check (W1.10;
// ADR-0004 D-I, RS-11 branch matrix). policy/templates/github-settings.json
// is the TARGET state of the repository's GitHub settings; this module
// renders it (App ids substituted) and compares it with the live settings
// that scripts/github-settings-drift.mjs reads through `gh api`.
//
// Pure functions only: no process, fs or network access here, so the
// vitest suite covers every drift class without a token. The CLI assembles
// a LiveSettings object (typedef below) from the API reads and prints the
// returned drift and notice lines.
//
// Comparison rules:
// - Server-only fields (id, node_id, _links, created_at, updated_at,
//   source, source_type, current_user_can_bypass) are never compared: only
//   the fields the settings file names are.
// - Order never matters: ref_name include/exclude, rules (by type), bypass
//   actors (by actor_type, actor_id), required status checks (by context),
//   allowed_events and allowed_merge_methods are compared as sorted sets.
// - A rule parameter present live but absent from the file is ignored only
//   when its value is a default (false, 0, '', null, []), so a GitHub API
//   that grows a new default-off parameter is not drift, while one turned
//   ON outside this file is.
// - Anything named in the file that is missing live is drift; rulesets,
//   environments and Actions event policies present live but absent from
//   the file are drift too (an unlisted environment would escape the
//   secret allowlist; GitHub auto-creates an environment on first use).
// - Environment protection: prevent_self_review and wait_timer are pinned
//   per environment; a protection rule of any type the file cannot express
//   (anything but required_reviewers, wait_timer, branch_policy — e.g. a
//   custom deployment protection rule) is drift.
// - Output is deterministic: fixed section order, names sorted.

const PLACEHOLDERS = Object.freeze({
  verdictAppId: '{{VERDICT_APP_ID}}',
  promoterAppId: '{{PROMOTER_APP_ID}}',
});

/**
 * Parse a GitHub App id: a positive safe integer, given as a number or a
 * decimal string. Throws on anything else.
 * @param {string} label
 * @param {unknown} value
 * @returns {number}
 */
function appId(label, value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id)) throw new Error(`${label} is out of range: ${text}`);
  return id;
}

/**
 * Render the settings template: each QUOTED placeholder ("{{VERDICT_APP_ID}}",
 * "{{PROMOTER_APP_ID}}") becomes the numeric id literal. Throws on an invalid
 * id, on any leftover `{{`, on invalid JSON and on an unknown schemaVersion.
 * @param {string} templateText
 * @param {{ verdictAppId: unknown, promoterAppId: unknown }} ids
 * @returns {Record<string, any>}
 */
export function renderSettings(templateText, ids) {
  let text = templateText;
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    const id = appId(key, /** @type {Record<string, unknown>} */ (ids)[key]);
    text = text.split(JSON.stringify(placeholder)).join(String(id));
  }
  const leftover = /\{\{[^"]*/.exec(text);
  if (leftover !== null) {
    throw new Error(`github-settings: unrendered placeholder ${JSON.stringify(leftover[0])}`);
  }
  const settings = JSON.parse(text);
  if (settings === null || typeof settings !== 'object' || settings.schemaVersion !== 1) {
    throw new Error('github-settings: schemaVersion must be 1');
  }
  return settings;
}

/**
 * @typedef {object} LiveEnvironment
 * @property {{ protected_branches: boolean, custom_branch_policies: boolean } | null} deployment_branch_policy
 *   The environment's `deployment_branch_policy` (null = all branches).
 * @property {{ name: string, type: string }[]} branch_policies
 *   From `environments/{name}/deployment-branch-policies` ([] when
 *   custom_branch_policies is off).
 * @property {boolean} can_admins_bypass
 * @property {Reviewer[]} reviewers
 *   The `required_reviewers` protection rule's reviewers, normalized by
 *   environmentFromApi ([] when there is no such rule).
 * @property {boolean} prevent_self_review
 *   The `required_reviewers` rule's `prevent_self_review` (false when there
 *   is no such rule).
 * @property {number} wait_timer
 *   The `wait_timer` rule's minutes (0 when there is no such rule).
 * @property {string[]} other_rules
 *   The type of every protection rule other than `required_reviewers`,
 *   `wait_timer` and `branch_policy` (e.g. a custom deployment protection
 *   rule) — sorted; the target has none, so any entry is drift.
 * @property {string[]} secrets  `environments/{name}/secrets` → `.secrets[].name`.
 */

/**
 * @typedef {{ type: string, login?: string, slug?: string, id?: number }} Reviewer
 */

/**
 * @typedef {object} LiveSettings
 * @property {Record<string, any>[]} rulesets
 *   Every repository ruleset, each read in full by id (`rulesets/{id}`).
 * @property {Record<string, Record<string, any> | null>} classicBranchProtection
 *   Branch → its `branches/{b}/protection` body, or null for a 404
 *   "Branch not protected". Holds (at least) the file's branches.
 * @property {Record<string, LiveEnvironment>} environments
 *   Every live environment, by name.
 * @property {string[]} repositorySecrets  `actions/secrets` → `.secrets[].name`.
 * @property {{ default_workflow_permissions?: string, can_approve_pull_request_reviews?: boolean }} actions
 *   `actions/permissions/workflow`.
 * @property {Record<string, any>[] | null} actionsEventPolicies
 *   Every Actions policy, each read in full by id (`actions/policies/{id}`);
 *   null = UNCHECKED (the list read was refused with HTTP 403: GitHub gates
 *   it behind Administration: write). Unchecked is neither matching nor
 *   absent: it yields a notice, never a drift line or a pass.
 */

/**
 * Normalize one reviewer entry of a `required_reviewers` protection rule
 * (`{type, reviewer: {login|slug, id}}`) to `{type, login}` (User),
 * `{type, slug}` (Team) or `{type, id}`.
 * @param {Record<string, any>} entry
 * @returns {Reviewer}
 */
function reviewerFromApi(entry) {
  const type = String(entry?.type ?? 'unknown');
  const who = entry?.reviewer ?? {};
  if (type === 'User' && typeof who.login === 'string') return { type, login: who.login };
  if (type === 'Team' && typeof who.slug === 'string') return { type, slug: who.slug };
  return { type, id: who.id };
}

/** The protection-rule types the comparator models; any other type is drift. */
const MODELED_RULE_TYPES = Object.freeze(['required_reviewers', 'wait_timer', 'branch_policy']);

/**
 * Assemble one LiveEnvironment from the environment object
 * (`environments/{name}` or an entry of `environments`), its
 * deployment-branch-policies list and its secret names.
 * @param {Record<string, any>} env
 * @param {Record<string, any>[]} branchPolicies
 * @param {string[]} secretNames
 * @returns {LiveEnvironment}
 */
export function environmentFromApi(env, branchPolicies, secretNames) {
  const dbp = env.deployment_branch_policy;
  const rules = Array.isArray(env.protection_rules) ? env.protection_rules : [];
  const reviewerRules = rules.filter((rule) => rule?.type === 'required_reviewers');
  const reviewers = reviewerRules
    .flatMap((rule) => (Array.isArray(rule.reviewers) ? rule.reviewers : []))
    .map(reviewerFromApi);
  // Any rule saying `true` wins: a self-review ban is never hidden by a
  // second rule. A malformed value is kept as-is so it shows as drift.
  const prevent = reviewerRules.map((rule) => rule.prevent_self_review);
  const preventSelfReview = prevent.includes(true)
    ? true
    : (prevent.find((value) => value !== false && value !== undefined) ?? false);
  const timers = rules.filter((rule) => rule?.type === 'wait_timer').map((rule) => rule.wait_timer);
  const waitTimer = timers.find((value) => value !== 0) ?? 0;
  const otherRules = rules
    .map((rule) => String(rule?.type ?? 'unknown'))
    .filter((type) => !MODELED_RULE_TYPES.includes(type))
    .sort(byString);
  return {
    deployment_branch_policy:
      dbp === null || dbp === undefined
        ? null
        : {
            protected_branches: dbp.protected_branches,
            custom_branch_policies: dbp.custom_branch_policies,
          },
    branch_policies: branchPolicies.map((p) => ({ name: p.name, type: p.type })),
    can_admins_bypass: env.can_admins_bypass,
    reviewers,
    prevent_self_review: preventSelfReview,
    wait_timer: waitTimer,
    other_rules: otherRules,
    secrets: [...secretNames],
  };
}

// ---------------------------------------------------------------------------
// Canonical forms

/** Byte order compare, locale-free. */
function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stable JSON: object keys sorted recursively; `undefined` shown as absent.
 * @param {unknown} value
 * @returns {string}
 */
function canon(value) {
  if (value === undefined) return 'absent';
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value).sort(byString)) {
    if (value[key] !== undefined) out[key] = sortKeys(value[key]);
  }
  return out;
}

/** A sorted copy of an array of canonical items (non-arrays pass through). */
function sortedSet(value) {
  if (!Array.isArray(value)) return value;
  return [...value].sort((a, b) => byString(canon(a), canon(b)));
}

/** Sort every array inside a conditions object (ref_name/workflow_path include/exclude). */
function normalizeConditions(conditions) {
  if (conditions === null || typeof conditions !== 'object') return conditions;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, sub] of Object.entries(conditions)) {
    if (sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
      /** @type {Record<string, unknown>} */
      const inner = {};
      for (const [k, v] of Object.entries(sub)) inner[k] = sortedSet(v);
      out[key] = inner;
    } else {
      out[key] = sortedSet(sub);
    }
  }
  return out;
}

function normalizeBypass(actors) {
  if (!Array.isArray(actors)) return actors;
  return actors
    .map((a) => ({ actor_id: a?.actor_id, actor_type: a?.actor_type, bypass_mode: a?.bypass_mode }))
    .sort(
      (a, b) =>
        byString(String(a.actor_type), String(b.actor_type)) ||
        byString(String(a.actor_id), String(b.actor_id)),
    );
}

function isDefaultValue(value) {
  return (
    value === false ||
    value === 0 ||
    value === '' ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// ---------------------------------------------------------------------------
// Comparators (each pushes lines onto `drift`)

/**
 * @param {string} prefix
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string[]} drift
 */
function compareRequiredChecks(prefix, expected, actual, drift) {
  const exp = Array.isArray(expected) ? expected : [];
  const act = Array.isArray(actual) ? actual : [];
  if (!Array.isArray(actual)) {
    drift.push(
      `${prefix}: required_status_checks differ: expected ${canon(expected)} actual ${canon(actual)}`,
    );
    return;
  }
  /** @type {Map<string, Record<string, any>>} */
  const live = new Map();
  for (const check of act) {
    if (live.has(check?.context))
      drift.push(`${prefix}: required check ${check?.context} listed twice`);
    live.set(check?.context, check);
  }
  const wanted = new Set(exp.map((c) => c.context));
  for (const check of [...exp].sort((a, b) => byString(a.context, b.context))) {
    const got = live.get(check.context);
    if (got === undefined) {
      drift.push(
        `${prefix}: required check ${check.context} (integration_id ${check.integration_id}) missing`,
      );
    } else if (got.integration_id !== check.integration_id) {
      drift.push(
        `${prefix}: required check ${check.context}: integration_id differs: expected ${canon(check.integration_id)} actual ${canon(got.integration_id)}`,
      );
    }
  }
  for (const context of [...live.keys()].sort(byString)) {
    if (!wanted.has(context)) {
      drift.push(`${prefix}: required check ${context} present live but not in the settings file`);
    }
  }
}

/**
 * @param {string} prefix  e.g. `ruleset cq-r2-merge-queue: rule pull_request`
 * @param {Record<string, any> | undefined} expected
 * @param {Record<string, any> | undefined} actual
 * @param {string[]} drift
 */
function compareParameters(prefix, expected, actual, drift) {
  const exp = expected ?? {};
  const act = actual ?? {};
  const keys = [...new Set([...Object.keys(exp), ...Object.keys(act)])].sort(byString);
  for (const key of keys) {
    const e = exp[key];
    const a = act[key];
    if (e === undefined && isDefaultValue(a)) continue;
    if (key === 'required_status_checks') {
      compareRequiredChecks(prefix, e, a, drift);
      continue;
    }
    if (isStringArray(e) && isStringArray(a)) {
      const missing = e.filter((v) => !a.includes(v)).sort(byString);
      const extra = a.filter((v) => !e.includes(v)).sort(byString);
      if (missing.length > 0 || extra.length > 0) {
        drift.push(
          `${prefix}: parameter ${key} differs: missing ${canon(missing)} extra ${canon(extra)}`,
        );
      }
      continue;
    }
    if (canon(sortedSet(e)) !== canon(sortedSet(a))) {
      drift.push(`${prefix}: parameter ${key} differs: expected ${canon(e)} actual ${canon(a)}`);
    }
  }
}

/**
 * @param {string} prefix
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string[]} drift
 */
function compareRules(prefix, expected, actual, drift) {
  if (!Array.isArray(actual)) {
    drift.push(`${prefix}: rules differ: expected ${canon(expected)} actual ${canon(actual)}`);
    return;
  }
  const exp = Array.isArray(expected) ? expected : [];
  /** @type {Map<string, Record<string, any>>} */
  const live = new Map();
  for (const rule of actual) {
    if (live.has(rule?.type)) drift.push(`${prefix}: rule ${rule?.type} listed twice`);
    live.set(rule?.type, rule);
  }
  const wanted = new Set(exp.map((r) => r.type));
  for (const rule of [...exp].sort((a, b) => byString(a.type, b.type))) {
    const got = live.get(rule.type);
    if (got === undefined) drift.push(`${prefix}: rule ${rule.type} missing`);
    else compareParameters(`${prefix}: rule ${rule.type}`, rule.parameters, got.parameters, drift);
  }
  for (const type of [...live.keys()].sort(byString)) {
    if (!wanted.has(type))
      drift.push(`${prefix}: rule ${type} present live but not in the settings file`);
  }
}

/**
 * @param {string} prefix
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string[]} drift
 */
function compareBypass(prefix, expected, actual, drift) {
  if (actual === undefined || actual === null) {
    drift.push(
      `${prefix}: bypass_actors unreadable (the reading token needs ruleset admin read) — expected ${canon(normalizeBypass(expected))}`,
    );
    return;
  }
  const exp = normalizeBypass(expected ?? []);
  const act = normalizeBypass(actual);
  if (canon(exp) !== canon(act)) {
    drift.push(`${prefix}: bypass_actors differ: expected ${canon(exp)} actual ${canon(act)}`);
  }
  for (const actor of Array.isArray(act) ? act : []) {
    if (actor.bypass_mode === 'exempt') {
      drift.push(
        `${prefix}: bypass actor ${actor.actor_type} ${actor.actor_id} has bypass_mode "exempt"; it must be "always" (an exempt bypass leaves no audit entry)`,
      );
    }
  }
}

/**
 * Compare one ruleset-shaped object (repository ruleset or Actions policy).
 * @param {string} prefix
 * @param {Record<string, any>} expected
 * @param {Record<string, any>} actual
 * @param {string[]} drift
 */
function compareRuleObject(prefix, expected, actual, drift) {
  for (const field of ['target', 'enforcement']) {
    if (expected[field] !== undefined && expected[field] !== actual[field]) {
      drift.push(
        `${prefix}: ${field} differs: expected ${canon(expected[field])} actual ${canon(actual[field])}`,
      );
    }
  }
  const expCond = normalizeConditions(expected.conditions ?? null);
  const actCond = normalizeConditions(actual.conditions ?? null);
  if (canon(expCond) !== canon(actCond)) {
    drift.push(`${prefix}: conditions differ: expected ${canon(expCond)} actual ${canon(actCond)}`);
  }
  compareRules(prefix, expected.rules, actual.rules, drift);
  // Actions policies carry no bypass list in the file: compare only when
  // the file names one or the live object has one.
  if (expected.bypass_actors !== undefined || actual.bypass_actors !== undefined) {
    compareBypass(prefix, expected.bypass_actors ?? [], actual.bypass_actors, drift);
  }
}

/** The notice for an event policy the credential could not read (HTTP 403). */
export const ACTIONS_EVENT_POLICY_UNCHECKED =
  'actions event policy unchecked: GitHub requires Administration: write to read it; the CI drift credential is read-only by design — run the drift check with an owner/admin credential to cover it';

/**
 * Compare a list of named ruleset-shaped objects by `name`.
 * @param {string} kind  `ruleset` | `actions event policy`
 * @param {Record<string, any>[]} expected
 * @param {Record<string, any>[]} actual
 * @param {string[]} drift
 */
function compareNamed(kind, expected, actual, drift) {
  /** @type {Map<string, Record<string, any>>} */
  const live = new Map();
  for (const item of actual) {
    if (live.has(item?.name)) drift.push(`${kind} ${item?.name}: present twice live`);
    live.set(item?.name, item);
  }
  const wanted = new Set(expected.map((item) => item.name));
  for (const item of [...expected].sort((a, b) => byString(a.name, b.name))) {
    const got = live.get(item.name);
    if (got === undefined) drift.push(`${kind} ${item.name}: missing`);
    else compareRuleObject(`${kind} ${item.name}`, item, got, drift);
  }
  for (const name of [...live.keys()].sort((a, b) => byString(String(a), String(b)))) {
    if (!wanted.has(name)) drift.push(`${kind} ${name}: present live but not in the settings file`);
  }
}

/**
 * @param {string} name
 * @param {Record<string, any>} expected
 * @param {LiveEnvironment} actual
 * @param {string[]} drift
 * @param {string[]} notices
 */
function compareEnvironment(name, expected, actual, drift, notices) {
  const prefix = `environment ${name}`;
  const expDbp = expected.deployment_branch_policy;
  const actDbp = actual.deployment_branch_policy;
  if (canon(expDbp) !== canon(actDbp)) {
    const t19 =
      actDbp?.protected_branches === true
        ? ' (protected_branches admits any protected branch, e.g. merge-queue: ADR-0004 D-D.1)'
        : '';
    drift.push(
      `${prefix}: deployment_branch_policy differs: expected ${canon(expDbp)} actual ${canon(actDbp)}${t19}`,
    );
  }
  const expPolicies = (expected.branch_policies ?? []).map((p) =>
    canon({ name: p.name, type: p.type }),
  );
  const actPolicies = (actual.branch_policies ?? []).map((p) =>
    canon({ name: p.name, type: p.type }),
  );
  for (const p of expPolicies.filter((x) => !actPolicies.includes(x)).sort(byString)) {
    drift.push(`${prefix}: deployment branch policy ${p} missing`);
  }
  for (const p of actPolicies.filter((x) => !expPolicies.includes(x)).sort(byString)) {
    drift.push(
      `${prefix}: deployment branch policy ${p} present live but not in the settings file`,
    );
  }
  if (expected.can_admins_bypass !== actual.can_admins_bypass) {
    drift.push(
      `${prefix}: can_admins_bypass differs: expected ${canon(expected.can_admins_bypass)} actual ${canon(actual.can_admins_bypass)}`,
    );
  }
  for (const key of ['prevent_self_review', 'wait_timer']) {
    if (canon(expected[key]) !== canon(actual[key])) {
      drift.push(
        `${prefix}: ${key} differs: expected ${canon(expected[key])} actual ${canon(actual[key])}`,
      );
    }
  }
  for (const type of actual.other_rules ?? []) {
    drift.push(
      `${prefix}: protection rule of type ${JSON.stringify(type)} present live (the target has no custom deployment protection rules)`,
    );
  }
  if (expected.reviewers !== 'any') {
    const expR = sortedSet(expected.reviewers ?? []);
    const actR = sortedSet(actual.reviewers ?? []);
    if (canon(expR) !== canon(actR)) {
      drift.push(
        `${prefix}: required reviewers differ: expected ${canon(expR)} actual ${canon(actR)}`,
      );
    }
  }
  const allowed = new Set(expected.secrets ?? []);
  const interim = new Set(expected.interimSecrets ?? []);
  for (const secret of [...(actual.secrets ?? [])].sort(byString)) {
    if (allowed.has(secret)) continue;
    if (interim.has(secret)) {
      notices.push(
        `${prefix}: interim secret ${secret} present (allowed until the ADR-0004 D-H.3 C3 attestation)`,
      );
    } else {
      drift.push(`${prefix}: secret ${secret} is not in the allowlist`);
    }
  }
}

/**
 * Compare the rendered target settings with the live settings.
 * @param {Record<string, any>} expected  renderSettings() output
 * @param {LiveSettings} actual
 * @returns {{ drift: string[], notices: string[] }}
 */
export function compareSettings(expected, actual) {
  /** @type {string[]} */
  const drift = [];
  /** @type {string[]} */
  const notices = [];

  compareNamed('ruleset', expected.rulesets ?? [], actual.rulesets ?? [], drift);

  const classic = expected.classicBranchProtection ?? {};
  for (const branch of Object.keys(classic).sort(byString)) {
    const live = actual.classicBranchProtection?.[branch];
    if (live === undefined) {
      drift.push(`classic branch protection on ${branch}: not read`);
    } else if (classic[branch] === null && live !== null) {
      drift.push(
        `classic branch protection on ${branch}: present (target: absent; rulesets replace classic protection)`,
      );
    } else if (canon(classic[branch]) !== canon(live)) {
      drift.push(
        `classic branch protection on ${branch}: differs: expected ${canon(classic[branch])} actual ${canon(live)}`,
      );
    }
  }

  const expEnvs = expected.environments ?? {};
  const actEnvs = actual.environments ?? {};
  for (const name of Object.keys(expEnvs).sort(byString)) {
    const live = actEnvs[name];
    if (live === undefined) drift.push(`environment ${name}: missing`);
    else compareEnvironment(name, expEnvs[name], live, drift, notices);
  }
  for (const name of Object.keys(actEnvs).sort(byString)) {
    if (!(name in expEnvs))
      drift.push(`environment ${name}: present live but not in the settings file`);
  }

  const repoAllowed = new Set(expected.repositorySecrets ?? []);
  for (const secret of [...(actual.repositorySecrets ?? [])].sort(byString)) {
    if (!repoAllowed.has(secret)) {
      drift.push(`repository secret ${secret}: present (target: no repository-level secrets)`);
    }
  }

  const expActions = expected.actions ?? {};
  for (const key of Object.keys(expActions).sort(byString)) {
    const live = actual.actions?.[key];
    if (expActions[key] !== live) {
      drift.push(
        `actions ${key} differs: expected ${canon(expActions[key])} actual ${canon(live)}`,
      );
    }
  }

  const policy = expected.actionsEventPolicy;
  if (actual.actionsEventPolicies === null) {
    notices.push(ACTIONS_EVENT_POLICY_UNCHECKED);
  } else {
    compareNamed(
      'actions event policy',
      policy === undefined || policy === null ? [] : [policy],
      actual.actionsEventPolicies ?? [],
      drift,
    );
  }

  return { drift, notices };
}
