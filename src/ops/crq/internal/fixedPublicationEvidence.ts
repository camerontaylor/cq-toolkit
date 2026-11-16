/** Reobserve the semantic facts bound to a legacy fixed revalidation. */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../../policy/crq/ledger.js';
import { findingDigest, sourcePath } from '../../../policy/crq/repairBinding.js';
import type { RunGit } from '../../../adapters/crq/ledgerGit.js';

export interface FixedEvidenceInput {
  readonly jobId: string;
  readonly itemId: string;
  readonly run: string;
  readonly number: JsonValue;
  readonly published: string;
  readonly actual: string;
  readonly merge: string;
  readonly commits: readonly string[];
  readonly pr: JsonObject;
  readonly evidence: JsonValue;
}
export interface FixedEvidenceEffects {
  readonly git: RunGit;
  readJob(id: string): Promise<JsonObject>;
  readTriage(id: string): Promise<JsonObject | null>;
  resolveTarget(): Promise<string>;
  ensureCommit(number: JsonValue, head: string): Promise<boolean>;
}
const sha = /^[0-9a-f]{40}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const testPath = (path: string): boolean =>
  /^(?:test\/.*\.test\.(?:ts|mjs)|lint\/.*\.test\.ts)$/.test(path);

export async function validateFixedPublicationEvidence(
  input: FixedEvidenceInput,
  effects: FixedEvidenceEffects,
): Promise<void> {
  const job = await effects.readJob(input.jobId);
  if (
    job.get('job') !== input.jobId ||
    job.get('item') !== input.itemId ||
    job.get('run') !== input.run
  )
    throw new Error('legacy repair job identity mismatch');
  const finding = job.get('finding');
  if (finding === undefined) throw new Error('repair finding missing');
  const path = sourcePath(finding);
  if (!path.ok) throw new Error('invalid repair source path');
  const fid = job.get('canonical_finding_id');
  let canonical: JsonObject | null = null;
  if (fid !== undefined && fid !== null && fid !== '') {
    if (typeof fid !== 'string' || !/^[0-9a-f]{64}$/.test(fid))
      throw new Error('canonical finding id malformed');
    canonical = await effects.readTriage(fid);
    const receipt = canonical?.get('receipt');
    if (
      !(canonical instanceof JsonObject) ||
      canonical.get('canonical_id') !== fid ||
      canonical.get('status') !== 'delivered' ||
      !(receipt instanceof JsonObject) ||
      receipt.get('repair_task') !== input.jobId
    )
      throw new Error('fixed revalidation canonical finding binding changed');
  }
  const tip = await effects.resolveTarget();
  const mergeObject = input.pr.get('mergeCommit');
  if (
    input.pr.get('state') !== 'MERGED' ||
    !ledgerValueEqual(input.pr.get('number') ?? null, input.number) ||
    input.pr.get('headRefOid') !== input.actual ||
    !(mergeObject instanceof JsonObject) ||
    mergeObject.get('oid') !== input.merge ||
    ![input.published, input.actual, input.merge, tip].every((v) => sha.test(v))
  )
    throw new Error('merged repair PR identity or lineage mismatch');
  if (!(await effects.ensureCommit(input.number, input.actual)))
    throw new Error('merged repair PR head unavailable');
  const ancestor = async (a: string, b: string): Promise<boolean> =>
    (await effects.git(['merge-base', '--is-ancestor', a, b])).code === 0;
  if (!(await ancestor(input.published, input.actual)) || !(await ancestor(input.merge, tip)))
    throw new Error('merged repair PR identity or lineage mismatch');
  if (!input.commits.length || input.commits.length > 64)
    throw new Error('published repair commits unavailable');
  const paths = new Set([path.path]);
  for (const commit of input.commits) {
    if (!sha.test(commit) || !(await ancestor(commit, input.published)))
      throw new Error('published repair commit lineage unavailable');
    const result = await effects.git([
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      commit,
    ]);
    if (result.code !== 0) throw new Error('published repair paths unavailable');
    for (const candidate of utf8.decode(result.stdout).split('\0'))
      if (candidate && !testPath(candidate)) paths.add(candidate);
  }
  if (paths.size > 128) throw new Error('published repair paths exceed bound');
  const sourceEntry = async (head: string, name: string): Promise<JsonValue> => {
    const valid = sourcePath(new JsonObject([['path', name]]));
    if (!valid.ok || valid.path !== name) throw new Error('invalid repair source path');
    const result = await effects.git(['ls-tree', '-z', head, '--', name]);
    if (result.code !== 0) throw new Error('repair source unavailable');
    const raw = utf8.decode(result.stdout);
    if (!raw) return null;
    const match = /^(\d+) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(raw);
    if (!match || match[3] !== name) throw new Error('repair source is not an exact blob path');
    return [match[1]!, match[2]!];
  };
  const sources: [string, JsonValue][] = [];
  for (const name of [...paths].sort())
    sources.push([
      name,
      new JsonObject([
        ['published', await sourceEntry(input.published, name)],
        ['actual', await sourceEntry(input.actual, name)],
        ['current', await sourceEntry(tip, name)],
      ]),
    ]);
  const expected: [string, JsonValue][] = [
    ['job', input.jobId],
    ['item', input.itemId],
    ['run', input.run],
    ['finding_sha256', findingDigest(finding)],
    ['pr', input.number],
    ['published_head', input.published],
    ['actual_head', input.actual],
    ['merge_commit', input.merge],
    ['source_sha', tip],
    ['sources', new JsonObject(sources)],
    ['verdict', 'fixed'],
  ];
  if (canonical !== null)
    expected.push(['canonical_finding_id', fid!], ['canonical_status', 'delivered']);
  if (
    !(input.evidence instanceof JsonObject) ||
    expected.some(
      ([key, value]) =>
        !ledgerValueEqual(
          input.evidence instanceof JsonObject ? (input.evidence.get(key) ?? null) : null,
          value,
        ),
    )
  )
    throw new Error('fixed revalidation binding changed');
  const reviewer = input.evidence.get('reviewer'),
    reason = input.evidence.get('reason');
  if (
    [reviewer, reason].some(
      (v) => typeof v !== 'string' || !v.trim() || Array.from(v).length > 4000,
    )
  )
    throw new Error('named revalidation reviewer and concrete reason required');
  if (canonical !== null && (typeof reason !== 'string' || !reason.startsWith('revalidated:')))
    throw new Error('canonical fixed revalidation reason must start with revalidated:');
}
