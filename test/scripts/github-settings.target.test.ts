// github-settings.json, the committed D13 target: the concrete file renders,
// names exactly five rulesets and five environments, pins the direct-main merge
// bar and bypass actors, refuses bad App ids and leftover placeholders, and its
// allowed Actions events cover every trigger the repo's workflows actually use.
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The types come from the declaration file itself so Knip sees it used.
import type { RuleObject } from '../../scripts/lib/github-settings.d.mts';
import { renderSettings } from '../../scripts/lib/github-settings.mjs';
import { scanWorkflow } from '../../src/ops/gates/workflowScan.js';
import { PROMOTER, ROOT, TEMPLATE, params, target } from './github-settings.helpers.js';

describe('github-settings.json: the committed D13 target', () => {
  it('parses the concrete live settings with schemaVersion 1', () => {
    const raw = JSON.parse(TEMPLATE) as Record<string, unknown>;
    expect(raw['schemaVersion']).toBe(1);
    expect(TEMPLATE).not.toContain('{{');
  });

  it('names exactly the five rulesets and five environments', () => {
    const settings = target();
    expect(settings.rulesets.map((r) => r.name)).toEqual([
      'cq-r0-history',
      'cq-r1-main',
      'cq-c2-replay-marker',
      'cq review ledger immutable history',
      'cq review ledger App writer only',
    ]);
    // Pin the retained replay-marker payload, including its retired-ref exclusion.
    const marker = settings.rulesets.find((r) => r.name === 'cq-c2-replay-marker') as RuleObject;
    expect(marker.target).toBe('branch');
    expect(marker.enforcement).toBe('active');
    expect(marker.conditions).toEqual({
      ref_name: { include: ['refs/heads/cq/*'], exclude: ['refs/heads/cq/promoted'] },
    });
    expect(marker.rules.map((r) => r.type)).toEqual(['deletion', 'non_fast_forward']);
    expect(marker.bypass_actors).toEqual([]);
    expect(Object.keys(settings.environments).sort()).toEqual([
      'adversarial-scratch',
      'automation',
      'cq-verdict',
      'drill',
      'promote',
    ]);
    expect(settings.environments.automation?.secrets).toContain('OPENCODE_GO_API_KEY');
    expect(settings.environments.automation?.secrets).not.toContain('DEEPSEEK_API_KEY');
    expect(settings.environments.drill?.secrets).toContain('OPENCODE_GO_API_KEY');
    expect(settings.environments.drill?.secrets).not.toContain('DEEPSEEK_API_KEY');
    expect(settings.classicBranchProtection).toEqual({ main: null });
    expect(settings.repositorySecrets).toEqual([]);
  });

  it('pins the direct-main merge bar and existing bypass actors', () => {
    const settings = target();
    const main = settings.rulesets.find((r) => r.name === 'cq-r1-main') as RuleObject;
    expect(main.rules.map((r) => r.type)).toEqual(['pull_request', 'required_status_checks']);
    expect(main.bypass_actors).toEqual([
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
      { actor_id: PROMOTER, actor_type: 'Integration', bypass_mode: 'always' },
    ]);
    expect(params(main, 'required_status_checks')).toEqual({
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [
        { context: 'static', integration_id: 15368 },
        { context: 'denylist', integration_id: 15368 },
      ],
    });
    expect(params(main, 'pull_request')).toMatchObject({
      required_approving_review_count: 0,
      required_review_thread_resolution: false,
      allowed_merge_methods: ['merge'],
    });
    expect(settings.rulesets[0]?.conditions).toEqual({
      ref_name: { include: ['refs/heads/main'], exclude: [] },
    });
    for (const env of Object.values(settings.environments)) {
      expect(env.branch_policies).toEqual([{ name: 'main', type: 'branch' }]);
    }
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

  it('allows every workflow trigger and the retained live review-comment event', () => {
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
    expect([...used].filter((event) => !allowed.includes(event))).toEqual([]);
    expect(allowed.filter((event) => !used.has(event))).toEqual(['pull_request_review_comment']);
  });
});
