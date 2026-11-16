import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { pythonValueEqual, pyTruthy } from '../../../policy/crq/queueDoc.js';
import { equivalentIdentityInputs } from '../../../policy/crq/reviewAdmission.js';

/** Host bindings for pinned facts and historical PR-cycle evidence. Caller holds tick.lock. */
export interface LocalReviewPrepareEffects {
  ensureObjects(repo: string, base: string, head: string): Promise<void>;
  resolveFacts(repo: string, base: string, head: string, profile: JsonObject): Promise<JsonObject>;
  validateIdentity(identity: JsonObject): void;
  readRunMeta(runId: string): Promise<JsonObject>;
  classifyCompleted(runId: string, ndjson: string): Promise<JsonObject>;
  completeFromCycle(
    queue: JsonObject,
    runId: string,
    classification: JsonObject,
    endedAt: string,
  ): Promise<JsonObject>;
  nowIso(): string;
}
export class LocalReviewNotReady extends Error {
  override readonly name = 'LocalReviewNotReady';
}
function obj(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('expected object');
  return value;
}
function text(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new Error('expected string');
  return value;
}
function array(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** Reuse a completed PR cycle, refuse an equivalent in-flight run, or return a pinned plan. */
export async function prepareLocalReview(
  queue: JsonObject,
  item: JsonObject,
  runnerRepo: string,
  dry: boolean,
  completedOnly: boolean,
  effects: LocalReviewPrepareEffects,
): Promise<{ queue: JsonObject; plan: JsonObject | null }> {
  const wanted = obj(item.get('identity_inputs'));
  const repo = text(wanted.get('repo'));
  const base = text(wanted.get('base_commit'));
  const head = text(wanted.get('head_commit'));
  const profile = obj(item.get('profile'));
  if (repo.toLowerCase() !== runnerRepo.toLowerCase())
    await effects.ensureObjects(repo, base, head);
  try {
    effects.validateIdentity(wanted);
  } catch {
    throw new LocalReviewNotReady('pinned-local-review-facts-mismatch');
  }
  if (!pythonValueEqual(await effects.resolveFacts(repo, base, head, profile), wanted))
    throw new LocalReviewNotReady('pinned-local-review-facts-mismatch');
  const generation = item.get('generation');
  const repeat = item.has('repeat_requested')
    ? pyTruthy(item.get('repeat_requested'))
    : generation instanceof JsonNumber && generation.integer !== null && generation.integer > 1n;
  async function matches(record: JsonObject, pr: JsonObject): Promise<boolean> {
    if (
      record.get('range_policy') !== 'full-range-once-v1' ||
      !(record.get('profile') instanceof JsonObject) ||
      !pyTruthy(record.get('profile'))
    )
      return false;
    const resolved = await effects.resolveFacts(
      text(pr.get('repo') ?? runnerRepo),
      text(record.get('base')),
      text(record.get('head')),
      obj(record.get('profile')),
    );
    try {
      effects.validateIdentity(resolved);
      return equivalentIdentityInputs(resolved, wanted);
    } catch {
      return false;
    }
  }
  for (const value of array(queue.get('items'))) {
    if (
      !(value instanceof JsonObject) ||
      !['open', 'delta'].includes(String(value.get('kind'))) ||
      (value.get('repo') ?? runnerRepo) !== repo
    )
      continue;
    for (const candidate of [...array(value.get('cycles'))].reverse()) {
      if (
        !(candidate instanceof JsonObject) ||
        repeat ||
        candidate.get('base') !== base ||
        candidate.get('head') !== head ||
        !(await matches(candidate, value))
      )
        continue;
      if (!dry) {
        const runId = text(candidate.get('run_id'));
        const cls = await effects.classifyCompleted(runId, text(candidate.get('ndjson')));
        if (cls.get('counted') !== true || cls.get('outcome') !== 'completed') continue;
        const completedQueue = await effects.completeFromCycle(
          queue,
          runId,
          cls,
          typeof candidate.get('completed_at') === 'string' &&
            pyTruthy(candidate.get('completed_at'))
            ? text(candidate.get('completed_at'))
            : effects.nowIso(),
        );
        return { queue: completedQueue, plan: null };
      }
      return { queue, plan: null };
    }
    const run = completedOnly ? null : value.get('run');
    if (run instanceof JsonObject && pyTruthy(run)) {
      const meta = await effects.readRunMeta(text(run.get('run_id')));
      if (meta.get('base') === base && meta.get('head') === head && (await matches(meta, value)))
        throw new LocalReviewNotReady('equivalent-pr-review');
    }
  }
  return {
    queue,
    plan: new JsonObject([
      ['base', base],
      ['head', head],
      ['target', base],
      ['label', 'local full-diff review'],
      ['cycle', item.get('generation') ?? JsonNumber.int(1)],
      ['branch', null],
      ['notes', []],
      ['review_pin', base],
      ['range_policy', 'full-range-once-v1'],
      ['profile', profile],
      ['config_digest', wanted.get('config_digest') ?? null],
    ]),
  };
}
