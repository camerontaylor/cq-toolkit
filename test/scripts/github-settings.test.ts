// W1.10 (D13) — settings-as-code and its drift check. The pure module
// scripts/lib/github-settings.mjs is covered directly: the committed
// target renders, a live state equal to it is clean whatever its array
// order, and every drift class produces its specific line. The template's
// allowed Actions events are cross-checked against the triggers the repo's
// workflows actually use. The CLI is spawned for its fail-closed branch
// (no App ids), which must exit before any gh call, and against a fake `gh`
// (CQ_GH_BIN) serving a clean live state — never the network.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The types come from the declaration file itself so Knip sees it used.
import type {
  GithubSettings,
  LiveSettings,
  RuleObject,
} from '../../scripts/lib/github-settings.d.mts';
import {
  ACTIONS_EVENT_POLICY_UNCHECKED,
  compareSettings,
  environmentFromApi,
  renderSettings,
} from '../../scripts/lib/github-settings.mjs';
import { scanWorkflow } from '../../src/ops/gates/workflowScan.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE_PATH = join(ROOT, 'policy', 'templates', 'github-settings.json');
const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');
const SCRIPT = join(ROOT, 'scripts', 'github-settings-drift.mjs');
const VERDICT = 1001;
const PROMOTER = 2002;

function target(): GithubSettings {
  return renderSettings(TEMPLATE, { verdictAppId: VERDICT, promoterAppId: PROMOTER });
}

/** A live state equal to the target, carrying the server-only fields the API adds. */
function liveFrom(settings: GithubSettings): LiveSettings {
  const clone = <T>(value: T): T => structuredClone(value);
  const withServerFields = (obj: RuleObject, id: number): RuleObject =>
    ({
      id,
      node_id: `RRS_${id}`,
      source: 'o/r',
      source_type: 'Repository',
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
      current_user_can_bypass: 'always',
      _links: { self: { href: 'x' } },
      ...clone(obj),
    }) as RuleObject;
  const environments: LiveSettings['environments'] = {};
  for (const [name, env] of Object.entries(settings.environments)) {
    environments[name] = {
      deployment_branch_policy: clone(env.deployment_branch_policy),
      branch_policies: clone(env.branch_policies),
      can_admins_bypass: env.can_admins_bypass,
      reviewers: env.reviewers === 'any' ? [] : clone(env.reviewers),
      prevent_self_review: env.prevent_self_review,
      wait_timer: env.wait_timer,
      other_rules: [],
      secrets: [...env.secrets],
    };
  }
  return {
    rulesets: settings.rulesets.map((r, i) => withServerFields(r, 100 + i)),
    classicBranchProtection: { main: null, 'merge-queue': null },
    environments,
    repositorySecrets: [],
    actions: clone(settings.actions),
    actionsEventPolicies: [withServerFields(settings.actionsEventPolicy, 5486)],
  };
}

function ruleset(live: LiveSettings, name: string): RuleObject {
  const found = live.rulesets.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no ruleset ${name}`);
  return found;
}

function params(obj: RuleObject, type: string): Record<string, unknown> {
  const rule = obj.rules.find((r) => r.type === type);
  if (rule?.parameters === undefined) throw new Error(`no parameters on rule ${type}`);
  return rule.parameters;
}

function driftOf(live: LiveSettings): string[] {
  return compareSettings(target(), live).drift;
}

describe('github-settings.json: the committed D13 target', () => {
  it('parses as JSON with quoted placeholders and schemaVersion 1', () => {
    const raw = JSON.parse(TEMPLATE) as Record<string, unknown>;
    expect(raw['schemaVersion']).toBe(1);
    expect(TEMPLATE).toContain('"{{VERDICT_APP_ID}}"');
    expect(TEMPLATE).toContain('"{{PROMOTER_APP_ID}}"');
  });

  it('names exactly the three rulesets and five environments', () => {
    const settings = target();
    expect(settings.rulesets.map((r) => r.name)).toEqual([
      'cq-r0-history',
      'cq-r1-main',
      'cq-r2-merge-queue',
    ]);
    expect(Object.keys(settings.environments).sort()).toEqual([
      'adversarial-scratch',
      'automation',
      'cq-verdict',
      'drill',
      'promote',
    ]);
    expect(settings.classicBranchProtection).toEqual({ main: null, 'merge-queue': null });
    expect(settings.repositorySecrets).toEqual([]);
  });

  it('renders the App ids as numbers where the placeholders were', () => {
    const settings = target();
    expect(settings.rulesets[1]?.bypass_actors).toEqual([
      { actor_id: PROMOTER, actor_type: 'Integration', bypass_mode: 'always' },
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ]);
    const checks = params(settings.rulesets[2] as RuleObject, 'required_status_checks')[
      'required_status_checks'
    ] as { context: string; integration_id: number }[];
    expect(checks.filter((c) => c.context.startsWith('cq/'))).toEqual([
      { context: 'cq/policy', integration_id: VERDICT },
      { context: 'cq/ratchet', integration_id: VERDICT },
      { context: 'cq/acceptance', integration_id: VERDICT },
    ]);
    expect(renderSettings(TEMPLATE, { verdictAppId: '7', promoterAppId: '8' }).schemaVersion).toBe(
      1,
    );
  });

  it('refuses a non-integer or missing App id', () => {
    for (const bad of [
      '',
      '0',
      '-3',
      '1.5',
      '12abc',
      'x',
      undefined,
      1.5,
      '99999999999999999999',
    ]) {
      expect(() => renderSettings(TEMPLATE, { verdictAppId: bad, promoterAppId: 2 })).toThrow(
        /verdictAppId/,
      );
      expect(() => renderSettings(TEMPLATE, { verdictAppId: 1, promoterAppId: bad })).toThrow(
        /promoterAppId/,
      );
    }
  });

  it('refuses a leftover placeholder', () => {
    const text = TEMPLATE.replace('"read"', '"{{WORKFLOW_PERMS}}"');
    expect(() => renderSettings(text, { verdictAppId: 1, promoterAppId: 2 })).toThrow(
      /unrendered placeholder "\{\{WORKFLOW_PERMS\}\}/,
    );
  });

  it("allows exactly the trigger events this repo's workflows use", () => {
    const dir = join(ROOT, '.github', 'workflows');
    const used = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const scan = scanWorkflow(readFileSync(join(dir, file), 'utf8'));
      if (!scan.ok) throw new Error(`${file}: ${scan.reason}`);
      for (const trigger of scan.triggers) used.add(trigger);
    }
    const allowed = params(target().actionsEventPolicy, 'restrict_action_events')[
      'allowed_events'
    ] as string[];
    expect([...used].sort()).toEqual([...allowed].sort());
  });
});

describe('compareSettings', () => {
  it('reports nothing for a live state equal to the target', () => {
    expect(compareSettings(target(), liveFrom(target()))).toEqual({ drift: [], notices: [] });
  });

  it('is order-insensitive (shuffled arrays are not drift)', () => {
    const live = liveFrom(target());
    for (const r of [...live.rulesets, ...(live.actionsEventPolicies ?? [])]) {
      r.rules.reverse();
      r.bypass_actors?.reverse();
      for (const cond of Object.values(r.conditions)) cond.include.reverse();
      for (const rule of r.rules) {
        for (const value of Object.values(rule.parameters ?? {})) {
          if (Array.isArray(value)) value.reverse();
        }
      }
    }
    live.rulesets.reverse();
    const env = live.environments['automation'];
    env?.secrets.reverse();
    expect(compareSettings(target(), live)).toEqual({ drift: [], notices: [] });
  });

  it('ignores a default-valued live rule parameter the file does not name, not an enabled one', () => {
    const live = liveFrom(target());
    const r1 = ruleset(live, 'cq-r1-main');
    r1.rules = [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }];
    params(ruleset(live, 'cq-r2-merge-queue'), 'pull_request')['required_reviewers'] = [];
    expect(driftOf(live)).toEqual([]);
    r1.rules = [{ type: 'update', parameters: { update_allows_fetch_and_merge: true } }];
    expect(driftOf(live)).toEqual([
      'ruleset cq-r1-main: rule update: parameter update_allows_fetch_and_merge differs: expected absent actual true',
    ]);
  });

  it('reports a missing and an extra ruleset', () => {
    const live = liveFrom(target());
    live.rulesets = live.rulesets.filter((r) => r.name !== 'cq-r1-main');
    live.rulesets.push({
      name: 'H-restrict-updates',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [{ type: 'update' }],
      bypass_actors: [],
    });
    expect(driftOf(live)).toEqual([
      'ruleset cq-r1-main: missing',
      'ruleset H-restrict-updates: present live but not in the settings file',
    ]);
  });

  it('reports enforcement, conditions and rule differences', () => {
    const live = liveFrom(target());
    const r0 = ruleset(live, 'cq-r0-history');
    r0.enforcement = 'evaluate';
    r0.conditions = { ref_name: { include: ['refs/heads/main'], exclude: [] } };
    r0.rules = r0.rules.filter((r) => r.type !== 'deletion');
    r0.rules.push({ type: 'creation' });
    expect(driftOf(live)).toEqual([
      'ruleset cq-r0-history: enforcement differs: expected "active" actual "evaluate"',
      'ruleset cq-r0-history: conditions differ: expected {"ref_name":{"exclude":[],"include":["refs/heads/main","refs/heads/merge-queue"]}} actual {"ref_name":{"exclude":[],"include":["refs/heads/main"]}}',
      'ruleset cq-r0-history: rule deletion missing',
      'ruleset cq-r0-history: rule creation present live but not in the settings file',
    ]);
  });

  it('reports a bypass difference, with the exempt promoter called out', () => {
    const live = liveFrom(target());
    const r1 = ruleset(live, 'cq-r1-main');
    r1.bypass_actors = [
      { actor_id: PROMOTER, actor_type: 'Integration', bypass_mode: 'exempt' },
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ];
    expect(driftOf(live)).toEqual([
      `ruleset cq-r1-main: bypass_actors differ: expected [{"actor_id":${PROMOTER},"actor_type":"Integration","bypass_mode":"always"},{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}] actual [{"actor_id":${PROMOTER},"actor_type":"Integration","bypass_mode":"exempt"},{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]`,
      `ruleset cq-r1-main: bypass actor Integration ${PROMOTER} has bypass_mode "exempt"; it must be "always" (an exempt bypass leaves no audit entry)`,
    ]);
  });

  it('reports an App bypass added to R2 and an unreadable bypass list', () => {
    const live = liveFrom(target());
    ruleset(live, 'cq-r2-merge-queue').bypass_actors?.push({
      actor_id: PROMOTER,
      actor_type: 'Integration',
      bypass_mode: 'always',
    });
    delete ruleset(live, 'cq-r0-history').bypass_actors;
    const drift = driftOf(live);
    expect(drift).toHaveLength(2);
    expect(drift[0]).toMatch(/^ruleset cq-r0-history: bypass_actors unreadable/);
    expect(drift[1]).toMatch(/^ruleset cq-r2-merge-queue: bypass_actors differ: /);
  });

  it('reports a missing, re-pinned or extra required check', () => {
    const live = liveFrom(target());
    const p = params(ruleset(live, 'cq-r2-merge-queue'), 'required_status_checks');
    p['required_status_checks'] = [
      { context: 'cq/policy', integration_id: VERDICT },
      { context: 'cq/ratchet', integration_id: 15368 },
      { context: 'static', integration_id: 15368 },
      { context: 'denylist', integration_id: 15368 },
      { context: 'from-source', integration_id: 15368 },
      { context: 'pack-audit', integration_id: 15368 },
      { context: 'ratchet', integration_id: 15368 },
    ];
    expect(driftOf(live)).toEqual([
      `ruleset cq-r2-merge-queue: rule required_status_checks: required check cq/acceptance (integration_id ${VERDICT}) missing`,
      `ruleset cq-r2-merge-queue: rule required_status_checks: required check cq/ratchet: integration_id differs: expected ${VERDICT} actual 15368`,
      'ruleset cq-r2-merge-queue: rule required_status_checks: required check ratchet present live but not in the settings file',
    ]);
  });

  it('reports a pull_request parameter difference as missing/extra members', () => {
    const live = liveFrom(target());
    const p = params(ruleset(live, 'cq-r2-merge-queue'), 'pull_request');
    p['allowed_merge_methods'] = ['squash', 'merge'];
    p['required_review_thread_resolution'] = false;
    expect(driftOf(live)).toEqual([
      'ruleset cq-r2-merge-queue: rule pull_request: parameter allowed_merge_methods differs: missing [] extra ["squash"]',
      'ruleset cq-r2-merge-queue: rule pull_request: parameter required_review_thread_resolution differs: expected true actual false',
    ]);
  });

  it('reports classic branch protection that is present', () => {
    const live = liveFrom(target());
    live.classicBranchProtection['merge-queue'] = { enforce_admins: { enabled: true } };
    expect(driftOf(live)).toEqual([
      'classic branch protection on merge-queue: present (target: absent; rulesets replace classic protection)',
    ]);
  });

  it('reports a missing and an unlisted environment', () => {
    const live = liveFrom(target());
    delete live.environments['promote'];
    live.environments['github-pages'] = {
      deployment_branch_policy: null,
      branch_policies: [],
      can_admins_bypass: true,
      reviewers: [],
      prevent_self_review: false,
      wait_timer: 0,
      other_rules: [],
      secrets: [],
    };
    expect(driftOf(live)).toEqual([
      'environment promote: missing',
      'environment github-pages: present live but not in the settings file',
    ]);
  });

  it('reports protected_branches: true with the T-19 reason', () => {
    const live = liveFrom(target());
    const env = live.environments['cq-verdict'];
    if (env === undefined) throw new Error('no env');
    env.deployment_branch_policy = { protected_branches: true, custom_branch_policies: false };
    env.branch_policies = [];
    expect(driftOf(live)).toEqual([
      'environment cq-verdict: deployment_branch_policy differs: expected {"custom_branch_policies":true,"protected_branches":false} actual {"custom_branch_policies":false,"protected_branches":true} (protected_branches admits any protected branch, e.g. merge-queue: ADR-0004 T-19)',
      'environment cq-verdict: deployment branch policy {"name":"main","type":"branch"} missing',
    ]);
  });

  it('reports an extra branch policy, admin bypass and reviewers', () => {
    const live = liveFrom(target());
    const env = live.environments['promote'];
    if (env === undefined) throw new Error('no env');
    env.branch_policies.push({ name: 'merge-queue', type: 'branch' });
    env.can_admins_bypass = true;
    env.reviewers = [{ type: 'User', login: 'owner' }];
    const drill = live.environments['drill'];
    if (drill === undefined) throw new Error('no env');
    drill.reviewers = [{ type: 'User', login: 'owner' }];
    expect(driftOf(live)).toEqual([
      'environment promote: deployment branch policy {"name":"merge-queue","type":"branch"} present live but not in the settings file',
      'environment promote: can_admins_bypass differs: expected false actual true',
      'environment promote: required reviewers differ: expected [] actual [{"login":"owner","type":"User"}]',
    ]);
  });

  it('reports prevent_self_review, a wait timer and a custom protection rule', () => {
    const live = liveFrom(target());
    const promote = live.environments['promote'];
    const drill = live.environments['drill'];
    if (promote === undefined || drill === undefined) throw new Error('no env');
    promote.wait_timer = 30;
    promote.other_rules = ['deployment_protection_rule'];
    drill.prevent_self_review = true;
    expect(driftOf(live)).toEqual([
      'environment drill: prevent_self_review differs: expected false actual true',
      'environment promote: wait_timer differs: expected 0 actual 30',
      'environment promote: protection rule of type "deployment_protection_rule" present live (the target has no custom deployment protection rules)',
    ]);
  });

  it('pins wait_timer 0 and prevent_self_review false on every environment', () => {
    for (const [name, env] of Object.entries(target().environments)) {
      expect([name, env.wait_timer, env.prevent_self_review]).toEqual([name, 0, false]);
    }
  });

  it('reports an unlisted environment secret as drift and an interim one as a notice', () => {
    const live = liveFrom(target());
    live.environments['automation']?.secrets.push('GH_TOKEN', 'CQ_AUTOMATION_TOKEN');
    live.environments['cq-verdict']?.secrets.push('PROMOTE_TOKEN');
    expect(compareSettings(target(), live)).toEqual({
      drift: ['environment cq-verdict: secret PROMOTE_TOKEN is not in the allowlist'],
      notices: [
        'environment automation: interim secret CQ_AUTOMATION_TOKEN present (allowed until the ADR-0004 D-H.3 C3 attestation)',
        'environment automation: interim secret GH_TOKEN present (allowed until the ADR-0004 D-H.3 C3 attestation)',
      ],
    });
  });

  it('reports a repository-level secret', () => {
    const live = liveFrom(target());
    live.repositorySecrets = ['PROMOTE_TOKEN'];
    expect(driftOf(live)).toEqual([
      'repository secret PROMOTE_TOKEN: present (target: no repository-level secrets)',
    ]);
  });

  it('reports Actions workflow permissions that differ', () => {
    const live = liveFrom(target());
    live.actions = {
      default_workflow_permissions: 'write',
      can_approve_pull_request_reviews: true,
    };
    expect(driftOf(live)).toEqual([
      'actions can_approve_pull_request_reviews differs: expected false actual true',
      'actions default_workflow_permissions differs: expected "read" actual "write"',
    ]);
  });

  it('reports a missing event policy', () => {
    const live = liveFrom(target());
    live.actionsEventPolicies = [];
    expect(driftOf(live)).toEqual(['actions event policy cq-allowed-events: missing']);
  });

  it('reports allowed events that differ', () => {
    const live = liveFrom(target());
    const policy = live.actionsEventPolicies?.[0];
    if (policy === undefined) throw new Error('no policy');
    const p = params(policy, 'restrict_action_events');
    p['allowed_events'] = (p['allowed_events'] as string[])
      .filter((e) => e !== 'schedule')
      .concat('pull_request_target');
    expect(driftOf(live)).toEqual([
      'actions event policy cq-allowed-events: rule restrict_action_events: parameter allowed_events differs: missing ["schedule"] extra ["pull_request_target"]',
    ]);
  });

  it('reports an unchecked event policy (null) as a notice, never drift or a match', () => {
    const live = liveFrom(target());
    live.actionsEventPolicies = null;
    expect(compareSettings(target(), live)).toEqual({
      drift: [],
      notices: [ACTIONS_EVENT_POLICY_UNCHECKED],
    });
  });
});

describe('environmentFromApi', () => {
  it('normalizes the environment, branch-policy and secret reads', () => {
    const env = environmentFromApi(
      {
        id: 1,
        name: 'drill',
        can_admins_bypass: true,
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        protection_rules: [
          { id: 2, type: 'wait_timer', wait_timer: 0 },
          {
            id: 3,
            type: 'required_reviewers',
            prevent_self_review: false,
            reviewers: [
              { type: 'User', reviewer: { login: 'owner', id: 9 } },
              { type: 'Team', reviewer: { slug: 'core', id: 10 } },
            ],
          },
          { id: 4, type: 'branch_policy' },
        ],
      },
      [{ id: 7, node_id: 'x', name: 'main', type: 'branch' }],
      ['GH_TOKEN'],
    );
    expect(env).toEqual({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branch_policies: [{ name: 'main', type: 'branch' }],
      can_admins_bypass: true,
      reviewers: [
        { type: 'User', login: 'owner' },
        { type: 'Team', slug: 'core' },
      ],
      prevent_self_review: false,
      wait_timer: 0,
      other_rules: [],
      secrets: ['GH_TOKEN'],
    });
    const guarded = environmentFromApi(
      {
        name: 'promote',
        can_admins_bypass: false,
        deployment_branch_policy: null,
        protection_rules: [
          { id: 2, type: 'wait_timer', wait_timer: 30 },
          { id: 3, type: 'required_reviewers', prevent_self_review: true, reviewers: [] },
          { id: 5, type: 'deployment_protection_rule', app: { slug: 'x' } },
          { id: 6 },
        ],
      },
      [],
      [],
    );
    expect(guarded).toMatchObject({
      prevent_self_review: true,
      wait_timer: 30,
      other_rules: ['deployment_protection_rule', 'unknown'],
    });
    expect(
      environmentFromApi(
        { name: 'x', can_admins_bypass: true, deployment_branch_policy: null },
        [],
        [],
      ),
    ).toMatchObject({
      deployment_branch_policy: null,
      prevent_self_review: false,
      wait_timer: 0,
      other_rules: [],
    });
  });
});

describe('github-settings-drift CLI', () => {
  function runCli(args: string[]) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CQ_GH_BIN: join(ROOT, 'nonexistent', 'gh') },
    });
  }

  it('fails closed without App ids and reads no API', { timeout: 180_000 }, () => {
    for (const args of [
      ['--repository=a/b'],
      ['--repository=a/b', '--verdict-app-id=1', '--promoter-app-id='],
      ['--repository=a/b', '--verdict-app-id= ', '--promoter-app-id=2'],
    ]) {
      const res = runCli(args);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain(
        'drift: apps not registered (RS-11 B1): verdict/promoter app ids unset',
      );
      expect(res.stderr).toBe('');
    }
  });

  it(
    'refuses a malformed repository or App id as a usage error (exit 2)',
    { timeout: 180_000 },
    () => {
      for (const args of [
        ['--repository=a'],
        ['--repository=a/b/c', '--verdict-app-id=1', '--promoter-app-id=2'],
        ['--repository=-a/b', '--verdict-app-id=1', '--promoter-app-id=2'],
        ['--repository=a/..', '--verdict-app-id=1', '--promoter-app-id=2'],
        ['--repository=a/b', '--verdict-app-id=x', '--promoter-app-id=2'],
        ['--repository=a/b', '--bogus=1'],
      ]) {
        const res = runCli(args);
        expect(res.status, args.join(' ')).toBe(2);
        expect(res.stderr).toMatch(/github-settings-drift: usage: /);
      }
    },
  );

  it('treats a gh failure as an error, never as absent (exit 2)', { timeout: 180_000 }, () => {
    const res = runCli(['--repository=a/b', '--verdict-app-id=1', '--promoter-app-id=2']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/github-settings-drift: error: gh api repos\/a\/b\/rulesets/);
  });
});

// A fake `gh` (CQ_GH_BIN) serving the target state as the REST API would,
// so the CLI's read path runs end to end; FAKE_GH_STATUS overrides one
// path's HTTP status (e.g. the 403 GitHub returns for `actions/policies`
// to a credential without Administration: write).
describe('github-settings-drift CLI: the Actions event policy read', () => {
  const REPO = 'repos/o/r';
  const PAGE = 'per_page=100';

  function apiResponses(): Record<string, unknown> {
    const settings = target();
    const live = liveFrom(settings);
    const out: Record<string, unknown> = {};
    out[`${REPO}/rulesets?${PAGE}`] = live.rulesets.map((r) => ({ id: (r as { id?: number }).id }));
    for (const r of live.rulesets) out[`${REPO}/rulesets/${(r as { id?: number }).id}`] = r;
    const environments = Object.entries(settings.environments).map(([name, env], i) => ({
      id: i + 1,
      name,
      can_admins_bypass: env.can_admins_bypass,
      deployment_branch_policy: env.deployment_branch_policy,
      protection_rules: [],
    }));
    out[`${REPO}/environments?${PAGE}`] = { total_count: environments.length, environments };
    for (const [name, env] of Object.entries(settings.environments)) {
      const base = `${REPO}/environments/${encodeURIComponent(name)}`;
      out[`${base}/deployment-branch-policies?${PAGE}`] = {
        total_count: env.branch_policies.length,
        branch_policies: env.branch_policies,
      };
      out[`${base}/secrets?${PAGE}`] = {
        total_count: env.secrets.length,
        secrets: env.secrets.map((n) => ({ name: n })),
      };
    }
    out[`${REPO}/actions/secrets?${PAGE}`] = { total_count: 0, secrets: [] };
    out[`${REPO}/actions/permissions/workflow`] = live.actions;
    const policy = live.actionsEventPolicies?.[0];
    out[`${REPO}/actions/policies?${PAGE}`] = { total_count: 1, policies: [{ id: 5486 }] };
    out[`${REPO}/actions/policies/5486`] = policy;
    return out;
  }

  // The fake is a POSIX sh script over pre-written response files: the CLI
  // spawns it once per API read, and a shell starts far faster than node
  // (this suite's runtime is dominated by those spawns). Its behaviour is
  // the REST API's: `status.txt` lines (`<code> <path>`) refuse that path
  // with `(HTTP <code>)`; a branch-protection read is the 404 of an
  // unprotected branch; `index.tsv` lines (`<file>\t<path>`) serve a
  // response; any other path is a 404. Only shell builtins run per call
  // except the final `cat`.
  const FAKE_GH = `#!/bin/sh
for path; do :; done
dir=\${FAKE_GH_DIR:?}
while IFS=' ' read -r code p; do
  if [ "$p" = "$path" ]; then
    printf 'gh: fake refusal (HTTP %s)\\n' "$code" >&2
    exit 1
  fi
done < "$dir/status.txt"
case "$path" in
  */branches/*/protection)
    printf '%s' '{"message":"Branch not protected"}'
    printf 'gh: Branch not protected (HTTP 404)\\n' >&2
    exit 1;;
esac
tab=$(printf '\\t')
while IFS="$tab" read -r file p; do
  if [ "$p" = "$path" ]; then exec cat "$dir/$file"; fi
done < "$dir/index.tsv"
printf 'gh: Not Found (HTTP 404)\\n' >&2
exit 1
`;

  /** Write the fake gh and its responses into a fresh dir; the CLI's argv and env. */
  function fakeSetup(extra: string[], status: Record<string, number>) {
    const dir = mkdtempSync(join(tmpdir(), 'settings-drift-gh-'));
    const bin = join(dir, 'gh');
    writeFileSync(bin, FAKE_GH);
    chmodSync(bin, 0o755);
    const index = Object.entries(apiResponses()).map(([path, body], i) => {
      const file = `r${String(i)}.json`;
      writeFileSync(join(dir, file), JSON.stringify(body));
      return `${file}\t${path}\n`;
    });
    writeFileSync(join(dir, 'index.tsv'), index.join(''));
    writeFileSync(
      join(dir, 'status.txt'),
      Object.entries(status)
        .map(([path, code]) => `${String(code)} ${path}\n`)
        .join(''),
    );
    return {
      dir,
      args: [
        SCRIPT,
        '--repository=o/r',
        `--verdict-app-id=${VERDICT}`,
        `--promoter-app-id=${PROMOTER}`,
        ...extra,
      ],
      env: { ...process.env, CQ_GH_BIN: bin, FAKE_GH_DIR: dir },
    };
  }

  function runFake(extra: string[], status: Record<string, number>) {
    const { dir, args, env } = fakeSetup(extra, status);
    try {
      return spawnSync(process.execPath, args, { encoding: 'utf8', env });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  interface CliResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }

  /** runFake, without blocking: independent CLI runs can overlap. */
  function runFakeAsync(extra: string[], status: Record<string, number>): Promise<CliResult> {
    const { dir, args, env } = fakeSetup(extra, status);
    return new Promise<CliResult>((done, fail) => {
      const child = spawn(process.execPath, args, { env });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', fail);
      child.on('close', (code) => done({ status: code, stdout, stderr }));
    }).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  const LIST = `${REPO}/actions/policies?${PAGE}`;

  it('a readable live state equal to the target is clean (exit 0)', { timeout: 180_000 }, () => {
    const res = runFake([], {});
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('github-settings-drift: o/r: 0 drift line(s), 0 notice(s)\n');
    expect(res.status).toBe(0);
  });

  it(
    'a 403 on the list read is UNCHECKED: a notice, no drift from it (exit 0)',
    { timeout: 180_000 },
    () => {
      const res = runFake([], { [LIST]: 403 });
      expect(res.stderr).toBe('');
      expect(res.stdout).toBe(
        `notice: ${ACTIONS_EVENT_POLICY_UNCHECKED}\n` +
          'github-settings-drift: o/r: 0 drift line(s), 1 notice(s)\n',
      );
      expect(res.stdout).toContain(
        'notice: actions event policy unchecked: GitHub requires Administration: write to read it; the CI drift credential is read-only by design — run the drift check with an owner/admin credential to cover it',
      );
      expect(res.status).toBe(0);
    },
  );

  it('--require-event-policy turns that 403 into an error (exit 2)', { timeout: 180_000 }, () => {
    const res = runFake(['--require-event-policy'], { [LIST]: 403 });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(
      /github-settings-drift: error: gh api repos\/o\/r\/actions\/policies\?per_page=100 failed: .*HTTP 403.*--require-event-policy/,
    );
    // Readable, the flag changes nothing.
    expect(runFake(['--require-event-policy'], {}).status).toBe(0);
  });

  it(
    'every other failure stays an error (exit 2), never unchecked or absent',
    { timeout: 180_000 },
    async () => {
      // The four cases are independent CLI runs: run them concurrently.
      const cases = [
        [LIST, 404],
        [LIST, 500],
        [`${REPO}/actions/policies/5486`, 403],
        [`${REPO}/actions/permissions/workflow`, 403],
      ] as const;
      const results = await Promise.all(
        cases.map(([path, code]) => runFakeAsync([], { [path]: code })),
      );
      for (const [i, res] of results.entries()) {
        const [path, code] = cases[i] ?? ['', 0];
        expect(res.status, `${path} ${code}`).toBe(2);
        expect(res.stdout, `${path} ${code}`).not.toContain('notice:');
        expect(res.stderr).toMatch(/github-settings-drift: error: /);
      }
    },
  );
});
