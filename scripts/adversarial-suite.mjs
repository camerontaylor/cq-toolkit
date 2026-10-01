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
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Unsupported argument: ${arg}`);
    return [match[1], match[2]];
  }),
);
const profile = args.profile;
if (profile !== 'blank' && profile !== 'solo-maintainer') {
  throw new Error('--profile must be blank or solo-maintainer');
}
if (args.repo !== SCRATCH_REPO) {
  throw new Error(`Refusing target other than ${SCRATCH_REPO}`);
}
const rows = args.rows
  ? args.rows
      .split(',')
      .map((row) => row.trim())
      .filter(Boolean)
  : READY;
if (rows.length === 0 || rows.some((row) => !READY.includes(row) && !(row in DEPENDENT))) {
  throw new Error('Unknown or unsupported adversarial row');
}

const output = resolve(`artifacts/adversarial-suite/evidence-${profile}.json`);
const evidence = {
  schemaVersion: 1,
  target: SCRATCH_REPO,
  profile,
  profileVerified: false,
  expected: EXPECTED,
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

async function identity(token) {
  const user = await github('/user', token);
  return { id: user.id, login: user.login, type: user.type };
}

async function verifyOutsider(primaryToken, primary, outsider, repo) {
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
  const trustedBotsVariable = await github(
    `/repos/${SCRATCH_REPO}/actions/variables/CQ_MERGE_TRUSTED_BOTS`,
    primaryToken,
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
    primaryToken,
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
  try {
    const repo = await github(`/repos/${SCRATCH_REPO}`, first);
    if (repo.full_name?.toLowerCase() !== SCRATCH_REPO || repo.archived || repo.disabled) {
      return { reason: 'Scratch repository identity/state failed verification' };
    }
    evidence.repositoryId = repo.id;
    evidence.defaultBranch = repo.default_branch;
    evidence.outsiderTrust = await verifyOutsider(first, primary, outsider, repo);
  } catch (error) {
    return { reason: `Scratch repository inaccessible: ${String(error)}` };
  }
  // A CLI profile name is only a requested test condition. The runner does
  // not yet install and read back the scratch repository's profile variables,
  // so no live attack may be submitted under either requested profile.
  return {
    reason: `Scratch ${profile} profile setup/readback is not implemented; requested label is not proof`,
  };
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
  if (!pr.head.ref.startsWith('adversarial/')) {
    throw new Error('Fixture PR head must use adversarial/ branch prefix');
  }
  if (pr.user?.id === context.outsider.id) {
    throw new Error('Second identity cannot review its own fixture PR');
  }
  return { number, headSha: pr.head.sha, url: pr.html_url };
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
      ? `<!-- cq-review-loop: adversarial-spoof -->\nAdversarial skip-marker probe ${new Date().toISOString()}`
      : `LGTM — adversarial untrusted approval probe ${new Date().toISOString()}`;
  try {
    const review = await github(
      `/repos/${SCRATCH_REPO}/pulls/${pr.number}/reviews`,
      context.second,
      {
        method: 'POST',
        body: { body, event: id === 'A1' ? 'APPROVE' : 'COMMENT' },
      },
    );
    if (
      !Number.isSafeInteger(review.id) ||
      review.id <= 0 ||
      review.user?.id !== context.outsider.id
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
process.stdout.write(`${output}\n`);
if (evidence.rows.some((row) => row.status !== 'PASS')) process.exitCode = 2;
