// Shared fixtures for the github-settings.*.test.ts files split out of the
// former test/scripts/github-settings.test.ts: the rendered D13 target, a live
// state derived from it with the server-only fields the API adds, and the fake
// `gh` (CQ_GH_BIN) that serves it as the REST API would, so the CLI's read path
// runs end to end. The pure module scripts/lib/github-settings.mjs is covered
// directly; the CLI is spawned, never the network.
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The types come from the declaration file itself so Knip sees it used.
import type {
  GithubSettings,
  LiveSettings,
  RuleObject,
} from '../../scripts/lib/github-settings.d.mts';
import { compareSettings, renderSettings } from '../../scripts/lib/github-settings.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE_PATH = join(ROOT, 'policy', 'templates', 'github-settings.json');
export const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');
export const SCRIPT = join(ROOT, 'scripts', 'github-settings-drift.mjs');
export const VERDICT = 1001;
export const PROMOTER = 5230844;

export function target(): GithubSettings {
  return renderSettings(TEMPLATE, { verdictAppId: VERDICT, promoterAppId: PROMOTER });
}

/** A live state equal to the target, carrying the server-only fields the API adds. */
export function liveFrom(settings: GithubSettings): LiveSettings {
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
      variables: [...(env.variables ?? [])],
    };
  }
  return {
    rulesets: settings.rulesets.map((r, i) => withServerFields(r, 100 + i)),
    classicBranchProtection: { main: null },
    environments,
    repositorySecrets: [],
    actions: clone(settings.actions),
    actionsEventPolicies: [withServerFields(settings.actionsEventPolicy, 5486)],
  };
}

export function ruleset(live: LiveSettings, name: string): RuleObject {
  const found = live.rulesets.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no ruleset ${name}`);
  return found;
}

export function params(obj: RuleObject, type: string): Record<string, unknown> {
  const rule = obj.rules.find((r) => r.type === type);
  if (rule?.parameters === undefined) throw new Error(`no parameters on rule ${type}`);
  return rule.parameters;
}

export function driftOf(live: LiveSettings): string[] {
  return compareSettings(target(), live).drift;
}

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
    out[`${base}/variables?per_page=30&page=1`] = {
      total_count: (env.variables ?? []).length,
      variables: (env.variables ?? []).map((name) => ({ name, value: 'not compared' })),
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
function fakeSetup(
  extra: string[],
  status: Record<string, number>,
  c3Attested = false,
  overrides: Record<string, unknown> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'settings-drift-gh-'));
  const bin = join(dir, 'gh');
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'policy', 'attestations'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'github-settings-drift.mjs'), readFileSync(SCRIPT));
  writeFileSync(
    join(dir, 'scripts', 'lib', 'github-settings.mjs'),
    readFileSync(join(ROOT, 'scripts', 'lib', 'github-settings.mjs')),
  );
  if (c3Attested) writeFileSync(join(dir, 'policy', 'attestations', 'c3.json'), '{}');
  writeFileSync(bin, FAKE_GH);
  chmodSync(bin, 0o755);
  const responses = apiResponses();
  if (c3Attested) {
    responses[`${REPO}/environments/promote/secrets?${PAGE}`] = {
      total_count: 1,
      secrets: [{ name: 'PROMOTE_TOKEN' }],
    };
  }
  const index = Object.entries({ ...responses, ...overrides }).map(([path, body], i) => {
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
      join(dir, 'scripts', 'github-settings-drift.mjs'),
      `--template=${TEMPLATE_PATH}`,
      '--repository=o/r',
      `--verdict-app-id=${VERDICT}`,
      `--promoter-app-id=${PROMOTER}`,
      ...extra,
    ],
    env: { ...process.env, CQ_GH_BIN: bin, FAKE_GH_DIR: dir },
  };
}

export function runFake(
  extra: string[],
  status: Record<string, number>,
  c3Attested = false,
  overrides: Record<string, unknown> = {},
) {
  const { dir, args, env } = fakeSetup(extra, status, c3Attested, overrides);
  try {
    return spawnSync(process.execPath, args, { encoding: 'utf8', env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** runFake, without blocking: independent CLI runs can overlap. */
export function runFakeAsync(extra: string[], status: Record<string, number>): Promise<CliResult> {
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
