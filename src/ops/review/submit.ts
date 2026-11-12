import { reviewNotifyDestination } from '../../config/review-notify.js';
import { SubmitInputSchema } from './internal/reviewOperation.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { git, headMessage, reviewOp, evidenceRoot } from './internal/localReview.js';
import { WireSchema, SnapshotSchema } from './internal/reviewOperation.js';
import { captureSnapshot, SnapshotConfigError } from '../dev/internal/snapshot.js';
import { observeReview } from './wait.js';
import { QueueUnsupported, ReviewInputError } from './internal/queueClient.js';
import type { QueueTransport } from './internal/queueProtocol.js';
import { currentCqEnv } from '../../config/run-env.js';

/**
 * An explicit `scanner` input always wins (even an invalid one, which then fails
 * closed). Only when it is absent does the operator's documented
 * CQ_AUTHOR_SNAPSHOT_SCANNER apply. Validation stays in captureSnapshot: a
 * missing, relative or unexecutable value is a configuration error, never a skip.
 */
function snapshotScanner(explicit: string | undefined): string | undefined {
  if (explicit !== undefined) return explicit;
  const configured = currentCqEnv().values['CQ_AUTHOR_SNAPSHOT_SCANNER'];
  return typeof configured === 'string' ? configured : undefined;
}

// Resolve shorthand deterministically instead of accepting Git's ambiguous-ref warning.
async function resolveTarget(cwd: string, target: string) {
  const refs = (await git(cwd, 'for-each-ref', '--format=%(refname)')).split('\n');
  if (target.startsWith('refs/')) return resolveCommit(cwd, target);
  const direct = refs.filter((ref) =>
    [`refs/heads/${target}`, `refs/tags/${target}`, `refs/remotes/${target}`].includes(ref),
  );
  if (direct.length > 1)
    throw new ReviewInputError('ambiguous target; use an explicit refs/ reference');
  if (direct[0]) return resolveCommit(cwd, direct[0]);
  const remote = refs.filter(
    (ref) =>
      ref.startsWith('refs/remotes/') &&
      ref.slice('refs/remotes/'.length).split('/').slice(1).join('/') === target,
  );
  if (remote.length > 1)
    throw new ReviewInputError('ambiguous remote target; use an explicit refs/remotes/ reference');
  if (remote[0] === `refs/remotes/origin/${target}`) return resolveCommit(cwd, remote[0]);
  if (remote.length)
    throw new ReviewInputError('remote target requires an explicit refs/remotes/ reference');
  return resolveCommit(cwd, target);
}
async function resolveCommit(cwd: string, ref: string) {
  return git(cwd, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}');
}
type TargetFreshness = { local: string; upstream: string; ahead: number; behind: number };
async function targetFreshness(cwd: string, target: string): Promise<TargetFreshness | undefined> {
  const localRef = target.startsWith('refs/') ? target : 'refs/heads/' + target;
  if (!localRef.startsWith('refs/heads/')) return undefined;
  try {
    const upstreamRef = (
      await git(cwd, 'for-each-ref', '--format=%(refname) %(upstream)', localRef)
    )
      .split('\n')
      .find((line) => line.startsWith(localRef + ' '))
      ?.slice(localRef.length + 1);
    if (!upstreamRef) return undefined;
    const local = await resolveCommit(cwd, localRef);
    const upstream = await resolveCommit(cwd, upstreamRef);
    if (local === upstream) return undefined;
    const counts = (await git(cwd, 'rev-list', '--left-right', '--count', local + '...' + upstream))
      .split(/\s+/)
      .map(Number);
    return { local, upstream, ahead: counts[0]!, behind: counts[1]! };
  } catch {
    // A missing upstream or unavailable divergence must never block submission.
    return undefined;
  }
}

export const makeSubmit = (transport?: QueueTransport, beforeDispatch?: () => Promise<void>) =>
  reviewOp(
    SubmitInputSchema,
    async (i, getClient) => {
      const requestId = i.requestId ?? randomUUID();
      const root = await evidenceRoot(i.cwd);
      const dir = join(root, '.cq/queue-evidence/requests');
      const path = join(dir, requestId + '.json');
      await mkdir(dir, { recursive: true });
      let saved:
        | {
            key: string;
            inputs: unknown;
            submitted_at: string;
            wire: unknown;
            snapshotPolicy?: string;
            targetFreshness?: TargetFreshness;
          }
        | undefined;
      try {
        saved = JSON.parse(await readFile(path, 'utf8')) as typeof saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const exclusions = {
        staged: await git(i.cwd, 'diff', '--cached', '--name-only'),
        unstaged: await git(i.cwd, 'diff', '--name-only'),
        untracked: await git(i.cwd, 'ls-files', '--others', '--exclude-standard'),
      };
      let wire;
      let snapshotPolicy = i.reachable ? 'reachable' : 'snapshot';
      let freshness: TargetFreshness | undefined;
      if (saved) {
        wire = WireSchema.parse(saved.wire);
        freshness = saved.targetFreshness;
        snapshotPolicy =
          saved.snapshotPolicy ?? ('snapshot' in wire && wire.snapshot ? 'snapshot' : 'reachable');
        // Required selectors must still match. Omitted optional admission fields
        // reuse the saved wire; an explicit repeat=false equals its wire default.
        if (
          wire.op !== 'submit' ||
          wire.request_id !== requestId ||
          wire.inputs.repo !== i.repo ||
          wire.inputs.target !== i.target ||
          (i.head !== undefined && wire.inputs.head_commit !== i.head) ||
          wire.inputs.projection !== i.projection ||
          (i.base !== undefined &&
            (await resolveCommit(i.cwd, i.base)) !== wire.inputs.base_commit) ||
          (i.repeat !== undefined && (wire.repeat ?? false) !== i.repeat) ||
          (i.supersedes !== undefined && wire.supersedes !== i.supersedes)
        )
          throw new Error('requestId is already bound to different inputs');
      } else {
        const head = i.head ?? (await git(i.cwd, 'rev-parse', '--verify', 'HEAD^{commit}'));
        const target = await resolveTarget(i.cwd, i.target);
        const base =
          i.base === undefined
            ? await git(i.cwd, 'merge-base', target, head)
            : await resolveCommit(i.cwd, i.base);
        if (i.base !== undefined && (await git(i.cwd, 'merge-base', base, head)) !== base)
          throw new ReviewInputError('explicit base must be an ancestor of HEAD');
        freshness = await targetFreshness(i.cwd, i.target);
        const inputs = {
          repo: i.repo,
          target: i.target,
          base_commit: base,
          head_commit: head,
          base_tree: await git(i.cwd, 'rev-parse', base + '^{tree}'),
          head_tree: await git(i.cwd, 'rev-parse', head + '^{tree}'),
          projection: i.projection,
        };
        if (inputs.base_tree === inputs.head_tree)
          return {
            v: 1,
            action: 'no-changes',
            state: 'completed',
            exclusions,
            reviewedHead: head,
            ...(freshness ? { targetFreshness: freshness } : {}),
          };
        const notify = i.notify ?? reviewNotifyDestination();
        wire = WireSchema.parse({
          v: 1,
          op: 'submit',
          ...(notify === undefined ? {} : { notify }),
          request_id: requestId,
          inputs,
          ...(i.repeat === undefined ? {} : { repeat: i.repeat }),
          ...(i.supersedes === undefined ? {} : { supersedes: i.supersedes }),
        });
        const record = {
          key: requestId,
          inputs,
          submitted_at: new Date().toISOString(),
          wire,
          snapshotPolicy,
          ...(freshness ? { targetFreshness: freshness } : {}),
        };
        try {
          await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const concurrent = JSON.parse(await readFile(path, 'utf8')) as { wire: unknown };
          if (!isDeepStrictEqual(concurrent.wire, wire))
            throw new Error('requestId is already bound to different inputs');
        }
      }
      if (wire.op !== 'submit') throw new Error('invalid saved submit');
      let mutationSent = false;
      try {
        const client = getClient();
        const capabilities = await client.capabilities();
        if (snapshotPolicy === 'snapshot' && !wire.snapshot) {
          if (!capabilities.features.includes('original-commit-snapshot-v1'))
            throw new QueueUnsupported('original-commit snapshot capability unavailable');
          const { snapshot } = await captureSnapshot(
            root,
            wire.inputs.base_commit,
            wire.inputs.head_tree,
            snapshotScanner(i.scanner),
            30000,
            wire.inputs.head_commit,
          ).catch((error: unknown) => {
            if (error instanceof SnapshotConfigError) throw error;
            throw new ReviewInputError(error instanceof Error ? error.message : String(error));
          });
          wire = { ...wire, snapshot: SnapshotSchema.parse(snapshot) };
          const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
          const prepared = join(dir, requestId + '.' + randomUUID() + '.tmp');
          await writeFile(prepared, JSON.stringify({ ...record, wire }), { mode: 0o600 });
          await rename(prepared, path);
        }
        if (wire.snapshot) {
          const decodedBytes = wire.snapshot.objects.reduce(
            (total, object) => total + Buffer.byteLength(object.data, 'base64'),
            0,
          );
          if (decodedBytes > capabilities.limits.max_content_bytes)
            throw new ReviewInputError('snapshot content exceeds bound');
          if (
            Buffer.byteLength(JSON.stringify(wire.snapshot)) >
            capabilities.limits.max_snapshot_bytes
          )
            throw new ReviewInputError('snapshot wire exceeds bound');
        }
        await beforeDispatch?.();
        mutationSent = true;
        const response = await client.request(wire);
        if (!('state' in response)) throw new Error('expected admission response');
        // The immutable request remains the recovery authority even if this cache update fails.
        const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        const updated = join(dir, requestId + '.' + randomUUID() + '.tmp');
        await writeFile(
          updated,
          JSON.stringify({
            ...record,
            response,
            ...('identity' in response ? { identity: response.identity } : {}),
          }),
          { mode: 0o600 },
        );
        await rename(updated, path);
        const result =
          i.waitMs === undefined || !['queued', 'running'].includes(response.state)
            ? response
            : await observeReview(client, requestId, i.waitMs, undefined, response);
        return {
          ...response,
          ...result,
          action: response.action,
          request_id: requestId,
          exclusions,
          reviewedHead: wire.inputs.head_commit,
          ...(freshness ? { targetFreshness: freshness } : {}),
          message: await headMessage(i.cwd, wire.inputs.head_commit),
        };
      } catch (error) {
        if (mutationSent && error instanceof Error && !(error instanceof ReviewInputError))
          error.message += `; persisted requestId=${requestId}; retry review.submit with this requestId to reconcile`;
        throw error;
      }
    },
    transport,
  );
