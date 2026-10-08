#!/usr/bin/env node
// Dispatch-only, scratch-repository adversarial evidence collector. A row is
// never PASS merely because an attack request succeeded: an independent
// observation of the expected policy outcome is required.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SCRATCH_REPO = 'camerontaylor/cq-scratch-v11-adversarial';
const READY = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A10', 'A11', 'A14', 'A15', 'A17', 'A20'];
const DEPENDENT = {
  A12: 'W2 governed budget and resume implementation',
  A12b: 'W2 reservation recovery implementation',
  A12c: 'W2 advisory admission implementation',
  A13: 'W6 fixer evaluation isolation implementation',
  A18: 'W2 quota-window deferral implementation',
  A19: 'W3 layered config and provenance implementation',
};
const EXPECTED = 'rejected / needs-human / not eligible';
// §3.1: blank means absent repository variables, not explicit default values.
const PROFILE_KEYS = [
  'CQ_MERGE_REQUIRE_HUMAN_APPROVAL',
  'CQ_MERGE_ACCEPT_REVIEW_STATES',
  'CQ_MERGE_TRUSTED_BOTS',
  'CQ_MERGE_TRUSTED_ASSOCIATIONS',
  'CQ_MERGE_SETTLE_MS',
  'CQ_MERGE_PROTECTED_PATHS',
  'CQ_EXTERNAL_INPUT',
  'CQ_SANDBOX',
  'CQ_SANDBOX_BACKEND',
  'CQ_SANDBOX_NETWORK',
  'CQ_RUN_TOOL',
  'CQ_RUN_ENV_PASSTHROUGH',
  'CQ_BUDGET_ALLOW_ADVISORY',
  'CQ_BUDGET_REQUIRE_CAP',
];
// Operational repository variables (App identities, drill owner) that the
// Apps listed as live prerequisites require. They carry no trust or sandbox
// policy, so they are preserved and never mutated; any other unmodeled CQ_*
// variable could change policy and still blocks the run.
const OPERATIONAL_KEYS = [
  'CQ_VERDICT_APP_ID',
  'CQ_VERDICT_APP_CLIENT_ID',
  'CQ_PROMOTER_APP_ID',
  'CQ_PROMOTER_APP_CLIENT_ID',
  'CQ_AUTOMATION_INTERIM_FALLBACK',
  'CQ_DRILL_OWNER',
];
const SUPPORTED_FLAGS = ['repo', 'profile', 'rows'];
const SOLO_PROFILE = {
  CQ_MERGE_REQUIRE_HUMAN_APPROVAL: 'false',
  CQ_MERGE_ACCEPT_REVIEW_STATES: 'APPROVED,COMMENTED',
  CQ_MERGE_TRUSTED_BOTS: 'coderabbitai[bot]',
  CQ_MERGE_TRUSTED_ASSOCIATIONS: 'OWNER,MEMBER,COLLABORATOR',
  CQ_MERGE_SETTLE_MS: '600000',
  CQ_MERGE_PROTECTED_PATHS: 'diff-check',
  CQ_EXTERNAL_INPUT: 'ignore',
  CQ_SANDBOX: 'off',
  CQ_SANDBOX_NETWORK: 'allow',
  CQ_RUN_TOOL: 'on',
  CQ_BUDGET_ALLOW_ADVISORY: 'false',
  CQ_BUDGET_REQUIRE_CAP: 'true',
};
// I1: argument errors exit 2; BLOCKED rows await a human-observed verdict (3).
function argError(message) {
  process.stderr.write(`adversarial-suite: ${message}\n`);
  process.exit(2);
}
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (!match) argError(`Unsupported argument: ${arg}`);
    return [match[1], match[2]];
  }),
);
const unknownFlags = Object.keys(args).filter((flag) => !SUPPORTED_FLAGS.includes(flag));
if (unknownFlags.length) {
  argError(
    `Unsupported option: --${unknownFlags.join(', --')} (supported: --repo, --profile, --rows)`,
  );
}
const profile = args.profile;
if (profile !== 'blank' && profile !== 'solo-maintainer') {
  argError('--profile must be blank or solo-maintainer');
}
if (args.repo !== SCRATCH_REPO) {
  argError(`Refusing target other than ${SCRATCH_REPO}`);
}
const rows = args.rows
  ? args.rows
      .split(',')
      .map((row) => row.trim())
      .filter(Boolean)
  : READY;
if (rows.length === 0 || rows.some((row) => !READY.includes(row) && !(row in DEPENDENT))) {
  argError('Unknown or unsupported adversarial row');
}

const output = resolve(`artifacts/adversarial-suite/evidence-${profile}.json`);
const evidence = {
  schemaVersion: 1,
  target: SCRATCH_REPO,
  profile,
  profileVerified: false,
  expected: EXPECTED,
  workflowRun: {
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    url:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
  },
  startedAt: new Date().toISOString(),
  rows: [],
};

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await mkdir(resolve('artifacts/adversarial-suite'), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

function blocked(id, reason, extra = {}) {
  return {
    id,
    status: 'BLOCKED',
    attackExecuted: false,
    expectedOutcome: EXPECTED,
    observedOutcome: null,
    reason,
    ...extra,
  };
}

async function github(path, token, { method = 'GET', body, allow404 = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cq-toolkit-adversarial-suite',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (allow404 && response.status === 404) return null;
  if (!response.ok) {
    const message = typeof data.message === 'string' ? data.message : response.statusText;
    throw new Error(`GitHub API ${method} ${path}: ${response.status} ${message}`);
  }
  return data;
}

async function repositoryVariables(token) {
  const path = `/repos/${SCRATCH_REPO}/actions/variables?per_page=100`;
  const result = await github(path, token);
  if (!Number.isSafeInteger(result.total_count) || !Array.isArray(result.variables)) {
    throw new Error('Repository variable list response is incomplete');
  }
  if (result.total_count !== result.variables.length) {
    throw new Error('Repository variable list exceeds one page; refusing incomplete readback');
  }
  const variables = new Map();
  for (const item of result.variables) {
    if (typeof item.name !== 'string' || typeof item.value !== 'string') {
      throw new Error('Repository variable list has a malformed entry');
    }
    variables.set(item.name, item);
  }
  return variables;
}

async function verifyEnvironmentOverrides(token) {
  const result = await github(`/repos/${SCRATCH_REPO}/environments?per_page=100`, token);
  if (
    !Number.isSafeInteger(result.total_count) ||
    !Array.isArray(result.environments) ||
    result.total_count !== result.environments.length
  ) {
    throw new Error('Scratch environment list is incomplete');
  }
  const observed = [];
  evidence.profileSettings.environments = observed;
  for (const environment of result.environments) {
    if (typeof environment.name !== 'string') throw new Error('Malformed scratch environment');
    const path = `/repos/${SCRATCH_REPO}/environments/${encodeURIComponent(environment.name)}/variables?per_page=100`;
    const variables = await github(path, token);
    if (
      !Number.isSafeInteger(variables.total_count) ||
      !Array.isArray(variables.variables) ||
      variables.total_count !== variables.variables.length
    ) {
      throw new Error(`Scratch environment variable list is incomplete: ${environment.name}`);
    }
    const keys = variables.variables
      .map((item) => item.name)
      .filter(
        (name) =>
          typeof name === 'string' && name.startsWith('CQ_') && !OPERATIONAL_KEYS.includes(name),
      );
    observed.push({ name: environment.name, cqVariables: keys });
    if (keys.length)
      throw new Error(
        `Scratch environment ${environment.name} has shadowing CQ variables: ${keys.join(', ')}`,
      );
  }
}

async function configureProfile(token) {
  const expected = profile === 'blank' ? {} : SOLO_PROFILE;
  evidence.profileSettings = {
    api: 'repository Actions variables',
    expected,
    absentKeys: PROFILE_KEYS.filter((key) => !(key in expected)),
    before: null,
    observed: null,
  };
  if (!token)
    throw new Error('CQ_ADVERSARIAL_PROFILE_TOKEN with scratch Variables read/write is required');
  const path = `/repos/${SCRATCH_REPO}/actions/variables`;
  const before = await repositoryVariables(token);
  evidence.profileSettings.before = Object.fromEntries(
    PROFILE_KEYS.map((key) => [key, before.get(key)?.value ?? null]),
  );
  const unsupported = [...before.keys()].filter(
    (key) =>
      key.startsWith('CQ_') && !PROFILE_KEYS.includes(key) && !OPERATIONAL_KEYS.includes(key),
  );
  evidence.profileSettings.preservedOperationalKeys = [...before.keys()].filter((key) =>
    OPERATIONAL_KEYS.includes(key),
  );
  if (unsupported.length) {
    throw new Error(`Unmodeled scratch CQ variables require review: ${unsupported.join(', ')}`);
  }
  await verifyEnvironmentOverrides(token);
  for (const key of PROFILE_KEYS) {
    const present = before.has(key);
    const value = expected[key];
    if (value === undefined && present) {
      await github(`${path}/${key}`, token, { method: 'DELETE' });
    } else if (value !== undefined && !present) {
      await github(path, token, { method: 'POST', body: { name: key, value } });
    } else if (value !== undefined && before.get(key).value !== value) {
      await github(`${path}/${key}`, token, { method: 'PATCH', body: { name: key, value } });
    }
  }
  const after = await repositoryVariables(token);
  evidence.profileSettings.observed = Object.fromEntries(
    PROFILE_KEYS.map((key) => {
      const item = after.get(key);
      return [
        key,
        item ? { value: item.value, createdAt: item.created_at, updatedAt: item.updated_at } : null,
      ];
    }),
  );
  for (const key of PROFILE_KEYS) {
    if ((after.get(key)?.value ?? undefined) !== expected[key]) {
      throw new Error(`Scratch profile readback mismatch for ${key}`);
    }
  }
  await verifyEnvironmentOverrides(token);
  evidence.profileVerified = true;
}

async function identity(token) {
  const user = await github('/user', token);
  return { id: user.id, login: user.login, type: user.type };
}

async function verifyOutsider(primaryToken, variablesToken, primary, outsider, repo) {
  // The repository owner must perform this check: a 404 from a token without
  // administration rights could conceal a collaborator from the caller.
  if (repo.owner?.id !== primary.id || repo.owner?.type !== 'User' || !repo.permissions?.admin) {
    throw new Error('Primary identity must be the verified scratch repository owner and admin');
  }
  if (outsider.type !== 'User' || !/^[A-Za-z0-9-]+$/.test(outsider.login ?? '')) {
    throw new Error('Second identity must be a verified GitHub user');
  }
  const collaborator = await github(
    `/repos/${SCRATCH_REPO}/collaborators/${outsider.login}`,
    primaryToken,
    { allow404: true },
  );
  if (collaborator !== null) {
    throw new Error('Second identity is a scratch repository collaborator');
  }
  // Trust variables are read with the Variables-scoped credential: a token
  // without that permission could get a concealed 404 that reads as "absent".
  if (!variablesToken) {
    throw new Error('CQ_ADVERSARIAL_PROFILE_TOKEN with scratch Variables read is required');
  }
  const trustedBotsVariable = await github(
    `/repos/${SCRATCH_REPO}/actions/variables/CQ_MERGE_TRUSTED_BOTS`,
    variablesToken,
    { allow404: true },
  );
  const trustedBots = (trustedBotsVariable?.value ?? '')
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  if (trustedBots.includes(outsider.login.toLowerCase())) {
    throw new Error('Second identity is included in the scratch trust set');
  }
  const associationsVariable = await github(
    `/repos/${SCRATCH_REPO}/actions/variables/CQ_MERGE_TRUSTED_ASSOCIATIONS`,
    variablesToken,
    { allow404: true },
  );
  const configuredAssociations = (associationsVariable?.value ?? '')
    .split(',')
    .map((association) => association.trim().toUpperCase())
    .filter(Boolean);
  const trustedAssociations = configuredAssociations.length
    ? configuredAssociations
    : ['OWNER', 'MEMBER', 'COLLABORATOR'];
  if (
    trustedAssociations.some(
      (association) => !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association),
    )
  ) {
    throw new Error('Scratch trusted association configuration is unsupported');
  }
  return {
    actorAssociation: 'outside OWNER/MEMBER/COLLABORATOR',
    associationEvidence:
      'owner-admin collaborator lookup returned 404 on personal repository; owner ID differs',
    trustedAssociations,
    trustedBots,
  };
}

async function preflight() {
  const first = process.env.GH_TOKEN;
  const second = process.env.CQ_ADVERSARIAL_SECOND_TOKEN;
  if (!first || !second) {
    return {
      reason:
        'Missing GH_TOKEN (CQ_ADVERSARIAL_TOKEN) or CQ_ADVERSARIAL_SECOND_TOKEN in adversarial-scratch environment',
    };
  }
  const profileToken = process.env.CQ_ADVERSARIAL_PROFILE_TOKEN;
  if (first === second) return { reason: 'First and second test identity tokens are identical' };
  let primary;
  let outsider;
  try {
    [primary, outsider] = await Promise.all([identity(first), identity(second)]);
  } catch (error) {
    return { reason: `Could not verify both token identities: ${String(error)}` };
  }
  if (
    !Number.isInteger(primary.id) ||
    !Number.isInteger(outsider.id) ||
    primary.id === outsider.id
  ) {
    return { reason: 'Two distinct authenticated GitHub user IDs are required' };
  }
  evidence.identities = { primary, outsider };
  let repo;
  try {
    repo = await github(`/repos/${SCRATCH_REPO}`, first);
    if (repo.full_name?.toLowerCase() !== SCRATCH_REPO || repo.archived || repo.disabled) {
      return { reason: 'Scratch repository identity/state failed verification' };
    }
    evidence.repositoryId = repo.id;
    evidence.defaultBranch = repo.default_branch;
    evidence.outsiderTrust = await verifyOutsider(first, profileToken, primary, outsider, repo);
  } catch (error) {
    return { reason: `Scratch repository or outsider trust preflight failed: ${String(error)}` };
  }
  try {
    await configureProfile(profileToken);
    evidence.outsiderTrust = await verifyOutsider(first, profileToken, primary, outsider, repo);
  } catch (error) {
    return { reason: `Scratch ${profile} profile setup/readback failed: ${String(error)}` };
  }
  return { first, second, primary, outsider };
}

async function fixturePr(context) {
  const number = Number(process.env.CQ_ADVERSARIAL_PR);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(
      'CQ_ADVERSARIAL_PR must identify a disposable open PR in the scratch repository',
    );
  }
  const pr = await github(`/repos/${SCRATCH_REPO}/pulls/${number}`, context.first);
  if (
    pr.state !== 'open' ||
    pr.base?.repo?.id !== evidence.repositoryId ||
    pr.head?.repo?.id !== evidence.repositoryId
  ) {
    throw new Error(
      'Fixture PR must be open with both head and base in the verified scratch repository',
    );
  }
  if (pr.base?.ref !== evidence.defaultBranch) {
    throw new Error('Fixture PR base must be the scratch repository policy-bearing default branch');
  }
  if (!pr.head.ref.startsWith('adversarial/')) {
    throw new Error('Fixture PR head must use adversarial/ branch prefix');
  }
  if (pr.user?.id === context.outsider.id) {
    throw new Error('Second identity cannot review its own fixture PR');
  }
  return { number, headSha: pr.head.sha, baseRef: pr.base.ref, url: pr.html_url };
}

// A live mutation alone is insufficient to judge policy. These attacks stay
// BLOCKED until a trusted, head-bound policy/merge-gate observation is wired in.
async function outsiderReview(id, context) {
  let pr;
  try {
    pr = await fixturePr(context);
  } catch (error) {
    return blocked(id, String(error));
  }
  const body =
    id === 'A15'
      ? // The automation-governed skip marker (the permanent A15 regression's
        // body), carrying a real objection; the review-loop's own
        // `<!-- cq-review-loop:` signature is skipped for every actor.
        `CodeRabbit skipped this run.\nPlease fix the authorization bug ${new Date().toISOString()}`
      : `LGTM — adversarial untrusted approval probe ${new Date().toISOString()}`;
  try {
    const review = await github(
      `/repos/${SCRATCH_REPO}/pulls/${pr.number}/reviews`,
      context.second,
      {
        method: 'POST',
        body: { body, event: id === 'A1' ? 'APPROVE' : 'COMMENT', commit_id: pr.headSha },
      },
    );
    if (
      !Number.isSafeInteger(review.id) ||
      review.id <= 0 ||
      review.user?.id !== context.outsider.id ||
      review.commit_id !== pr.headSha
    ) {
      return blocked(id, 'Review response did not prove submission by the verified outsider');
    }
    return blocked(
      id,
      'Attack submitted; policy rejection and eligibility have not yet been independently observed',
      {
        attackExecuted: true,
        attack: {
          kind: 'second-identity-review',
          reviewId: review.id,
          reviewUrl: review.html_url,
          prUrl: pr.url,
          headSha: pr.headSha,
          baseRef: pr.baseRef,
          actorId: context.outsider.id,
        },
      },
    );
  } catch (error) {
    return blocked(id, `Attack API request failed: ${String(error)}`, {
      attempted: true,
      prUrl: pr.url,
      headSha: pr.headSha,
    });
  }
}

const context = await preflight();
for (const id of rows) {
  let result;
  if (id in DEPENDENT) {
    result = blocked(id, `Prerequisite incomplete: ${DEPENDENT[id]}`);
  } else if ('reason' in context) {
    result = blocked(id, context.reason);
  } else if (id === 'A1' || id === 'A15') {
    result = await outsiderReview(id, context);
  } else {
    result = blocked(
      id,
      'Live scratch mutation and independent policy verdict probe are not implemented for this row',
    );
  }
  evidence.rows.push(result);
  await save();
}
process.stdout.write(
  `${JSON.stringify({
    evidence: output,
    rows: evidence.rows.map(({ id, status }) => ({ id, status })),
  })}\n`,
);
if (evidence.rows.some((row) => row.status !== 'PASS')) process.exitCode = 3;
