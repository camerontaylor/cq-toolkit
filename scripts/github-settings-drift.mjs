// github-settings-drift — the D13 drift check (W1.10; ADR-0004 D-I, RS-11).
// Reads the repository's live GitHub settings through `gh api` and reports
// their distance to policy/templates/github-settings.json, the committed
// target state. It never writes a setting: applying the file is the W7.3a
// wizard's job.
//
//   node scripts/github-settings-drift.mjs --repository=<owner>/<name>
//     --verdict-app-id=<n> --promoter-app-id=<n>
//     [--template=policy/templates/github-settings.json]
//
// gh authenticates from GH_TOKEN. The token needs read access to
// Administration (rulesets, classic protection), Environments, Secrets
// (names only) and Actions; until the verdict App exists that is the
// interim read-only CQ_SETTINGS_TOKEN (methods-w1-10 "Drift check arming").
//
// FAIL CLOSED: an unset or blank App id means the Apps are not registered
// (RS-11 B1), which is itself drift: the check prints that one line and
// exits 1 WITHOUT any API read. A 404 means "absent" only where absence is
// the documented meaning (classic protection's "Branch not protected");
// every other API failure is an error (exit 2), never "absent".
//
// Output: `drift:` lines, then `notice:` lines, then a summary line.
// Exit 0 = no drift, 1 = drift, 2 = usage or API error.
//
// gh runs through execFile with an argv array (no shell); CQ_GH_BIN
// overrides the binary (the review/merge family's test seam).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compareSettings, environmentFromApi, renderSettings } from './lib/github-settings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TEMPLATE = join(ROOT, 'policy', 'templates', 'github-settings.json');
const PAGE = 100;
const run = promisify(execFile);

class UsageError extends Error {}

/** A gh api 404 that the caller may interpret. */
class NotFound extends Error {
  /** @param {string} path @param {string} body */
  constructor(path, body) {
    super(`gh api ${path}: HTTP 404`);
    this.body = body;
  }
}

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  const known = new Set(['repository', 'template', 'verdict-app-id', 'promoter-app-id']);
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/s.exec(arg);
    if (m === null || !known.has(m[1]))
      throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    if (m[1] in opts) throw new UsageError(`--${m[1]} given twice`);
    opts[m[1]] = m[2];
  }
  const repository = opts['repository'] ?? '';
  const parts = repository.split('/');
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0]) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1]) ||
    parts[1] === '.' ||
    parts[1] === '..'
  ) {
    throw new UsageError(`--repository=<owner>/<name> required, got ${JSON.stringify(repository)}`);
  }
  return {
    repo: `repos/${parts[0]}/${parts[1]}`,
    repository,
    template: resolve(opts['template'] ?? DEFAULT_TEMPLATE),
    verdictAppId: (opts['verdict-app-id'] ?? '').trim(),
    promoterAppId: (opts['promoter-app-id'] ?? '').trim(),
  };
}

/**
 * GET one API path; parsed JSON. A 404 throws NotFound; any other failure
 * throws an Error carrying gh's stderr.
 * @param {string} path
 */
async function ghGet(path) {
  const bin = process.env['CQ_GH_BIN'] ?? 'gh';
  const args = [
    'api',
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
    path,
  ];
  let stdout;
  try {
    ({ stdout } = await run(bin, args, { maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    const stderr = String(error?.stderr ?? '');
    if (/\(HTTP 404\)/.test(stderr)) throw new NotFound(path, String(error?.stdout ?? ''));
    const detail = stderr.trim() === '' ? String(error?.message ?? error) : stderr.trim();
    throw new Error(`gh api ${path} failed: ${detail}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`gh api ${path}: response is not JSON`);
  }
}

/** Refuse a list the single page did not cover (no silent truncation). */
function complete(what, items, total) {
  if (!Array.isArray(items)) throw new Error(`${what}: unexpected response shape`);
  if (typeof total === 'number' ? total > items.length : items.length >= PAGE) {
    throw new Error(`${what}: more than one page of results; pagination is unsupported`);
  }
  return items;
}

function idOf(what, item) {
  if (!Number.isSafeInteger(item?.id) || item.id <= 0) throw new Error(`${what}: invalid id`);
  return item.id;
}

/**
 * Read the live settings the template names.
 * @param {string} repo  `repos/<owner>/<name>`
 * @param {Record<string, any>} expected
 * @returns {Promise<import('./lib/github-settings.mjs').LiveSettings>}
 */
async function readLive(repo, expected) {
  const rulesetList = complete(
    'rulesets',
    await ghGet(`${repo}/rulesets?per_page=${PAGE}`),
    undefined,
  );
  const rulesets = [];
  for (const summary of rulesetList) {
    rulesets.push(await ghGet(`${repo}/rulesets/${idOf('ruleset', summary)}`));
  }

  /** @type {Record<string, any>} */
  const classicBranchProtection = {};
  for (const branch of Object.keys(expected.classicBranchProtection ?? {})) {
    const path = `${repo}/branches/${encodeURIComponent(branch)}/protection`;
    try {
      classicBranchProtection[branch] = await ghGet(path);
    } catch (error) {
      if (!(error instanceof NotFound && /Branch not protected/.test(error.body))) throw error;
      classicBranchProtection[branch] = null;
    }
  }

  const envPage = await ghGet(`${repo}/environments?per_page=${PAGE}`);
  /** @type {Record<string, any>} */
  const environments = {};
  for (const env of complete('environments', envPage?.environments ?? [], envPage?.total_count)) {
    const name = String(env.name);
    const base = `${repo}/environments/${encodeURIComponent(name)}`;
    let policies = [];
    if (env.deployment_branch_policy?.custom_branch_policies === true) {
      const page = await ghGet(`${base}/deployment-branch-policies?per_page=${PAGE}`);
      policies = complete(
        `environment ${name} branch policies`,
        page?.branch_policies,
        page?.total_count,
      );
    }
    const secretPage = await ghGet(`${base}/secrets?per_page=${PAGE}`);
    const secrets = complete(
      `environment ${name} secrets`,
      secretPage?.secrets,
      secretPage?.total_count,
    );
    environments[name] = environmentFromApi(
      env,
      policies,
      secrets.map((s) => String(s.name)),
    );
  }

  const repoSecretPage = await ghGet(`${repo}/actions/secrets?per_page=${PAGE}`);
  const repositorySecrets = complete(
    'repository secrets',
    repoSecretPage?.secrets,
    repoSecretPage?.total_count,
  ).map((s) => String(s.name));

  const actions = await ghGet(`${repo}/actions/permissions/workflow`);

  const policyPage = await ghGet(`${repo}/actions/policies?per_page=${PAGE}`);
  const actionsEventPolicies = [];
  for (const summary of complete(
    'actions policies',
    policyPage?.policies,
    policyPage?.total_count,
  )) {
    actionsEventPolicies.push(
      await ghGet(`${repo}/actions/policies/${idOf('actions policy', summary)}`),
    );
  }

  return {
    rulesets,
    classicBranchProtection,
    environments,
    repositorySecrets,
    actions,
    actionsEventPolicies,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.verdictAppId === '' || opts.promoterAppId === '') {
    console.log('drift: apps not registered (RS-11 B1): verdict/promoter app ids unset');
    console.log(`github-settings-drift: ${opts.repository}: 1 drift line, 0 notices (no API read)`);
    return 1;
  }
  let expected;
  try {
    expected = renderSettings(readFileSync(opts.template, 'utf8'), {
      verdictAppId: opts.verdictAppId,
      promoterAppId: opts.promoterAppId,
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const live = await readLive(opts.repo, expected);
  const { drift, notices } = compareSettings(expected, live);
  for (const line of drift) console.log(`drift: ${line}`);
  for (const line of notices) console.log(`notice: ${line}`);
  console.log(
    `github-settings-drift: ${opts.repository}: ${drift.length} drift line(s), ${notices.length} notice(s)`,
  );
  return drift.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  const kind = error instanceof UsageError ? 'usage' : 'error';
  console.error(`github-settings-drift: ${kind}: ${error?.message ?? error}`);
  process.exitCode = 2;
}
