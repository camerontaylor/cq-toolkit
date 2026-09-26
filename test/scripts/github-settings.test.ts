// W1.10 (D13) — settings-as-code and its drift check. The pure module
// scripts/lib/github-settings.mjs is covered directly: the committed
// target renders, a live state equal to it is clean whatever its array
// order, and every drift class produces its specific line. The template's
// allowed Actions events are cross-checked against the triggers the repo's
// workflows actually use. The CLI is spawned only for its fail-closed
// branch (no App ids), which must exit before any gh call — no network.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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

  it('names exactly the three rulesets and four environments', () => {
    const settings = target();
    expect(settings.rulesets.map((r) => r.name)).toEqual([
      'cq-r0-history',
      'cq-r1-main',
      'cq-r2-merge-queue',
    ]);
    expect(Object.keys(settings.environments).sort()).toEqual([
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
    for (const r of [...live.rulesets, ...live.actionsEventPolicies]) {
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
    const policy = live.actionsEventPolicies[0];
    if (policy === undefined) throw new Error('no policy');
    const p = params(policy, 'restrict_action_events');
    p['allowed_events'] = (p['allowed_events'] as string[])
      .filter((e) => e !== 'schedule')
      .concat('pull_request_target');
    expect(driftOf(live)).toEqual([
      'actions event policy cq-allowed-events: rule restrict_action_events: parameter allowed_events differs: missing ["schedule"] extra ["pull_request_target"]',
    ]);
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
      secrets: ['GH_TOKEN'],
    });
    expect(
      environmentFromApi(
        { name: 'x', can_admins_bypass: true, deployment_branch_policy: null },
        [],
        [],
      ).deployment_branch_policy,
    ).toBeNull();
  });
});

describe('github-settings-drift CLI', () => {
  function runCli(args: string[]) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CQ_GH_BIN: join(ROOT, 'nonexistent', 'gh') },
    });
  }

  it('fails closed without App ids and reads no API', () => {
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

  it('refuses a malformed repository or App id as a usage error (exit 2)', () => {
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
  });

  it('treats a gh failure as an error, never as absent (exit 2)', () => {
    const res = runCli(['--repository=a/b', '--verdict-app-id=1', '--promoter-app-id=2']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/github-settings-drift: error: gh api repos\/a\/b\/rulesets/);
  });
});
