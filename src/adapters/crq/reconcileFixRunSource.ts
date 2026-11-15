/** Inactive file/git/gh binding of the four per-run reconcile seams
 * (`proveMerge`, `recheckRevalidation`, `markFixedOutcome`, `publishSource`).
 *
 * The seam bodies are the already-ported `reconcileMergeProof` and
 * `reconcileSourceFeedback`; this binds their injected reads and writes to the repair
 * inbox, the backfill finding ledger, the publication journal, git and `gh`. The factory is
 * per (item, run) because the seams need the record (verdict lookup) and the
 * `{itemId, run}` identity. tick.lock stays caller-owned. Imported by no entry point.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { ledgerLoads } from '../../policy/crq/ledger.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';
import { pyTruthy } from '../../policy/crq/queueDoc.js';
import type { ReconcileFixRunEffects } from '../../ops/crq/internal/reconcileFixRun.js';
import {
  proveMerge,
  recheckRevalidation,
  type MergeProofContext,
  type MergeProofEffects,
} from '../../ops/crq/internal/reconcileMergeProof.js';
import {
  markFixedOutcome,
  publishSource,
  type FixedOutcomeEffects,
  type SourcePublishEffects,
  type SourceThread,
} from '../../ops/crq/internal/reconcileSourceFeedback.js';
import {
  FindingInbox,
  type FindingPublication,
} from '../../ops/review/internal/crq/findingInbox.js';
import { ghJson, ghNameOk, makeGhRunner, slurpedComments, type GhFn } from '../forge-github/gh.js';
import { atomicWrite } from './atomic.js';
import { fileArtifactStore, fileFindingInbox, fileFindingPublication } from './findingStore.js';
import type { RunGit } from './ledgerGit.js';
import { runGitIn } from './publishSource.js';
import { parseBackfillRollout } from './repairPreparation.js';

export type FixRunSeams = Pick<
  ReconcileFixRunEffects,
  'proveMerge' | 'recheckRevalidation' | 'markFixedOutcome' | 'publishSource'
>;

/** `CONFIG['repair'].get('max_finding_retries', 2)`. */
export const DEFAULT_MAX_FINDING_RETRIES = 2;

export interface FixRunSeamsOptions {
  readonly stateRoot: string;
  readonly clone: string;
  readonly repo: string;
  /** The reconcile pass's budgeted `gh pr view`. */
  readonly prInfo: (number: JsonValue) => Promise<JsonObject>;
  readonly gh?: GhFn;
  readonly runGit?: RunGit;
  readonly now?: () => Date;
  /** `CONFIG['repair'].get('max_finding_retries', 2)`. */
  readonly maxFindingRetries?: () => number;
}

const SHA = /^[0-9a-f]{40}$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const jobName = (id: string): string => {
  if (!JOB.test(id) || id.includes('..')) throw new Error('invalid repair job id');
  return id;
};
const text = new TextDecoder('utf-8', { fatal: true });
const errorCode = (error: unknown): string | undefined =>
  error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
/** `str(x)` of a PR number or finding number as it reaches an argv or a REST path. */
function digits(value: JsonValue | undefined, label: string): string {
  const out =
    typeof value === 'string'
      ? value
      : value instanceof JsonNumber && value.kind === 'int' && value.integer !== null
        ? value.integer.toString()
        : '';
  if (!/^[1-9][0-9]{0,15}$/.test(out)) throw new Error(`invalid ${label}`);
  return out;
}
const obj = (value: JsonValue | undefined): JsonObject =>
  value instanceof JsonObject ? value : new JsonObject([]);
const plain = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The comment `source_thread`/`rest_source_thread` match on, or null for no identity. */
function sourceComment(
  job: JsonObject,
): { path: string; prefix: string; run: string; pr: string } | null {
  const source = obj(job.get('source'));
  const number = source.get('finding_number');
  if (!pyTruthy(number) || !pyTruthy(job.get('pr'))) return null;
  const finding = obj(job.get('finding'));
  const path = finding.get('path');
  if (typeof path !== 'string') throw new Error('source finding path missing');
  const run = source.get('run') ?? job.get('run');
  if (typeof run !== 'string') throw new Error('source run missing');
  return {
    path,
    prefix: `**crq finding F${digits(number, 'finding number')} [`,
    run: `<sub>crq run \`${run}\``,
    pr: digits(job.get('pr'), 'source PR'),
  };
}
const matches = (
  comment: unknown,
  want: { path: string; prefix: string; run: string },
): boolean => {
  const c = plain(comment);
  if (c === undefined) return false;
  const body = str(c['body']);
  return c['path'] === want.path && body.startsWith(want.prefix) && body.includes(want.run);
};

const RESOLVE_MUTATION =
  'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}';
const THREAD_QUERY =
  'query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){' +
  'repository(owner:$owner,name:$repo){pullRequest(number:$pr){' +
  'reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}' +
  'nodes{id comments(first:1){nodes{body path}}}}}}}';

export function fileFixRunSeams(
  options: FixRunSeamsOptions,
): (item: JsonObject, run: string) => FixRunSeams {
  const [owner, repoName, ...extra] = options.repo.split('/');
  if (!owner || !repoName || extra.length || !ghNameOk(owner) || !ghNameOk(repoName))
    throw new Error('invalid repo');
  const git = options.runGit ?? runGitIn(options.clone);
  const gh = options.gh ?? makeGhRunner();
  const now = options.now ?? (() => new Date());
  const repairDir = join(options.stateRoot, 'repair');
  const findingsRoot = join(options.stateRoot, 'backfill', 'findings');
  const files = fileFindingInbox(findingsRoot);
  const journalDir = (first: string): string => join(repairDir, jobName(first));

  const readJob = async (id: string): Promise<JsonObject> => {
    const value = parseJsonValue(
      text.decode(await readFile(join(repairDir, 'inbox', `${jobName(id)}.json`))),
      { duplicates: 'last' },
    );
    if (!(value instanceof JsonObject)) throw new Error('repair job is not an object');
    return value;
  };
  /** `finding_inbox`: needs the durable artifact root from the rollout file, lazily. */
  const publication: FindingPublication = {
    async retained() {
      return (await store()).retained();
    },
    async spool(value) {
      return (await store()).spool(value);
    },
  };
  async function store(): Promise<FindingPublication> {
    let raw: string;
    try {
      raw = text.decode(await readFile(join(options.stateRoot, 'backfill-rollout.json')));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      raw = '';
    }
    const rollout = parseBackfillRollout(raw);
    if (!rollout.ok)
      throw new Error('backfill repair write-back requires existing ledger configuration');
    return fileFindingPublication({
      root: join(options.stateRoot, 'backfill', 'publication'),
      artifacts: fileArtifactStore(rollout.durableArtifactRoot),
    });
  }
  const readTriage = async (id: string): Promise<JsonObject | null> => {
    const bytes = await files.readTriage(id);
    if (bytes === null) return null;
    const row = ledgerLoads(bytes);
    if (!(row instanceof JsonObject)) throw new Error('finding row unreadable');
    return row;
  };
  const resolveRef = async (ref: string): Promise<string> => {
    const call = await git(['rev-parse', ref]);
    if (call.code !== 0) throw new Error('target ref unavailable');
    const value = text.decode(call.stdout).trim();
    if (!SHA.test(value)) throw new Error('invalid target ref');
    return value;
  };
  const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> => {
    if (!SHA.test(ancestor) || !SHA.test(descendant)) throw new Error('invalid ancestry operand');
    return (await git(['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
  };
  /** `crq.ensure_commit`: merged heads may be gone from branch refs; fetch the PR ref. */
  const ensureCommit = async (number: JsonValue, sha: string): Promise<boolean> => {
    if (!SHA.test(sha)) throw new Error('invalid commit');
    const have = async (): Promise<boolean> =>
      (await git(['cat-file', '-e', `${sha}^{commit}`])).code === 0;
    if (await have()) return true;
    const pr = digits(number, 'repair PR number');
    await git(['fetch', '--quiet', 'origin', `+refs/pull/${pr}/head:refs/remotes/pr/${pr}`]);
    return have();
  };

  const proofEffects: MergeProofEffects = {
    canonical: {
      readJob,
      async triageExists(id) {
        if (!/^[0-9a-f]{64}$/.test(id)) return false;
        try {
          await stat(join(findingsRoot, 'triage', `${id}.json`));
          return true;
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return false;
          throw error;
        }
      },
      currentFixedEvent: (job, merge) =>
        new FindingInbox(files).currentFixedEvent(publication, job, merge ?? ''),
      isAncestor,
    },
    evidence: {
      git,
      readJob,
      readTriage,
      resolveTarget: () => resolveRef('origin/main'),
      ensureCommit,
    },
    git,
    async readSavedJournal(first) {
      try {
        const value = parseJsonValue(
          text.decode(await readFile(join(journalDir(first), 'publication.json'))),
          { duplicates: 'last' },
        );
        if (!(value instanceof JsonObject)) throw new Error('publication journal is not an object');
        return value;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    prInfo: options.prInfo,
  };

  const outcomeEffects: FixedOutcomeEffects = {
    files,
    publication,
    readJob,
    maxFindingRetries: options.maxFindingRetries ?? (() => DEFAULT_MAX_FINDING_RETRIES),
    now: () => `${now().toISOString().slice(0, 19)}Z`,
  };

  const pages = async (args: string[], path: string): Promise<unknown[][]> =>
    slurpedComments(await ghJson<unknown>(gh, [...args, '--paginate', '--slurp']), path);

  const feedbackEffects: SourcePublishEffects = {
    ...proofEffects,
    readJob,
    async writeJournal(first, value) {
      await mkdir(journalDir(first), { recursive: true });
      await atomicWrite(
        join(journalDir(first), 'publication.json'),
        pythonJsonText(value, {
          asciiOnly: true,
          sortKeys: false,
          keyOrder: 'insertion',
          indent: 2,
          trailingNewline: true,
        }),
      );
    },
    async hasSourceComment(pr, marker) {
      const path = `repos/${options.repo}/issues/${digits(pr, 'source PR')}/comments`;
      return (await pages(['api', path], path)).some((page) =>
        page.some((comment) => str(plain(comment)?.['body']).includes(marker)),
      );
    },
    async postSourceComment(first, id, pr, marker, merge) {
      if (!SHA.test(merge)) throw new Error('invalid merge commit');
      const dir = journalDir(first);
      await mkdir(dir, { recursive: true });
      const body = join(dir, `source-${jobName(id)}.md`);
      await writeFile(
        body,
        `${marker}\nFixed in [${merge}](https://github.com/${options.repo}/commit/${merge}).\n`,
      );
      const call = await gh([
        'pr',
        'comment',
        digits(pr, 'source PR'),
        '--repo',
        options.repo,
        '--body-file',
        body,
      ]);
      if (call.code !== 0) throw new Error('source comment failed');
    },
    async sourceThread(job): Promise<SourceThread> {
      const source = obj(job.get('source'));
      const explicit = [
        job.get('source_thread_id'),
        job.get('thread_id'),
        source.get('source_thread_id'),
        source.get('thread_id'),
        obj(job.get('finding')).get('thread_id'),
      ].find((v) => pyTruthy(v));
      if (explicit !== undefined) {
        if (typeof explicit !== 'string') throw new Error('source thread id must be a string');
        return { kind: 'found', id: explicit };
      }
      const want = sourceComment(job);
      if (want === null) return { kind: 'none' };
      const found = new Set<string>();
      const graph = await ghJson<unknown>(gh, [
        'api',
        'graphql',
        '--paginate',
        '--slurp',
        '-f',
        `query=${THREAD_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `repo=${repoName}`,
        '-F',
        `pr=${want.pr}`,
      ]);
      for (const page of list(graph)) {
        const p = plain(page);
        if (p === undefined || truthy(p['errors'])) throw new Error('source thread lookup failed');
        const threads = plain(
          plain(plain(plain(p['data'])?.['repository'])?.['pullRequest'])?.['reviewThreads'],
        );
        for (const thread of list(threads?.['nodes'])) {
          const t = plain(thread);
          for (const comment of list(plain(t?.['comments'])?.['nodes']))
            if (matches(comment, want)) found.add(str(t?.['id']));
        }
      }
      if (found.size > 1) throw new Error('ambiguous source thread; retain publication for retry');
      const [id] = found;
      if (id !== undefined) return { kind: 'found', id };
      // GraphQL reviewThreads lag REST: a REST-visible comment keeps feedback pending.
      const path = `repos/${options.repo}/pulls/${want.pr}/comments`;
      const rest = await pages(['api', path], path);
      return rest.some((page) => page.some((comment) => matches(comment, want)))
        ? { kind: 'pending' }
        : { kind: 'none' };
    },
    async resolveSourceThread(first, id, threadId) {
      const dir = journalDir(first);
      await mkdir(dir, { recursive: true });
      const request = join(dir, `resolve-${jobName(id)}.json`);
      await atomicWrite(
        request,
        pythonJsonText(
          new JsonObject([
            ['query', RESOLVE_MUTATION],
            ['variables', new JsonObject([['threadId', threadId]])],
          ]),
          {
            asciiOnly: true,
            sortKeys: false,
            keyOrder: 'insertion',
            indent: 2,
            trailingNewline: true,
          },
        ),
      );
      const response = plain(await ghJson<unknown>(gh, ['api', 'graphql', '--input', request]));
      const resolved = plain(
        plain(plain(response?.['data'])?.['resolveReviewThread'])?.['thread'],
      )?.['isResolved'];
      return !truthy(response?.['errors']) && truthy(resolved);
    },
  };

  return (item, run) => {
    const context: MergeProofContext = { itemId: str(item.get('id')), run };
    const record = (): JsonObject => {
      const found = obj(obj(item.get('repair_runs')).get(run));
      if (found.entries.length === 0) throw new Error('repair run record missing');
      return found;
    };
    return {
      proveMerge: (rec, info) => proveMerge(context, rec, info, proofEffects),
      recheckRevalidation: (rec, _info, evidence) =>
        recheckRevalidation(context, rec, evidence, proofEffects),
      markFixedOutcome: (job, merge, prUrl, proof) =>
        markFixedOutcome(record(), job, merge, prUrl, proof, outcomeEffects),
      publishSource: (rec, info, proof, merge) =>
        publishSource(context, rec, info, proof, merge, feedbackEffects),
    };
  };
}

/** Python truthiness of a parsed JSON value. */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  const p = plain(value);
  return p === undefined || Object.keys(p).length > 0;
}
